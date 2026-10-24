import { assert, describe, it } from "@effect/vitest";
import { identSql, renderSql } from "@std/conditions/sql-fragment";
import { HELPDESK_CLASS_IDS, TICKET_FIELD_IDS } from "@std/tmf/helpdesk-ids";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import { listOrderKey } from "../src/config/list-order-key.ts";
import { checkListOrder, ListOrderRefused } from "../src/config/list-order.ts";
import { planUpgrade, runUpgrade } from "../src/config/upgrade.ts";
import { runDoctor } from "../src/doctor/doctor.ts";
import { checkPlatformMigrations } from "../src/platform/runner.ts";
import { SqlLayer } from "../src/sql/layer.ts";
import { textOf, withQuery } from "./api-support.ts";
import { itilLayer } from "./itil-support.ts";
import { linksOf, nextOf } from "./paging.ts";
import { addIndex, change } from "./schema-support.ts";
import {
  bodyOf,
  itemsOf,
  ticketBody,
  TICKETS,
  tmf621As,
} from "./tmf621-support.ts";

const NAMES = [
  "Zulu",
  "Äpfel",
  "Ångström",
  "Éclair",
  "e\u0301cole",
  "école",
  "alpha",
  "Straße",
  "STRASSE",
  "a_b",
  "a1",
  "a10",
  "a2",
];

const ENGLISH_ORDER = [
  "a_b",
  "a1",
  "a10",
  "a2",
  "alpha",
  "Ångström",
  "Äpfel",
  "Éclair",
  "e\u0301cole",
  "école",
  "Straße",
  "STRASSE",
  "Zulu",
];

// Replacing a collation is an offline operation: restarting opens a new pool,
// so no prepared statement can retain the replaced collation's OID.
const getAfterRestart = (path: string) =>
  Effect.gen(function* restartedRequest() {
    return yield* (yield* tmf621As("admin")).get(path);
  }).pipe(
    Effect.provide(
      Layer.fresh(TestHttpClient.layer.pipe(Layer.provide(SqlLayer)))
    ),
    Effect.scoped
  );

describe("list-order", () => {
  it("gives query adapters the same explicit collation without changing non-text keys", () => {
    const column = identSql("name");
    assert.strictEqual(
      renderSql(listOrderKey({ kind: "integer" }, column)).text,
      '"name"'
    );
    assert.strictEqual(
      renderSql(listOrderKey({ caseSensitive: true, kind: "text" }, column))
        .text,
      '("name" COLLATE core.list_order)'
    );
    assert.strictEqual(
      renderSql(listOrderKey({ kind: "text" }, column)).text,
      '(casefold("name" COLLATE pg_unicode_fast) COLLATE core.list_order)'
    );
  });

  it.effect(
    "uses deterministic en-GB keys for indexes, forward/reverse cursors and mapped codes, and invalidates transitions",
    () =>
      Effect.gen(function* orderedLists() {
        const admin = yield* tmf621As("admin");
        const sql = yield* SqlClient.SqlClient;
        const tag = "Language ordering test";

        for (const name of NAMES) {
          const created = yield* admin.post(
            TICKETS,
            ticketBody({ description: tag, name })
          );

          assert.strictEqual(created.status, 201, created.text);
        }

        const query = (extra: readonly (readonly [string, string])[]) =>
          withQuery(TICKETS, [
            ["description", tag],
            ["sort", "name"],
            ...extra,
          ]);

        const all = yield* admin.get(query([["limit", "1000"]]));
        assert.deepStrictEqual(
          itemsOf(all).map((item) => item.name),
          ENGLISH_ORDER
        );
        const first = yield* admin.get(query([["limit", "3"]]));
        const secondPath = nextOf(first.headers.get("link"));
        assert.isDefined(secondPath);
        const second = yield* admin.get(secondPath ?? "");
        const previousPath = linksOf(second.headers.get("link")).get("prev");
        assert.isDefined(previousPath);
        const previousUrl = new URL(previousPath ?? "", "http://std.test");

        const previous = yield* admin.get(
          `${previousUrl.pathname}${previousUrl.search}`
        );

        assert.deepStrictEqual(
          itemsOf(previous).map((item) => item.id),
          itemsOf(first).map((item) => item.id)
        );
        const ids = itemsOf(first).map((item) => item.id);
        const visited = new Set<string>();
        let next: string | undefined = secondPath;

        while (next !== undefined) {
          assert.isFalse(visited.has(next), "a continuation must advance");
          visited.add(next);
          const page = yield* admin.get(next);
          assert.strictEqual(page.status, 200, page.text);
          ids.push(...itemsOf(page).map((item) => item.id));
          next = nextOf(page.headers.get("link"));
        }

        assert.deepStrictEqual(
          ids,
          itemsOf(all).map((item) => item.id)
        );

        const old = Buffer.from(
          JSON.stringify({
            i: itemsOf(first).at(-1)?.id,
            k: ["a10"],
            s: [TICKET_FIELD_IDS.shortDescription],
          })
        ).toString("base64url");

        const refused = yield* admin.get(query([["after", old]]));
        assert.strictEqual(refused.status, 400, refused.text);
        assert.strictEqual(bodyOf(refused).code, "InvalidCursor");
        assert.include(refused.text, "restart pagination");

        const statuses = itemsOf(
          yield* admin.get(`${TICKETS}?sort=status&limit=1000`)
        ).map((item) => textOf(item.status));

        assert.deepStrictEqual(
          [...new Set(statuses)],
          ["acknowledged", "held", "inProgress", "pending", "resolved"]
        );

        const priorities = itemsOf(
          yield* admin.get(`${TICKETS}?sort=priority&limit=1000`)
        ).map((item) => textOf(item.priority));

        assert.deepStrictEqual(priorities, priorities.toSorted());

        const index = addIndex(
          HELPDESK_CLASS_IDS.ticket,
          [TICKET_FIELD_IDS.shortDescription],
          false
        );

        yield* change([index.op]);

        const plan = yield* sql.unsafe<{ "QUERY PLAN": string }>(
          `EXPLAIN (COSTS OFF) SELECT id FROM helpdesk.ticket ORDER BY casefold(short_description COLLATE pg_unicode_fast) COLLATE core.list_order LIMIT 1`
        );

        assert.include(
          plan.map((row) => row["QUERY PLAN"]).join("\n"),
          `std_ix_${index.id.replaceAll("-", "")}`
        );

        const declared = yield* sql.unsafe<{ definition: string }>(
          `SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indexrelid = 'helpdesk.std_ix_${index.id.replaceAll("-", "")}'::regclass`
        );

        assert.include(
          declared[0]?.definition ?? "",
          "COLLATE core.list_order"
        );
        assert.strictEqual((yield* runDoctor()).exitCode, 0);

        const before = yield* checkListOrder;
        yield* sql.unsafe(
          "UPDATE pg_collation SET collisdeterministic = false WHERE oid = 'core.list_order'::regcollation"
        );
        const alteredProvider = yield* Effect.result(planUpgrade());
        assert.strictEqual(alteredProvider._tag, "Failure");

        if (alteredProvider._tag === "Failure") {
          assert.instanceOf(alteredProvider.failure, ListOrderRefused);
        }

        yield* sql.unsafe(
          "UPDATE pg_collation SET collisdeterministic = true WHERE oid = 'core.list_order'::regcollation"
        );
        assert.strictEqual((yield* checkListOrder).epoch, before.epoch);

        const snapshot = yield* sql.unsafe<{ history: string }>(
          "SELECT md5(jsonb_agg(to_jsonb(c) ORDER BY c.id)::text) AS history FROM core.change c"
        );

        const unavailable = yield* Effect.result(
          planUpgrade({ listLocale: "not-a-registered-locale" })
        );

        assert.strictEqual(unavailable._tag, "Failure");
        assert.strictEqual((yield* checkListOrder).epoch, before.epoch);
        const planned = yield* planUpgrade({ listLocale: "sv-SE" });
        assert.isTrue(planned.listOrder?.rebuild);
        assert.include(
          planned.listOrder?.indexes ?? [],
          `"helpdesk"."std_ix_${index.id.replaceAll("-", "")}"`
        );
        yield* runUpgrade({
          expectedPlanHash: planned.hash,
          listLocale: "sv-SE",
        });
        assert.strictEqual((yield* checkListOrder).locale, "sv-SE");
        const stale = yield* getAfterRestart(secondPath ?? "");
        assert.strictEqual(stale.status, 400, stale.text);

        const swedishAnswer = yield* getAfterRestart(
          query([["limit", "1000"]])
        );

        assert.strictEqual(swedishAnswer.status, 200, swedishAnswer.text);
        const swedish = itemsOf(swedishAnswer).map((item) => textOf(item.name));
        assert.isBelow(swedish.indexOf("Zulu"), swedish.indexOf("Ångström"));
        assert.strictEqual((yield* runDoctor()).exitCode, 0);

        const swedishPolicy = yield* checkListOrder;
        yield* sql.unsafe(
          "UPDATE pg_collation SET collversion = 'simulated-older-ICU' WHERE oid = 'core.list_order'::regcollation"
        );
        const drift = yield* Effect.result(checkPlatformMigrations());
        assert.strictEqual(drift._tag, "Failure");

        if (drift._tag === "Failure") {
          assert.instanceOf(drift.failure, ListOrderRefused);
        }

        const doctor = yield* runDoctor();
        assert.strictEqual(doctor.exitCode, 1);
        assert.isTrue(
          doctor.findings.some((finding) => finding.code === "listOrder")
        );
        const { epoch } = swedishPolicy;
        yield* runUpgrade();
        assert.notStrictEqual((yield* checkListOrder).epoch, epoch);
        assert.strictEqual((yield* runDoctor()).exitCode, 0);
        assert.deepStrictEqual(
          yield* sql.unsafe(
            "SELECT md5(jsonb_agg(to_jsonb(c) ORDER BY c.id)::text) AS history FROM core.change c"
          ),
          snapshot
        );
        yield* runUpgrade({ listLocale: "en-GB" });

        const englishAnswer = yield* getAfterRestart(
          query([["limit", "1000"]])
        );

        assert.strictEqual(englishAnswer.status, 200, englishAnswer.text);
        assert.deepStrictEqual(
          itemsOf(englishAnswer).map((item) => item.name),
          ENGLISH_ORDER
        );
        assert.strictEqual((yield* runDoctor()).exitCode, 0);
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );
});
