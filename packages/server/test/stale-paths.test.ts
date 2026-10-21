/**
 * Stale requests on every path (Contracts 6.2, 6.4): reads, writes,
 * history and the auth endpoints, each with a malformed
 * `STD-Schema-Revision`, a revision this database never had (ahead of
 * the current one, or another change set at the same number), the
 * current revision, an older one separated only by an irrelevant change,
 * and an older one separated by a relevant change.
 *
 * Auth endpoints name no table or field: a malformed header is
 * `InvalidSchemaRevision` and an unknown revision `SchemaChanged` with no
 * changes, but no change since an older revision is relevant to them.
 * Sign-out checks only the header's format, so a stale client can always
 * end its session. A delete names no field, so only table changes are
 * relevant to it.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import { OPENAPI_PATH } from "@std/api/api";
import { Effect } from "effect";
import type { Layer } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type {
  TestRequestOptions,
  TestResponse,
} from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { revisionHeaderValue } from "../src/http/schema-revision-header.ts";
import { staleScope } from "../src/http/stale-scope.ts";
import { freshAsset, observe, signInAll } from "./authz-support.ts";
import type { Callers, Observation } from "./authz-support.ts";
import {
  listPath,
  readsTestLayer,
  recordPath,
  tagOf,
} from "./reads-support.ts";
import { ACME, change, values } from "./schema-support.ts";

/** The paths, in the order of every expectation below. */
const PATHS = [
  "list",
  "get",
  "history",
  "history?field",
  "create",
  "update",
  "delete",
  "sign-in",
  "me",
  "sign-out",
  "openapi",
] as const;

type PathName = (typeof PATHS)[number];

const HEADER = "std-schema-revision";

/** The services of the test layer. */
type Services = Layer.Success<ReturnType<typeof readsTestLayer>>;

/** A fresh monitor's values. */
const FRESH = { name: "fresh", status: "in_use" } as const;

/**
 * Takes one path as Alice with a stated revision.
 *
 * @param callers - The fixture's callers.
 * @param name - The path.
 * @param revision - The header value.
 * @returns The response.
 */
const take = (callers: Callers, name: PathName, revision: string) =>
  Effect.gen(function* takePath() {
    const http = yield* TestHttpClient;
    const { fixture } = callers;
    const alice = fixture.alice.id;
    const headers = { [HEADER]: revision };
    const token = callers.tokens.alice;
    const history = `${recordPath("acme.asset", fixture.records.L)}/history`;

    // A fresh monitor, then the update or delete of it.
    const freshThen = (method: "PATCH" | "DELETE") =>
      Effect.gen(function* onFreshMonitor() {
        const id = yield* freshAsset(alice, ACME.monitor, FRESH);

        const options: TestRequestOptions = {
          headers: { ...headers, "if-match": '"1"' },
          token,
        };

        return yield* http.request(
          method,
          recordPath("acme.asset", id),
          method === "PATCH"
            ? { ...options, body: { name: "renamed" } }
            : options
        );
      });

    const routes: Readonly<
      Record<PathName, () => Effect.Effect<TestResponse, unknown, Services>>
    > = {
      create: () =>
        http.request("POST", listPath("acme.monitor"), {
          body: { name: "made stale", owner: alice },
          headers,
          token,
        }),
      delete: () => freshThen("DELETE"),
      get: () =>
        http.get(
          recordPath("acme.asset", fixture.records.L, { fields: "name" }),
          { headers, token }
        ),
      history: () => http.get(history, { headers, token }),
      "history?field": () =>
        http.get(`${history}?field=${ACME.status}`, { headers, token }),
      list: () =>
        http.get(listPath("acme.asset", { fields: "name" }), {
          headers,
          token,
        }),
      me: () => http.get("/api/v1/auth/me", { headers, token }),
      openapi: () => http.request("GET", OPENAPI_PATH, { headers }),
      "sign-in": () =>
        http.request("POST", "/api/v1/auth/sign-in", {
          body: { login: "alice", password: "alice-password" },
          headers,
        }),
      // A session of its own, so Alice's stays.
      "sign-out": () =>
        http.signIn("alice", "alice-password").pipe(
          Effect.flatMap((own) =>
            http.request("POST", "/api/v1/auth/sign-out", {
              headers,
              token: own,
            })
          )
        ),
      update: () => freshThen("PATCH"),
    };

    return yield* routes[name]();
  });

/**
 * Every path's outcome with a stated revision.
 *
 * @param callers - The fixture's callers.
 * @param revision - The header value.
 * @returns Per path, its observation.
 */
const allPaths = (callers: Callers, revision: string) =>
  Effect.gen(function* everyPath() {
    const outcomes: (readonly [PathName, number, string])[] = [];

    for (const name of PATHS) {
      const seen = observe(yield* take(callers, name, revision));

      outcomes.push([name, seen.status, seen.tag ?? ""]);
    }

    return outcomes;
  });

const success: Readonly<Record<PathName, number>> = {
  create: 201,
  delete: 200,
  get: 200,
  history: 200,
  "history?field": 200,
  list: 200,
  me: 200,
  openapi: 200,
  "sign-in": 200,
  "sign-out": 204,
  update: 200,
};

/**
 * The expected outcome of every path: success unless refused.
 *
 * @param refused - The paths refused, with the error.
 * @returns Per path, status and tag.
 */
const expected = (
  refused: Partial<Record<PathName, Observation>>
): (readonly [PathName, number, string])[] =>
  PATHS.map((name) => {
    const refusal = refused[name];

    return refusal === undefined
      ? [name, success[name], ""]
      : [name, refusal.status, refusal.tag ?? ""];
  });

const everyPathBut = (
  observation: Observation,
  except: readonly PathName[]
): Partial<Record<PathName, Observation>> =>
  Object.fromEntries(
    PATHS.flatMap((name) =>
      except.includes(name) ? [] : [[name, observation] as const]
    )
  );

const CHANGED: Observation = { status: 409, tag: "SchemaChanged" };

describe("stale-paths", () => {
  it("expects success where nothing is refused", () => {
    assert.deepStrictEqual(expected({})[0], ["list", 200, ""]);
  });

  it("history's field filter puts its field IDs in scope, on their own class", () => {
    const text = { kind: "text" as const, maxLength: 64 };

    const definitions = {
      classes: new Map([
        [ACME.asset, { displayFieldId: null, parentId: null }],
        [ACME.laptop, { displayFieldId: null, parentId: ACME.asset }],
      ]),
      fields: new Map([
        [
          ACME.name,
          {
            classId: ACME.asset,
            id: ACME.name,
            live: true,
            name: "name",
            type: text,
          },
        ],
        [
          ACME.serial,
          {
            classId: ACME.laptop,
            id: ACME.serial,
            live: true,
            name: "serial",
            type: text,
          },
        ],
      ]),
    };

    const entries = (fieldIds?: string) =>
      staleScope(
        definitions,
        ACME.asset,
        fieldIds === undefined ? { fields: "" } : { fieldIds, fields: "" }
      ).entries;

    // A child-only field outside the parent endpoint's selection.
    assert.deepStrictEqual(entries(), []);
    assert.deepStrictEqual(entries(ACME.serial.toUpperCase()), [
      { classId: ACME.laptop, fieldId: ACME.serial },
    ]);
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("every path checks the revision it was built at", () =>
      Effect.gen(function* stalePaths() {
        const callers = yield* signInAll;
        const catalog = yield* Catalog;
        const built = yield* catalog.refresh;
        const stated = revisionHeaderValue(built);

        // Malformed: 400 on every path, sign-out included.
        assert.deepStrictEqual(
          yield* allPaths(callers, "12.not-a-uuid"),
          expected(
            everyPathBut({ status: 400, tag: "InvalidSchemaRevision" }, [])
          )
        );

        // A revision this database never had: ahead, or another change
        // set at the same number. Sign-out still ends the session.
        for (const never of [
          revisionHeaderValue({
            changeSetId: built.changeSetId,
            revision: built.revision + 5,
          }),
          revisionHeaderValue({
            changeSetId: randomUUID(),
            revision: built.revision,
          }),
        ]) {
          assert.deepStrictEqual(
            yield* allPaths(callers, never),
            expected(everyPathBut(CHANGED, ["sign-out"])),
            never
          );
        }

        // The current revision.
        assert.deepStrictEqual(yield* allPaths(callers, stated), expected({}));

        // Only a label changed since: nothing is relevant.
        const status = built.field(ACME.status);

        yield* change([
          {
            changes: { label: "Condition" },
            id: ACME.status,
            op: "update",
            version: status?.version ?? 1,
          },
        ]);

        assert.deepStrictEqual(yield* allPaths(callers, stated), expected({}));

        // Backfill, as table owner, so `status` can become required.
        yield* values(
          `UPDATE acme.asset SET status = 'in_use' WHERE status IS NULL
           RETURNING id::text AS value`
        );

        // `status` became required: relevant to every path that names it
        // (the default selection of history, the history filter on it) and
        // to creates (a field required without a default). Not to reads
        // and updates naming only `name`, to deletes, or to auth.
        yield* change([
          {
            changes: { required: true },
            id: ACME.status,
            op: "update",
            version: (yield* catalog.refresh).field(ACME.status)?.version ?? 1,
          },
        ]);

        assert.deepStrictEqual(
          yield* allPaths(callers, stated),
          expected({
            create: CHANGED,
            history: CHANGED,
            "history?field": CHANGED,
          })
        );
      })
    );

    dbTest.effect(
      "history through a parent endpoint is checked against the record's own class",
      () =>
        Effect.gen(function* childHistory() {
          const http = yield* TestHttpClient;
          const callers = yield* signInAll;
          const catalog = yield* Catalog;
          const built = yield* catalog.refresh;
          const stated = revisionHeaderValue(built);
          const { K } = callers.fixture.records;

          const historyOfK = (table: string, token: string, id = K) =>
            http.get(`${recordPath(table, id)}/history`, {
              headers: { [HEADER]: stated },
              token,
            });

          assert.strictEqual(
            (yield* historyOfK("acme.asset", callers.tokens.alice)).status,
            200
          );

          // `serial`, a laptop-only field, becomes read-only.
          yield* change([
            {
              changes: { readOnly: true },
              id: ACME.serial,
              op: "update",
              version: built.field(ACME.serial)?.version ?? 1,
            },
          ]);

          for (const table of ["acme.asset", "acme.laptop"]) {
            const stale = yield* historyOfK(table, callers.tokens.alice);

            assert.strictEqual(stale.status, 409, table);
            assert.strictEqual(yield* tagOf(stale), "SchemaChanged");
            assert.include(stale.text, "readOnlyChanged");
            assert.include(stale.text, '"serial"');
          }

          // Before visibility nothing depends on the record: Bob's stale
          // request for Alice's K is NotFound, like a random ID.
          const invisible = yield* historyOfK("acme.asset", callers.tokens.bob);

          const random = yield* historyOfK(
            "acme.asset",
            callers.tokens.bob,
            randomUUID()
          );

          assert.strictEqual(invisible.status, 404);
          assert.strictEqual(invisible.text, random.text);
        })
    );
  });
});
