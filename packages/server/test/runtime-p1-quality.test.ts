import { assert, describe, it, layer } from "@effect/vitest";
import { evaluateAggregate, partMatches } from "@std/conditions/aggregate";
import { ConditionDefectError } from "@std/conditions/defect";
import type { ResolvedNode } from "@std/conditions/typed";
import {
  PLATFORM_CLASS_IDS,
  SYSTEM_USER_ID,
} from "@std/definitions/well-known";
import { fieldAttribute } from "@std/tmf/mapping";
import type { SourceRecord } from "@std/tmf/mapping";
import { Effect, Ref, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { AcmeFixture, acmeTestLayer } from "../../testing/src/acme-fixture.ts";
import { ACME } from "../../testing/src/acme-ids.ts";
import { withHistory } from "../src/http/tmf/sources.ts";
import type { Delivery } from "../src/outbox/delivery-effects.ts";
import {
  entryTargetKey,
  readEntriesAt,
  readEntryResultsAt,
} from "../src/outbox/delivery-payload.ts";
import type { EntryTarget } from "../src/outbox/delivery-payload.ts";
import {
  workerPass,
  deleteOldDeliveries,
  RETENTION_BATCH,
} from "../src/outbox/worker.ts";
import { decodeCursor, finishPage } from "../src/records/read-cursor.ts";
import { currentReadScope } from "../src/records/read-records.ts";
import { decodeRows } from "../src/sql/rows.ts";
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

const decodeId = decodeRows(Schema.Struct({ id: Schema.String }));

const decodeTarget = decodeRows(
  Schema.Struct({ id: Schema.String, record_id: Schema.String })
);

const decodeCount = decodeRows(Schema.Struct({ count: Schema.Int }));

describe("retention and batched history invariants", () => {
  it.effect(
    "retention returns the total across batches and preserves dead and fresh deliveries",
    () =>
      Effect.gen(function* retentionBatches() {
        const sql = yield* SqlClient.SqlClient;
        const log = yield* StatementLog;

        const [subscription] = yield* sql`INSERT INTO core.subscription
          (id, class_id, version, created_at, created_by, updated_at, updated_by, owner_layer, owner_set_id, state, protected, name, table_id, operations, identity_id, max_attempts, dead_letter, enabled)
          VALUES (uuidv7(), ${PLATFORM_CLASS_IDS.subscription}::uuid, 1, now(), ${SYSTEM_USER_ID}::uuid, now(), ${SYSTEM_USER_ID}::uuid, 'local', NULL, 'active', false, 'p2-retention', ${ACME.asset}::uuid, '["create"]'::jsonb, ${SYSTEM_USER_ID}::uuid, 1, 'skip', true) RETURNING id::text AS id`.pipe(
          Effect.flatMap(decodeId)
        );

        assert.isDefined(subscription);

        yield* sql`WITH inserted AS (
          INSERT INTO core.change (id, class_id, version, created_at, created_by, updated_at, updated_by, operation_id, record_id, record_class_id, record_version, kind, actor_id, cause, schema_revision, occurred_at, fields)
          SELECT uuidv7(), ${PLATFORM_CLASS_IDS.change}::uuid, 1, now(), ${SYSTEM_USER_ID}::uuid, now(), ${SYSTEM_USER_ID}::uuid, uuidv7(), uuidv7(), ${ACME.asset}::uuid, 1, 'create', ${SYSTEM_USER_ID}::uuid, '{}'::jsonb, 1, now(), jsonb_build_object('p2', i)
          FROM generate_series(1, ${RETENTION_BATCH + 3}::int) AS i RETURNING id, record_id, fields
        ) INSERT INTO core.delivery (subscription_id, change_id, record_id, record_version, status, attempts, next_attempt_at, finished_at)
          SELECT ${subscription.id}::uuid, id, record_id, 1,
          CASE WHEN (fields->>'p2')::int = ${RETENTION_BATCH + 2} THEN 'dead' ELSE 'done' END,
          1, now(), CASE WHEN (fields->>'p2')::int = ${RETENTION_BATCH + 3} THEN now() ELSE now() - interval '8 days' END FROM inserted`;

        yield* log.clear;
        assert.strictEqual(yield* deleteOldDeliveries(), RETENTION_BATCH + 1);
        assert.lengthOf(
          (yield* log.texts).filter((text) =>
            text.includes("DELETE FROM core.delivery")
          ),
          2
        );
        assert.strictEqual(yield* deleteOldDeliveries(), 0);

        const [remaining] =
          yield* sql`SELECT count(*)::int AS count FROM core.delivery WHERE subscription_id = ${subscription.id}::uuid`.pipe(
            Effect.flatMap(decodeCount)
          );

        assert.strictEqual(remaining?.count, 2);
      }).pipe(Effect.provide(acmeTestLayer()))
  );

  it.effect(
    "batched history isolates unreadable saved and legacy targets while the fail-fast reader still fails",
    () =>
      Effect.gen(function* historyIsolation() {
        const sql = yield* SqlClient.SqlClient;
        const targets: (EntryTarget & { readonly malformed: boolean })[] = [];

        for (const imaged of [true, false]) {
          for (const malformed of [false, true]) {
            const [row] =
              yield* sql`INSERT INTO core.change (id, class_id, version, created_at, created_by, updated_at, updated_by, operation_id, record_id, record_class_id, record_version, kind, actor_id, cause, schema_revision, occurred_at, fields)
              VALUES (uuidv7(), ${PLATFORM_CLASS_IDS.change}::uuid, 1, now(), ${SYSTEM_USER_ID}::uuid, now(), ${SYSTEM_USER_ID}::uuid, uuidv7(), uuidv7(), ${ACME.asset}::uuid, 1, 'create', ${SYSTEM_USER_ID}::uuid, '{}'::jsonb, 1, now(), ${malformed ? '{"x":9007199254740993}' : "{}"}::jsonb)
              RETURNING id::text AS id, record_id::text AS record_id`.pipe(
                Effect.flatMap(decodeTarget)
              );

            assert.isDefined(row);

            if (imaged) {
              yield* sql`INSERT INTO core.change_image (change_id, after_image) VALUES (${row.id}::uuid, '{}'::jsonb)`;
            }

            targets.push({ malformed, recordId: row.record_id, version: 1 });
          }
        }

        const results = yield* readEntryResultsAt(targets);
        assert.strictEqual(results.size, 4);

        for (const target of targets) {
          const result = results.get(entryTargetKey(target));
          assert.isDefined(result);
          assert.strictEqual(Result.isFailure(result), target.malformed);

          if (Result.isFailure(result)) {
            assert.strictEqual(result.failure._tag, "PayloadUnreadable");
          } else {
            assert.lengthOf(result.success, 1);
          }
        }

        const failFast = yield* readEntriesAt(targets).pipe(Effect.result);
        assert.isTrue(Result.isFailure(failFast));

        if (Result.isFailure(failFast)) {
          assert.strictEqual(failFast.failure._tag, "PayloadUnreadable");
        }
      }).pipe(Effect.provide(acmeTestLayer()))
  );
});
