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
import { setOrigin } from "@std/definitions/requester";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
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
import { applyChangeSet } from "../src/schema/change-set.ts";
import {
  freshAsset,
  objectOf,
  observe,
  presenting,
  signInAll,
  signInAllBy,
  textOf,
} from "./authz-support.ts";
import type { Callers, Observation } from "./authz-support.ts";
import {
  codeOf,
  listPath,
  readsTestLayer,
  recordPath,
} from "./reads-support.ts";
import { CHANGE_SETS, postChangeSet } from "./schema-paths-support.ts";
import { ACME, change, createRole, values } from "./schema-support.ts";

/** The paths, in the order of every expectation below. */
const PATHS = [
  "list",
  "get",
  "history",
  "history?field",
  "create",
  "update",
  "update?answer",
  "delete",
  "sign-in",
  "me",
  "sign-out",
  "openapi",
  "metadata",
  "metadata openapi",
  "metadata tables",
  "picker list",
  "change-set apply",
  "change-set read",
  "definition create",
  "definition update",
  "definition delete",
] as const;

type PathName = (typeof PATHS)[number];

const HEADER = "std-schema-revision";

/** What the web app sends on every request with its session cookie. */
const WEB_CLIENT_HEADERS = { "std-client": "web" } as const;

const SESSION = "/api/v1/session";

/** The services of the test layer. */
type Services = Layer.Success<ReturnType<typeof readsTestLayer>>;

/**
 * Definitions the definition paths work on, made before the test states
 * its revision: local roles to delete one per call (`roles`, used up), one
 * to relabel, and a committed change set to read.
 */
interface DefinitionPool {
  readonly roles: string[];
  readonly relabel: string;
  readonly changeSetId: string;
}

/**
 * A local role, created by the administrator through the change-set
 * endpoint without a stated revision.
 *
 * @param callers - The fixture's callers.
 * @returns The role's ID and the change set's ID.
 */
const roleByAdmin = (callers: Callers) =>
  Effect.gen(function* createRoleByAdmin() {
    const role = createRole(`stale_${randomUUID().slice(0, 8)}`);

    const response = yield* postChangeSet(callers.tokens.admin, [role]);

    assert.strictEqual(response.status, 201, response.text);

    return {
      changeSetId: textOf(objectOf(response.json).id),
      id: role.definition.id,
    };
  });

/**
 * The pool for the definition paths.
 *
 * @param callers - The fixture's callers.
 * @param calls - How many times every path is taken.
 * @returns The pool.
 */
const definitionPool = (callers: Callers, calls: number) =>
  Effect.gen(function* makeDefinitionPool() {
    const relabel = createRole(`stale_${randomUUID().slice(0, 8)}`);

    const roles = Array.from({ length: calls }, () =>
      createRole(`stale_${randomUUID().slice(0, 8)}`)
    );

    const response = yield* postChangeSet(callers.tokens.admin, [
      relabel,
      ...roles,
    ]);

    assert.strictEqual(response.status, 201, response.text);

    return {
      changeSetId: textOf(objectOf(response.json).id),
      relabel: relabel.definition.id,
      roles: roles.map((role) => role.definition.id),
    } satisfies DefinitionPool;
  });

/**
 * A role's stored version, as table owner.
 *
 * @param id - The role.
 * @returns The version as text.
 */
const roleVersion = (id: string) =>
  values(`SELECT version::text AS value FROM core."role" WHERE id = $1::uuid`, [
    id,
  ]).pipe(Effect.map(([version]) => version ?? "1"));

/** A fresh monitor's values. */
const FRESH = { name: "fresh", status: "in_use" } as const;

/**
 * Takes one path as Alice with a stated revision.
 *
 * @param callers - The fixture's callers.
 * @param pool - The definitions the definition paths work on.
 * @param name - The path.
 * @param revision - The header value.
 * @returns The response.
 */
const take = (
  callers: Callers,
  pool: DefinitionPool,
  name: PathName,
  revision: string
) =>
  Effect.gen(function* takePath() {
    const http = yield* TestHttpClient;
    const { fixture } = callers;
    const alice = fixture.alice.id;
    const headers = { [HEADER]: revision };
    const token = callers.tokens.alice;
    const as = (session: string) => presenting(callers.transport, session);
    const cookies = callers.transport !== "bearer";
    const history = `${recordPath("acme.asset", fixture.records.L)}/history`;

    // A fresh monitor, then the update or delete of it.
    // The answer of an update is the record read again through the
    // endpoint, with the selection of `answer` (`fields`, else the default
    // selection of the record's concrete class).
    const freshThen = (method: "PATCH" | "DELETE", answer = "") =>
      Effect.gen(function* onFreshMonitor() {
        const id = yield* freshAsset(alice, ACME.monitor, FRESH);

        const options: TestRequestOptions = {
          headers: { ...headers, "if-match": '"1"' },
          ...as(token),
        };

        return yield* http.request(
          method,
          recordPath("acme.asset", id, answer === "" ? {} : { fields: answer }),
          method === "PATCH"
            ? { ...options, body: { name: "renamed" } }
            : options
        );
      });

    // Definition paths act as the administrator.
    const { admin } = callers.tokens;

    const routes: Readonly<
      Record<PathName, () => Effect.Effect<TestResponse, unknown, Services>>
    > = {
      "change-set apply": () =>
        http.request("POST", CHANGE_SETS, {
          body: {
            operations: [createRole(`stale_${randomUUID().slice(0, 8)}`)],
          },
          headers,
          ...as(admin),
        }),
      "change-set read": () =>
        http.get(`${CHANGE_SETS}/${pool.changeSetId}`, {
          headers,
          ...as(admin),
        }),
      create: () =>
        http.request("POST", listPath("acme.monitor"), {
          body: { name: "made stale", owner: alice },
          headers,
          ...as(token),
        }),
      "definition create": () =>
        http.request("POST", listPath("core.role"), {
          body: { label: "Stale", name: `stale_${randomUUID().slice(0, 8)}` },
          headers,
          ...as(admin),
        }),
      "definition delete": () =>
        http.request(
          "DELETE",
          recordPath("core.role", pool.roles.pop() ?? ""),
          {
            headers: { ...headers, "if-match": '"1"' },
            ...as(admin),
          }
        ),
      "definition update": () =>
        roleVersion(pool.relabel).pipe(
          Effect.flatMap((version) =>
            http.request("PATCH", recordPath("core.role", pool.relabel), {
              body: { label: `Relabelled ${randomUUID().slice(0, 4)}` },
              headers: { ...headers, "if-match": `"${version}"` },
              ...as(admin),
            })
          )
        ),
      delete: () => freshThen("DELETE"),
      get: () =>
        http.get(
          recordPath("acme.asset", fixture.records.L, { fields: "name" }),
          { headers, ...as(token) }
        ),
      history: () => http.get(history, { headers, ...as(token) }),
      "history?field": () =>
        http.get(`${history}?field=${ACME.status}`, { headers, ...as(token) }),
      list: () =>
        http.get(listPath("acme.asset", { fields: "name" }), {
          headers,
          ...as(token),
        }),
      me: () => http.get(`${SESSION}/current`, { headers, ...as(token) }),
      // Metadata is what a stale client asks for: an older revision is
      // served, one the database never had is not.
      metadata: () =>
        http.get("/api/v1/tableMetadata/acmeAsset", {
          headers,
          ...as(token),
        }),
      "metadata openapi": () =>
        http.get("/api/v1/tableMetadata/acmeAsset/openapi.json", {
          headers,
          ...as(token),
        }),
      "metadata tables": () =>
        http.get("/api/v1/tableMetadata", { headers, ...as(token) }),
      openapi: () => http.get(OPENAPI_PATH, { headers }),
      // The picker's reference field is in scope; `dockedTo` is not
      // touched by the changes below.
      "picker list": () =>
        http.get(
          listPath("acme.asset", {
            allowedFor: "acmeAsset/dockedTo",
            fields: "name",
          }),
          { headers, ...as(token) }
        ),
      // The web app signs in with the cookie form.
      "sign-in": () =>
        http.request("POST", SESSION, {
          body: {
            login: "alice",
            password: "alice-password",
            tokenDelivery: cookies ? "cookie" : "body",
          },
          headers: cookies ? { ...headers, ...WEB_CLIENT_HEADERS } : headers,
        }),
      // A session of its own, so Alice's stays.
      "sign-out": () =>
        (cookies
          ? http.cookieSignIn("alice", "alice-password")
          : http.signIn("alice", "alice-password")
        ).pipe(
          Effect.flatMap((own) =>
            http.request("DELETE", `${SESSION}/current`, {
              headers,
              ...as(own),
            })
          )
        ),
      // Naming only `name`, the answer too.
      update: () => freshThen("PATCH", "name"),
      // The answer shows the monitor's default selection, `status` too.
      "update?answer": () => freshThen("PATCH"),
    };

    return yield* routes[name]();
  });

/**
 * Every path's outcome with a stated revision.
 *
 * @param callers - The fixture's callers.
 * @param pool - The definitions the definition paths work on.
 * @param revision - The header value.
 * @returns Per path, its observation.
 */
const allPaths = (callers: Callers, pool: DefinitionPool, revision: string) =>
  Effect.gen(function* everyPath() {
    const outcomes: (readonly [PathName, number, string])[] = [];

    for (const name of PATHS) {
      const seen = observe(yield* take(callers, pool, name, revision));

      outcomes.push([name, seen.status, seen.tag ?? ""]);
    }

    return outcomes;
  });

const success: Readonly<Record<PathName, number>> = {
  "change-set apply": 201,
  "change-set read": 200,
  create: 201,
  "definition create": 201,
  "definition delete": 204,
  "definition update": 200,
  delete: 204,
  get: 200,
  history: 200,
  "history?field": 200,
  list: 200,
  me: 200,
  metadata: 200,
  "metadata openapi": 200,
  "metadata tables": 200,
  openapi: 200,
  "picker list": 200,
  "sign-in": 201,
  "sign-out": 204,
  update: 200,
  "update?answer": 200,
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

/** One value per way of presenting a session. */
interface BothWays<A> {
  readonly bearer: A;
  readonly cookie: A;
}

/**
 * Every path's outcome with a stated revision, with a bearer token and
 * with the session cookie.
 *
 * @param callers - The callers of each way.
 * @param pool - The definitions the definition paths work on.
 * @param revision - The header value.
 * @returns Per way, per path, its observation.
 */
const allPathsBothWays = (
  callers: BothWays<Callers>,
  pool: DefinitionPool,
  revision: string
) =>
  Effect.gen(function* everyPathBothWays() {
    return {
      bearer: yield* allPaths(callers.bearer, pool, revision),
      cookie: yield* allPaths(callers.cookie, pool, revision),
    };
  });

/**
 * The same expected outcomes for both ways.
 *
 * @param outcomes - The outcomes.
 * @returns Them, per way.
 */
const both = <A>(outcomes: A): BothWays<A> => ({
  bearer: outcomes,
  cookie: outcomes,
});

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
    dbTest.effect(
      "every path checks the revision it was built at, by bearer token and by session cookie",
      () =>
        Effect.gen(function* stalePaths() {
          const callers: BothWays<Callers> = {
            bearer: yield* signInAllBy("bearer"),
            cookie: yield* signInAllBy("cookie"),
          };

          const pool = yield* definitionPool(callers.bearer, 16);
          const catalog = yield* Catalog;

          const everyWay = (revision: string) =>
            allPathsBothWays(callers, pool, revision);

          const built = yield* catalog.refresh;
          const stated = revisionHeaderValue(built);

          // Malformed: 400 on every path, sign-out included.
          assert.deepStrictEqual(
            yield* everyWay("12.not-a-uuid"),
            both(
              expected(
                everyPathBut({ status: 400, tag: "InvalidSchemaRevision" }, [])
              )
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
              yield* everyWay(never),
              both(expected(everyPathBut(CHANGED, ["sign-out"]))),
              never
            );
          }

          // The current revision.
          assert.deepStrictEqual(yield* everyWay(stated), both(expected({})));

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

          assert.deepStrictEqual(yield* everyWay(stated), both(expected({})));

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
              version:
                (yield* catalog.refresh).field(ACME.status)?.version ?? 1,
            },
          ]);

          assert.deepStrictEqual(
            yield* everyWay(stated),
            both(
              expected({
                create: CHANGED,
                history: CHANGED,
                "history?field": CHANGED,
                "update?answer": CHANGED,
              })
            )
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
            assert.strictEqual(yield* codeOf(stale), "SchemaChanged");
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

    dbTest.effect(
      "a definition write built before its column became read-only is SchemaChanged on both paths",
      () =>
        Effect.gen(function* definitionColumnChanged() {
          const http = yield* TestHttpClient;
          const callers = yield* signInAll;
          const catalog = yield* Catalog;
          const { id } = yield* roleByAdmin(callers);
          const built = yield* catalog.refresh;
          const stated = revisionHeaderValue(built);

          const label = built.fieldByName(PLATFORM_CLASS_IDS.role, "label");

          assert.isDefined(label);

          // The core set makes core.role's label read-only: a change to a
          // column of a definition table, which only the core set can make.
          yield* applyChangeSet({
            operations: [
              {
                changes: { readOnly: true },
                id: label?.id ?? "",
                op: "update",
                version: label?.version ?? 1,
              },
            ],
            origin: setOrigin({ layer: "core" }),
          });

          const version = yield* roleVersion(id);
          const headers = { [HEADER]: stated };
          const token = callers.tokens.admin;

          const generic = yield* http.request(
            "PATCH",
            recordPath("core.role", id),
            {
              body: { label: "Too late" },
              headers: { ...headers, "if-match": `"${version}"` },
              token,
            }
          );

          const endpoint = yield* http.request("POST", CHANGE_SETS, {
            body: {
              operations: [
                {
                  changes: { label: "Too late" },
                  id,
                  op: "update",
                  version: Number(version),
                },
              ],
            },
            headers,
            token,
          });

          for (const response of [generic, endpoint]) {
            assert.deepStrictEqual(observe(response), CHANGED, response.text);
            assert.include(response.text, "readOnlyChanged");
            assert.include(response.text, '"label"');
          }

          assert.strictEqual(yield* roleVersion(id), version);
        })
    );
  });
});
