import { assert, describe, it, layer } from "@effect/vitest";
import { evaluateAggregate, partMatches } from "@std/conditions/aggregate";
import { ConditionDefectError } from "@std/conditions/defect";
import type { ResolvedNode } from "@std/conditions/typed";
import { fieldAttribute } from "@std/tmf/mapping";
import type { SourceRecord } from "@std/tmf/mapping";
import { Effect, Ref } from "effect";
import { SqlClient } from "effect/sql";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { ACME } from "../../testing/src/acme-ids.ts";
import { withHistory } from "../src/http/tmf/sources.ts";
import type { Delivery } from "../src/outbox/delivery-effects.ts";
import { workerPass } from "../src/outbox/worker.ts";
import { decodeCursor, finishPage } from "../src/records/read-cursor.ts";
import { currentReadScope } from "../src/records/read-records.ts";
import { analyzeStatement } from "../src/sql/statement-lexer.ts";
import { StatementLog } from "../src/sql/statement-log.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { subscribe } from "./outbox-support.ts";
import {
  asLoadedUser,
  createAsset,
  deleteAsset,
  serveOnly,
  workerTestLayer,
} from "./worker-support.ts";

const DELIVERY_KINDS = [
  "record",
  "external",
  "rendered",
  "legacy",
  "delete",
] as const;

const FIRST = "0192f000-0000-7000-8000-000000000001";
const SECOND = "0192f000-0000-7000-8000-000000000002";
const THIRD = "0192f000-0000-7000-8000-000000000003";

const isOriginRead = (text: string): boolean =>
  text.includes('FROM core."definition_revision" AS "dr"');

const workerOrigins = Effect.fn("Quality.workerOrigins")(
  function* workerOrigins(kind: (typeof DELIVERY_KINDS)[number]) {
    const fixture = yield* AcmeFixture;

    const subscription = yield* subscribe({
      classId: ACME.asset,
      identityId: fixture.admin.id,
      operations: kind === "delete" ? ["delete"] : ["create"],
    });

    const deliveries = yield* Ref.make<readonly Delivery[]>([]);

    const collect = (delivery: Delivery) =>
      Ref.update(deliveries, (previous) => [...previous, delivery]);

    yield* serveOnly(
      subscription,
      kind === "rendered"
        ? {
            kind: "external",
            render: (_delivery, context) => [{ origins: context.origins.size }],
            run: collect,
          }
        : {
            kind: kind === "record" ? "record" : "external",
            run: collect,
          }
    );

    const recordId = yield* createAsset(fixture.admin.id, {
      name: `quality ${kind}`,
      status: "in_use",
    });

    if (kind === "legacy") {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM core.change_image WHERE change_id IN (SELECT id FROM core.change WHERE record_id = ${recordId}::uuid)`;
    }

    if (kind === "delete") {
      yield* deleteAsset(fixture.admin.id, recordId, 1);
    }

    const log = yield* StatementLog;
    yield* log.clear;
    assert.strictEqual(yield* workerPass(), 1);
    const [delivery] = yield* Ref.get(deliveries);
    assert.isDefined(delivery);
    assert.strictEqual(delivery?.recordId, recordId);
    assert.strictEqual(delivery?.payload.image[ACME.name], `quality ${kind}`);
    assert.strictEqual(
      (yield* log.texts).some(isOriginRead),
      kind === "rendered" || kind === "legacy" || kind === "delete"
    );

    if (kind === "rendered") {
      assert.isAbove(Number(delivery?.events?.[0]?.origins), 0);
    }
  }
);

const sourceRecord = (id: string, name: string): SourceRecord => ({
  classId: ACME.asset,
  id,
  parts: new Map(),
  values: new Map([[ACME.name, { value: name }]]),
  version: 1,
});

const historyEnrichment = Effect.gen(function* historyEnrichment() {
  const fixture = yield* AcmeFixture;

  const firstId = yield* createAsset(fixture.admin.id, {
    name: "history first",
  });

  const secondId = yield* createAsset(fixture.admin.id, {
    name: "history second",
  });

  const first = sourceRecord(firstId, "history first");
  const second = sourceRecord(secondId, "history second");

  const attribute = {
    ...fieldAttribute("name", ACME.name),
    history: [ACME.name],
  };

  const log = yield* StatementLog;
  const { request } = yield* Transactions;
  yield* request(
    Effect.gen(function* readHistoryBatch() {
      const scope = yield* currentReadScope();

      for (const records of [[first], [first, second, first]]) {
        yield* log.clear;

        const rendered = yield* withHistory(
          [attribute],
          records,
          () => true,
          scope
        );

        assert.deepStrictEqual(
          rendered.map((record) => record.id),
          records.map((record) => record.id)
        );
        assert.deepStrictEqual(
          rendered.map((record) => record.history?.[0]?.changes.get(ACME.name)),
          records.map((record) => record.values.get(ACME.name)?.value)
        );
        assert.strictEqual(
          (yield* log.texts).filter((text) =>
            text.includes("jsonb_exists_any(c.fields,")
          ).length,
          1
        );
      }
    })
  ).pipe(asLoadedUser(fixture.admin.id));
});

describe("runtime quality invariants", () => {
  it.effect(
    "cursor finishing preserves before-page display order and navigation",
    () =>
      Effect.gen(function* cursorFinishing() {
        const page = finishPage(
          [{ id: THIRD }, { id: SECOND }, { id: FIRST }],
          2,
          true,
          []
        );

        assert.deepStrictEqual(page.rows, [{ id: SECOND }, { id: THIRD }]);
        assert.isTrue(page.hasMore);
        assert.deepStrictEqual(
          yield* decodeCursor([], page.firstCursor ?? ""),
          {
            id: SECOND,
            values: [],
          }
        );
        assert.deepStrictEqual(yield* decodeCursor([], page.nextCursor ?? ""), {
          id: THIRD,
          values: [],
        });
        assert.deepStrictEqual(finishPage([], 2, false, []), {
          firstCursor: null,
          hasMore: false,
          nextCursor: null,
          rows: [],
        });
      })
  );

  it("an absent field in a created owner's previous-only path remains a defect", () => {
    const field = {
      classId: SECOND,
      id: FIRST,
      name: "missing",
      retired: false,
      type: { kind: "text" as const },
    };

    const node: ResolvedNode = {
      arg: {
        classes: [SECOND],
        field,
        fields: [field],
        ids: [FIRST],
        image: "previous",
        scope: "owner",
      },
      op: "empty",
    };

    const source = { owner: {}, previous: null, targets: new Map() };
    assert.throws(
      () => {
        partMatches(node, {}, source);
      },
      ConditionDefectError,
      "A field is missing from the image."
    );
    assert.throws(
      () => {
        evaluateAggregate(
          { classId: SECOND, root: { node, op: "owner" }, stage: "resolved" },
          {
            ...source,
            parts: () => [],
            partsChanged: () => false,
          }
        );
      },
      ConditionDefectError,
      "A field is missing from the image."
    );
  });

  it("lexes write clauses beyond the retained leading tokens", () => {
    const prefix = `SELECT ${"1, ".repeat(40)}1`;
    assert.isTrue(analyzeStatement(`${prefix} INTO scratch;`).writeClause);
    assert.isFalse(analyzeStatement(`${prefix} AS into;`).writeClause);
    assert.isFalse(analyzeStatement(`${prefix} FROM public.into;`).writeClause);
    assert.strictEqual(analyzeStatement(`${prefix}; SELECT 1;`).statements, 2);
  });

  layer(workerTestLayer(), { excludeTestServices: true })((dbTest) => {
    for (const kind of DELIVERY_KINDS) {
      dbTest.effect(
        `origin reads follow payload requirements for ${kind} deliveries`,
        () => workerOrigins(kind)
      );
    }

    dbTest.effect(
      "history enrichment uses one statement for a class and preserves repeated record positions",
      () => historyEnrichment
    );
  });
});
