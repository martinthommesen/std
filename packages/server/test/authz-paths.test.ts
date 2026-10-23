/**
 * The two-user suite extended to every read and write path (the Step 1
 * gate; Contracts 2.3, 3.3 to 3.9, 3.10, 6.6, 6.7): one table, one row per
 * path, the outcome expected for Alice (`asset_manager`) and Bob
 * (`employee`) under the twelve rules of 3.3.
 *
 * Read rows run first and change nothing; every write row makes its own
 * records, so rows are independent of each other's order. Nested saves
 * from hooks run at the record-service level with a test hook (the seam
 * of decision 0009), as the acting user.
 *
 * Definitions have their own table (`DEFINITION_ROWS`), with the
 * administrator's outcome too: the change-set endpoints (apply and read)
 * and generic writes on definition tables, which run as one-operation
 * change sets (Contracts 1.4, decision 0011). A refusal there commits
 * nothing: no revision, change entry, delivery, journal, definition or
 * config-layer row.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import { apiAttributeNameOf } from "@std/definitions/names";
import type { Operation } from "@std/definitions/operation";
import { parseJson } from "@std/values/json";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Exit, Ref } from "effect";
import type { Layer } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import type { AcmeData } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type {
  TestRequestOptions,
  TestResponse,
} from "../../testing/src/http-client.ts";
import { Actor, loadActor } from "../src/auth/actor.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { InstanceSettings } from "../src/config/instance-settings.ts";
import { OutboxSaveHooks } from "../src/records/outbox-producer.ts";
import { SaveHooks } from "../src/records/save-hooks.ts";
import type { SaveHooksApi } from "../src/records/save-hooks.ts";
import { updateRecord } from "../src/records/save-pipeline.ts";
import { RuleWriteAccess } from "../src/records/write-access-rules.ts";
import { WriteOnlyValues } from "../src/records/write-only-values.ts";
import { Transactions } from "../src/sql/transactions.ts";
import {
  arrayOf,
  asBearer,
  deliveries,
  freshAsset,
  listNames,
  nameOf,
  objectOf,
  textOf,
  observe,
  presenting,
  recordIn,
  refused,
  signInAllBy,
  subscribeToEverySave,
  TRANSPORTS,
  userOf,
} from "./authz-support.ts";
import type { Callers, Observation, Who } from "./authz-support.ts";
import { committedState } from "./committed-state.ts";
import {
  allPages,
  collectionOf,
  listPath,
  readsTestLayer,
  recordPath,
} from "./reads-support.ts";
import { CHANGE_SETS, definitionVersion } from "./schema-paths-support.ts";
import { ACME, createRole, values } from "./schema-support.ts";
import { errorOf } from "./support.ts";
import { ASSET, LAPTOP, MONITOR, versionOf } from "./writes-support.ts";

/** The services the rows use: the acme fixture and the HTTP client. */
type Services = Layer.Success<ReturnType<typeof readsTestLayer>>;

/** One path: how a caller takes it, and what each user gets. */
interface PathRow {
  readonly path: string;
  readonly run: (
    callers: Callers,
    who: Who
  ) => Effect.Effect<Observation, unknown, Services>;
  readonly alice: Observation;
  readonly bob: Observation;
}

/**
 * A 200 listing these record names.
 *
 * @param names - The names, in response order.
 * @returns The observation.
 */
const okNames = (names: readonly string[]): Observation => ({
  names,
  status: 200,
});

/**
 * A 200 with this detail.
 *
 * @param detail - What the row checks.
 * @returns The observation.
 */
const okDetail = (detail: JsonValue): Observation => ({ detail, status: 200 });

const send = (
  callers: Callers,
  who: Who,
  method: string,
  path: string,
  options: TestRequestOptions = {}
) =>
  Effect.gen(function* sendRequest() {
    const http = yield* TestHttpClient;

    return yield* http.request(method, path, {
      ...options,
      ...presenting(callers.transport, callers.tokens[who]),
    });
  });

const list =
  (table: string, query: Readonly<Record<string, string>> = {}) =>
  (callers: Callers, who: Who) =>
    send(callers, who, "GET", listPath(table, { sort: "name", ...query })).pipe(
      Effect.map((response) =>
        observe(response, { names: listNames(response.json) })
      )
    );

/** A fixture record by its short name. */
type RecordName = keyof AcmeData["records"];

const recordName = (callers: Callers, name: RecordName) =>
  callers.fixture.records[name];

const getOne =
  (table: string, name: "L" | "K" | "AM") => (callers: Callers, who: Who) =>
    send(
      callers,
      who,
      "GET",
      recordPath(table, recordName(callers, name))
    ).pipe(
      Effect.map((response) =>
        observe(response, { names: [nameOf(recordIn(response.json))] })
      )
    );

const REFERENCE_ATTRIBUTES = [
  "createdBy",
  "dockedTo",
  "owner",
  "updatedBy",
] as const;

// The names of L's references, where the caller may see the target's name.
const namesOfL = (callers: Callers, who: Who) =>
  send(callers, who, "GET", recordPath(ASSET, callers.fixture.records.L)).pipe(
    Effect.map((response) => {
      const resource = recordIn(response.json);

      const names = REFERENCE_ATTRIBUTES.flatMap((attribute) => {
        const { name } = objectOf(resource[attribute]);

        return name === undefined ? [] : [[attribute, name] as const];
      });

      return observe(response, { detail: Object.fromEntries(names) });
    })
  );

// Which records list `dockedTo` as withheld.
const dockedTo = (callers: Callers, who: Who) =>
  send(
    callers,
    who,
    "GET",
    listPath(ASSET, { fields: "name,dockedTo", sort: "name" })
  ).pipe(
    Effect.map((response) => {
      const withheld = arrayOf(response.json).flatMap((resource) =>
        arrayOf(objectOf(resource).withheld).includes("dockedTo")
          ? [nameOf(resource)]
          : []
      );

      return observe(response, { detail: { withheld } });
    })
  );

// The total of a list (`X-Total-Count`).
const counted = (callers: Callers, who: Who) =>
  send(callers, who, "GET", listPath(ASSET, { limit: "1" })).pipe(
    Effect.map((response) =>
      observe(response, {
        detail: Number(response.headers.get("x-total-count")),
      })
    )
  );

// Every page of 1, following `rel="next"` links.
const paged = (callers: Callers, who: Who) =>
  allPages({ token: callers.tokens[who] }, ASSET, {
    limit: "1",
    sort: "-name",
  }).pipe(
    Effect.map((pages): Observation => ({
      names: pages.resources.map((resource) => textOf(resource.name)),
      status: 200,
    }))
  );

// A history entry as `<revision>:cost` when it shows `cost`, else
// `<revision>:-`.
const versionAndCost = (entry: JsonValue): string => {
  const { changes, revision } = objectOf(entry);

  return `${textOf(revision)}:${"cost" in objectOf(changes) ? "cost" : "-"}`;
};

const historyOf =
  (
    table: string,
    name: RecordName,
    query: Readonly<Record<string, string>> = {}
  ) =>
  (callers: Callers, who: Who) =>
    send(
      callers,
      who,
      "GET",
      `${recordPath(table, recordName(callers, name))}/history?${new URLSearchParams(query).toString()}`
    ).pipe(
      Effect.map((response) => {
        // Per entry: its revision and whether `cost` appears.
        const entries = arrayOf(response.json).map(versionAndCost);

        return observe(response, { detail: entries });
      })
    );

// Metadata of a table: its field names, sorted, and its read states.
const metadataOf = (table: string) => (callers: Callers, who: Who) =>
  send(
    callers,
    who,
    "GET",
    `/api/v1/tableMetadata/${collectionOf(table)}`
  ).pipe(
    Effect.map((response) =>
      observe(response, {
        detail: arrayOf(objectOf(response.json).fields)
          .map((field) => {
            const { name, read } = objectOf(field);

            return `${textOf(name)}:${textOf(read)}`;
          })
          .toSorted(),
      })
    )
  );

// The attributes every resource carries, left out of a schema's attributes.
const SYSTEM_ATTRIBUTES: ReadonlySet<string> = new Set([
  "@baseType",
  "@schemaLocation",
  "@type",
  "href",
  "id",
  "revision",
  "withheld",
]);

// The per-table JSON Schema: the attribute names it describes.
const tableSchemaOf = (table: string) => (callers: Callers, who: Who) =>
  send(
    callers,
    who,
    "GET",
    `/api/v1/tableMetadata/${collectionOf(table)}/schema.json`
  ).pipe(
    Effect.map((response) =>
      observe(response, {
        detail: Object.keys(objectOf(objectOf(response.json).properties))
          .filter((name) => !SYSTEM_ATTRIBUTES.has(name))
          .toSorted(),
      })
    )
  );

// The per-table OpenAPI document: the attribute names its resource describes.
const tableOpenApiOf = (table: string) => (callers: Callers, who: Who) =>
  send(
    callers,
    who,
    "GET",
    `/api/v1/tableMetadata/${collectionOf(table)}/openapi.json`
  ).pipe(
    Effect.map((response) => {
      const schemas = objectOf(
        objectOf(objectOf(response.json).components).schemas
      );

      return observe(response, {
        detail: Object.keys(objectOf(objectOf(schemas.Resource).properties))
          .filter((name) => !SYSTEM_ATTRIBUTES.has(name))
          .toSorted(),
      });
    })
  );

const me = (callers: Callers, who: Who) =>
  send(callers, who, "GET", "/api/v1/session/current").pipe(
    Effect.map((response) =>
      observe(response, {
        detail: arrayOf(objectOf(response.json).roles)
          .map((role) => textOf(objectOf(role).name))
          .toSorted(),
      })
    )
  );

// Sign in again (the callers' way), use the session, sign out, then use it
// again.
const sessionLifecycle = (callers: Callers, who: Who) =>
  Effect.gen(function* signInUseSignOut() {
    const http = yield* TestHttpClient;
    const login = who === "admin" ? "ada" : who;

    const session = presenting(
      callers.transport,
      callers.transport === "bearer"
        ? yield* http.signIn(login, `${login}-password`)
        : yield* http.cookieSignIn(login, `${login}-password`)
    );

    const used = yield* http.get(listPath(ASSET), session);

    const out = yield* http.request(
      "DELETE",
      "/api/v1/session/current",
      session
    );

    const after = yield* http.get(listPath(ASSET), session);
    const meAfter = yield* http.get("/api/v1/session/current", session);

    return {
      detail: [used.status, out.status, after.status, meAfter.status],
      status: 200,
    } satisfies Observation;
  });

/**
 * A fresh record owned by `owner`, named uniquely.
 *
 * @param callers - The fixture's callers.
 * @param owner - The owner.
 * @param classId - The class.
 * @param extra - More values.
 * @returns The record's ID and name.
 */
const fresh = (
  callers: Callers,
  owner: Who,
  classId: string,
  extra: Readonly<Record<string, JsonValue>> = {}
) =>
  Effect.gen(function* freshRecord() {
    const name = `fresh-${randomUUID().slice(0, 8)}`;

    const required: Record<string, JsonValue> =
      classId === ACME.laptop
        ? { purchased_on: "2026-01-01", serial: `SN-${name}` }
        : {};

    const id = yield* freshAsset(userOf(callers.fixture, owner), classId, {
      name,
      status: "in_use",
      ...required,
      ...extra,
    });

    return { id, name };
  });

const ifMatch = (version: number) => ({ "if-match": `"${version}"` });

const writeStatus = (response: Parameters<typeof observe>[0]): Observation =>
  observe(response);

const other = (who: Who): Who => (who === "alice" ? "bob" : "alice");

/**
 * The tag of a failed exit, or `saved`.
 *
 * @param exit - A save's exit.
 * @returns `saved`, the error's tag, or `defect`.
 */
const outcomeOf = <A, E extends { readonly _tag: string }>(
  exit: Exit.Exit<A, E>
): string =>
  Exit.isSuccess(exit) ? "saved" : (errorOf(exit)?._tag ?? "defect");

/**
 * `actorId` updates `outerId`'s name through the record service; its
 * after-write hook saves `target` with `body` as a nested save, with the
 * save's own Actor and rule-based access (Contracts 4.1: in-transaction
 * hook writes run as the acting user). A refused nested save fails the
 * outer save, which rolls back.
 *
 * @param actorId - The acting user.
 * @param outerId - The record the outer save updates (at version 1).
 * @param target - The record the hook saves (at version 1).
 * @param body - The hook's values for it.
 * @returns The nested save's outcomes and the outer save's.
 */
const nestedSave = (
  actorId: string,
  outerId: string,
  target: string,
  body: Readonly<Record<string, JsonValue>>
) =>
  Effect.gen(function* runNestedSave() {
    const nested = yield* Ref.make<readonly string[]>([]);
    const catalog = yield* Catalog;
    const transactions = yield* Transactions;

    const actor = Actor.of(
      yield* transactions.request(
        Effect.gen(function* actorOfRequest() {
          return yield* loadActor(yield* catalog.current, actorId);
        })
      )
    );

    const settings = yield* InstanceSettings;
    const writeOnly = yield* WriteOnlyValues;

    // The request's services, the Actor and its rule-based WriteAccess.
    const saveAs = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      hooks: SaveHooksApi
    ) =>
      effect.pipe(
        Effect.provide(RuleWriteAccess),
        Effect.provideService(Actor, actor),
        Effect.provideService(Catalog, catalog),
        Effect.provideService(Transactions, transactions),
        Effect.provideService(InstanceSettings, settings),
        Effect.provideService(WriteOnlyValues, writeOnly),
        Effect.provideService(SaveHooks, SaveHooks.of(hooks))
      );

    // The HTTP app's hooks: the outbox producer, no other hook.
    const noHooks: SaveHooksApi = yield* Effect.gen(function* outboxHooks() {
      return yield* SaveHooks;
    }).pipe(Effect.provide(OutboxSaveHooks));

    const saveAnother = Effect.gen(function* saveAnother() {
      const exit = yield* Effect.exit(
        saveAs(
          updateRecord({
            body,
            endpointClassId: ACME.asset,
            expectedVersion: 1,
            id: target,
          }),
          noHooks
        )
      );

      yield* Ref.update(nested, (seen) => [...seen, outcomeOf(exit)]);

      return Exit.isSuccess(exit)
        ? yield* Effect.void
        : yield* Effect.die(new Error("the nested save was refused"));
    });

    const hooks: SaveHooksApi = {
      ...noHooks,
      afterWrite: (input) =>
        input.entry.recordId === outerId ? saveAnother : Effect.void,
    };

    const outer = yield* Effect.exit(
      saveAs(
        updateRecord({
          body: { name: `outer-${randomUUID().slice(0, 8)}` },
          endpointClassId: ACME.asset,
          expectedVersion: 1,
          id: outerId,
        }),
        hooks
      )
    );

    return {
      nested: yield* Ref.get(nested),
      outer: Exit.isSuccess(outer) ? "saved" : "refused",
    };
  }).pipe(Effect.provide(WriteOnlyValues.scrypt));

const READ_ROWS: readonly PathRow[] = [
  {
    alice: okNames(["Alice monitor", "K", "L", "M", "S"]),
    bob: okNames(["L", "M", "S"]),
    path: "GET /acme.asset (list, parent endpoint)",
    run: list(ASSET),
  },
  {
    alice: okNames(["K", "L"]),
    bob: okNames(["L"]),
    path: "GET /acme.laptop (list, child endpoint)",
    run: list(LAPTOP),
  },
  {
    alice: okNames(["Alice monitor", "M"]),
    bob: okNames(["M"]),
    path: "GET /acme.monitor (list, child endpoint)",
    run: list(MONITOR),
  },
  {
    alice: okNames(["K", "L"]),
    bob: okNames(["L"]),
    path: "GET /acme.laptop?allowedFor=acme.asset/docked_to (picker, no condition)",
    run: list(LAPTOP, { allowedFor: "acmeAsset/dockedTo" }),
  },
  {
    alice: refused(404, "UnknownTable"),
    bob: refused(404, "UnknownTable"),
    path: "GET /acme.asset?allowedFor=core.access_rule/condition (platform table)",
    run: list(ASSET, { allowedFor: "coreAccessRule/condition" }),
  },
  {
    alice: refused(400, "InvalidRequest"),
    bob: refused(400, "UnknownField"),
    path: "GET /acme.asset?allowedFor=acme.asset/cost (not a reference; never readable by Bob)",
    run: list(ASSET, { allowedFor: "acmeAsset/cost" }),
  },
  {
    alice: okDetail(5),
    bob: okDetail(3),
    path: "GET /acme.asset (X-Total-Count)",
    run: counted,
  },
  {
    alice: okNames(["S", "M", "L", "K", "Alice monitor"]),
    bob: okNames(["S", "M", "L"]),
    path: "GET /acme.asset cursor pages of 1, descending",
    run: paged,
  },
  {
    alice: okNames(["L"]),
    bob: okNames(["L"]),
    path: "GET /acme.asset/{L} (parent endpoint)",
    run: getOne(ASSET, "L"),
  },
  {
    alice: okNames(["L"]),
    bob: okNames(["L"]),
    path: "GET /acme.laptop/{L} (child endpoint)",
    run: getOne(LAPTOP, "L"),
  },
  {
    alice: refused(404, "NotFound"),
    bob: refused(404, "NotFound"),
    path: "GET /acme.monitor/{L} (outside the endpoint's subtree)",
    run: getOne(MONITOR, "L"),
  },
  {
    alice: okNames(["K"]),
    bob: refused(404, "NotFound"),
    path: "GET /acme.asset/{K} (Alice's laptop)",
    run: getOne(ASSET, "K"),
  },
  {
    alice: okNames(["K"]),
    bob: refused(404, "NotFound"),
    path: "GET /acme.laptop/{K}",
    run: getOne(LAPTOP, "K"),
  },
  {
    alice: okNames(["L"]),
    bob: okNames([]),
    path: 'condition dockedTo.name = "Alice monitor" (reference path)',
    run: list(ASSET, { condition: 'dockedTo.name = "Alice monitor"' }),
  },
  {
    alice: okNames(["Alice monitor", "K", "L", "M", "S"]),
    bob: refused(400, "UnknownField"),
    path: "condition cost > 0 (never readable for Bob)",
    run: list(ASSET, { condition: "cost > 0" }),
  },
  {
    alice: okNames(["Alice monitor", "K", "L", "M", "S"]),
    bob: okNames(["L", "M"]),
    path: 'condition purchasedOn > "2000-01-01" (masked for Bob\'s lost S)',
    run: list(ASSET, { condition: 'purchasedOn > "2000-01-01"' }),
  },
  {
    alice: okNames(["M", "Alice monitor", "L", "K", "S"]),
    bob: refused(400, "UnknownField"),
    path: "sort cost",
    run: list(ASSET, { sort: "cost" }),
  },
  {
    alice: okNames(["Alice monitor", "K", "L", "M", "S"]),
    bob: refused(400, "UnknownField"),
    path: "fields=name,cost",
    run: list(ASSET, { fields: "name,cost" }),
  },
  {
    alice: okDetail({ withheld: [] }),
    bob: okDetail({ withheld: ["S"] }),
    path: "fields=name,dockedTo (rule 10 withholds S's)",
    run: dockedTo,
  },
  {
    alice: okDetail({
      createdBy: "Bob",
      dockedTo: "Alice monitor",
      owner: "Bob",
      updatedBy: "Bob",
    }),
    bob: okDetail({
      createdBy: "Bob",
      owner: "Bob",
      updatedBy: "Bob",
    }),
    path: "GET /acme.asset/{L} (hidden target, audit names)",
    run: namesOfL,
  },
  {
    alice: okDetail(["1:cost"]),
    bob: okDetail(["1:-"]),
    path: "GET /acme.asset/{L}/history",
    run: historyOf(ASSET, "L"),
  },
  {
    alice: okDetail(["1:cost"]),
    bob: okDetail(["1:-"]),
    path: "GET /acme.laptop/{L}/history",
    run: historyOf(LAPTOP, "L"),
  },
  {
    alice: okDetail(["1:cost"]),
    bob: refused(400, "UnknownField"),
    path: "GET /acme.asset/{L}/history?field=<cost>",
    run: historyOf(ASSET, "L", { field: ACME.cost }),
  },
  {
    alice: okDetail(["1:cost"]),
    bob: okDetail(["1:-"]),
    path: "GET /acme.asset/{L}/history?kind=create",
    run: historyOf(ASSET, "L", { kind: "create" }),
  },
  {
    alice: okDetail(["1:cost"]),
    bob: refused(404, "NotFound"),
    path: "GET /acme.laptop/{K}/history",
    run: historyOf(LAPTOP, "K"),
  },
  {
    alice: okDetail(["1:cost"]),
    bob: okDetail(["1:-"]),
    path: "GET /acme.monitor/{M}/history",
    run: historyOf(MONITOR, "M"),
  },
  {
    alice: okDetail(["1:cost"]),
    bob: okDetail(["1:-"]),
    path: "GET /acme.asset/{M}/history",
    run: historyOf(ASSET, "M"),
  },
  {
    alice: okDetail(["1:cost"]),
    bob: refused(404, "NotFound"),
    path: "GET /acme.monitor/{AM}/history",
    run: historyOf(MONITOR, "AM"),
  },
  {
    alice: refused(404, "UnknownTable"),
    bob: refused(404, "UnknownTable"),
    path: "GET /core.change (platform table)",
    run: list("core.change"),
  },
  {
    alice: refused(404, "UnknownTable"),
    bob: refused(404, "UnknownTable"),
    path: "GET /core.access_rule (platform table)",
    run: list("core.access_rule"),
  },
  {
    alice: okNames(["Ada", "Alice", "Bob", "Carol", "System"]),
    bob: okNames(["Ada", "Alice", "Bob", "Carol", "System"]),
    path: "GET /core.user (built-in rule: records and name)",
    run: list("core.user"),
  },
  {
    alice: okDetail(["asset_manager", "authenticated"]),
    bob: okDetail(["authenticated", "employee"]),
    path: "GET /session/current",
    run: me,
  },
  {
    alice: okDetail([
      "cost:yes",
      "docked_to:yes",
      "name:yes",
      "owner:yes",
      "purchased_on:yes",
      "status:yes",
    ]),
    bob: okDetail([
      "docked_to:perRecord",
      "name:yes",
      "owner:yes",
      "purchased_on:perRecord",
      "status:yes",
    ]),
    path: "GET /tableMetadata/acmeAsset",
    run: metadataOf(ASSET),
  },
  {
    alice: okDetail([
      "cost:yes",
      "disk_key:yes",
      "docked_to:yes",
      "name:yes",
      "owner:yes",
      "purchased_on:yes",
      "serial:yes",
      "status:yes",
    ]),
    bob: okDetail([
      "docked_to:perRecord",
      "name:yes",
      "owner:yes",
      "purchased_on:perRecord",
      "serial:yes",
      "status:yes",
    ]),
    path: "GET /tableMetadata/acmeLaptop",
    run: metadataOf(LAPTOP),
  },
  {
    alice: refused(404, "UnknownTable"),
    bob: refused(404, "UnknownTable"),
    path: "GET /tableMetadata/coreChange (platform table)",
    run: metadataOf("core.change"),
  },
  {
    alice: okDetail([
      "cost",
      "createdBy",
      "creationDate",
      "dockedTo",
      "lastUpdate",
      "name",
      "owner",
      "purchasedOn",
      "status",
      "updatedBy",
    ]),
    bob: okDetail([
      "createdBy",
      "creationDate",
      "dockedTo",
      "lastUpdate",
      "name",
      "owner",
      "purchasedOn",
      "status",
      "updatedBy",
    ]),
    path: "GET /tableMetadata/acmeAsset/schema.json",
    run: tableSchemaOf(ASSET),
  },
  {
    alice: refused(404, "UnknownTable"),
    bob: refused(404, "UnknownTable"),
    path: "GET /tableMetadata/coreAccessRule/schema.json (platform table)",
    run: tableSchemaOf("core.access_rule"),
  },
  {
    alice: okDetail([
      "cost",
      "createdBy",
      "creationDate",
      "dockedTo",
      "lastUpdate",
      "name",
      "owner",
      "purchasedOn",
      "status",
      "updatedBy",
    ]),
    bob: okDetail([
      "createdBy",
      "creationDate",
      "dockedTo",
      "lastUpdate",
      "name",
      "owner",
      "purchasedOn",
      "status",
      "updatedBy",
    ]),
    path: "GET /tableMetadata/acmeAsset/openapi.json",
    run: tableOpenApiOf(ASSET),
  },
  {
    alice: refused(404, "UnknownTable"),
    bob: refused(404, "UnknownTable"),
    path: "GET /tableMetadata/coreAccessRule/openapi.json (platform table)",
    run: tableOpenApiOf("core.access_rule"),
  },
  {
    alice: okDetail([200, 204, 401, 401]),
    bob: okDetail([200, 204, 401, 401]),
    path: "sign-in, use, sign-out, use again",
    run: sessionLifecycle,
  },
];

const WRITE_ROWS: readonly PathRow[] = [
  {
    alice: { status: 201 },
    bob: { status: 201 },
    path: "POST /acme.asset owned by the caller",
    run: (callers, who) =>
      send(callers, who, "POST", listPath(ASSET), {
        body: { name: "mine", owner: userOf(callers.fixture, who) },
      }).pipe(Effect.map(writeStatus)),
  },
  {
    alice: { status: 201 },
    bob: refused(403, "NotAllowed"),
    path: "POST /acme.asset owned by someone else",
    run: (callers, who) =>
      send(callers, who, "POST", listPath(ASSET), {
        body: { name: "theirs", owner: userOf(callers.fixture, other(who)) },
      }).pipe(Effect.map(writeStatus)),
  },
  {
    alice: { status: 201 },
    bob: refused(403, "NotAllowed"),
    path: "POST /acme.laptop (Bob may not create purchasedOn or serial)",
    run: (callers, who) =>
      send(callers, who, "POST", listPath(LAPTOP), {
        body: {
          name: "laptop",
          owner: userOf(callers.fixture, who),
          purchasedOn: "2026-01-01",
        },
      }).pipe(Effect.map(writeStatus)),
  },
  {
    alice: { status: 201 },
    bob: { status: 201 },
    path: "POST /acme.monitor owned by the caller",
    run: (callers, who) =>
      send(callers, who, "POST", listPath(MONITOR), {
        body: { name: "monitor", owner: userOf(callers.fixture, who) },
      }).pipe(Effect.map(writeStatus)),
  },
  {
    alice: refused(400, "UnknownField"),
    bob: refused(400, "UnknownField"),
    path: "POST /acme.asset naming a child-only field",
    run: (callers, who) =>
      send(callers, who, "POST", listPath(ASSET), {
        body: { name: "x", serial: "S" },
      }).pipe(Effect.map(writeStatus)),
  },
  {
    alice: { status: 200 },
    bob: { status: 200 },
    path: "PATCH /acme.asset/{own laptop} name",
    run: (callers, who) =>
      Effect.gen(function* patchName() {
        const { id } = yield* fresh(callers, who, ACME.laptop);

        return writeStatus(
          yield* send(callers, who, "PATCH", recordPath(ASSET, id), {
            body: { name: "renamed" },
            headers: ifMatch(1),
          })
        );
      }),
  },
  {
    alice: { status: 200 },
    bob: refused(403, "NotAllowed"),
    path: "PATCH /acme.laptop/{own laptop} status (rule 9)",
    run: (callers, who) =>
      Effect.gen(function* patchStatus() {
        const { id } = yield* fresh(callers, who, ACME.laptop);

        return writeStatus(
          yield* send(callers, who, "PATCH", recordPath(LAPTOP, id), {
            body: { status: "spare" },
            headers: ifMatch(1),
          })
        );
      }),
  },
  {
    alice: { status: 200 },
    bob: refused(403, "NotAllowed"),
    path: "PATCH /acme.asset/{own asset} handing it over (proposed state)",
    run: (callers, who) =>
      Effect.gen(function* handOver() {
        const { id } = yield* fresh(callers, who, ACME.asset);

        return writeStatus(
          yield* send(callers, who, "PATCH", recordPath(ASSET, id), {
            body: { owner: userOf(callers.fixture, other(who)) },
            headers: ifMatch(1),
          })
        );
      }),
  },
  {
    alice: { status: 200 },
    bob: refused(404, "NotFound"),
    path: "PATCH /acme.asset/{someone else's asset}",
    run: (callers, who) =>
      Effect.gen(function* patchOthers() {
        const { id } = yield* fresh(callers, other(who), ACME.monitor);

        return writeStatus(
          yield* send(callers, who, "PATCH", recordPath(ASSET, id), {
            body: { name: "taken over" },
            headers: ifMatch(1),
          })
        );
      }),
  },
  {
    alice: refused(412, "VersionConflict"),
    bob: refused(412, "VersionConflict"),
    path: "PATCH with a stale If-Match",
    run: (callers, who) =>
      Effect.gen(function* stalePatch() {
        const { id } = yield* fresh(callers, who, ACME.asset);

        return writeStatus(
          yield* send(callers, who, "PATCH", recordPath(ASSET, id), {
            body: { name: "stale" },
            headers: ifMatch(7),
          })
        );
      }),
  },
  {
    alice: refused(428, "VersionRequired"),
    bob: refused(428, "VersionRequired"),
    path: "PATCH without If-Match",
    run: (callers, who) =>
      send(
        callers,
        who,
        "PATCH",
        recordPath(ASSET, callers.fixture.records.M),
        { body: { name: "no version" } }
      ).pipe(Effect.map(writeStatus)),
  },
  {
    alice: { status: 204 },
    bob: refused(403, "NotAllowed"),
    path: "DELETE /acme.asset/{own asset} (no delete rule for Bob)",
    run: (callers, who) =>
      Effect.gen(function* deleteOwn() {
        const { id } = yield* fresh(callers, who, ACME.asset);

        return writeStatus(
          yield* send(callers, who, "DELETE", recordPath(ASSET, id), {
            headers: ifMatch(1),
          })
        );
      }),
  },
  {
    alice: { status: 204 },
    bob: refused(404, "NotFound"),
    path: "DELETE /acme.laptop/{someone else's laptop}",
    run: (callers, who) =>
      Effect.gen(function* deleteOthers() {
        const { id } = yield* fresh(callers, other(who), ACME.laptop);

        return writeStatus(
          yield* send(callers, who, "DELETE", recordPath(LAPTOP, id), {
            headers: ifMatch(1),
          })
        );
      }),
  },
  {
    alice: refused(409, "Referenced"),
    bob: refused(403, "NotAllowed"),
    path: "DELETE /acme.monitor/{own monitor a laptop docks to}",
    run: (callers, who) =>
      Effect.gen(function* deleteReferenced() {
        const monitor = yield* fresh(callers, who, ACME.monitor);

        yield* fresh(callers, who, ACME.laptop, { docked_to: monitor.id });

        return writeStatus(
          yield* send(callers, who, "DELETE", recordPath(MONITOR, monitor.id), {
            headers: ifMatch(1),
          })
        );
      }),
  },
  {
    alice: refused(404, "UnknownTable"),
    bob: refused(404, "UnknownTable"),
    path: "POST /core.access_rule (definition table; 1A: change sets)",
    run: (callers, who) =>
      send(callers, who, "POST", listPath("core.access_rule"), {
        body: { description: "mine" },
      }).pipe(Effect.map(writeStatus)),
  },
];

/** A path on definitions, with the administrator's outcome too. */
interface DefinitionRow extends PathRow {
  readonly admin: Observation;
}

/**
 * A definition write's outcome. A refusal must commit nothing: no
 * revision, change entry, delivery, journal or definition row; if it did,
 * the observation says so and no expected outcome matches it.
 *
 * @param writing - The request.
 * @returns The observation.
 */
const measuredWrite = (
  writing: Effect.Effect<TestResponse, unknown, Services>
) =>
  Effect.gen(function* measureWrite() {
    const before = JSON.stringify(yield* committedState);
    const response = yield* writing;
    const seen = writeStatus(response);

    return response.status >= 400 &&
      JSON.stringify(yield* committedState) !== before
      ? { ...seen, detail: "committed" }
      : seen;
  });

/**
 * A change set as a caller posts it.
 *
 * @param callers - The fixture's callers.
 * @param who - The caller.
 * @param operations - The operations.
 * @returns The response.
 */
const postChangeSet = (
  callers: Callers,
  who: Who,
  operations: readonly Operation[]
) => {
  const parsed = parseJson(JSON.stringify({ operations }));

  return send(callers, who, "POST", CHANGE_SETS, {
    body: parsed.ok ? parsed.value : null,
  });
};

/**
 * A fresh local role, created by the administrator through the
 * change-set endpoint.
 *
 * @param callers - The fixture's callers.
 * @returns The role's ID and the change set's ID.
 */
const freshRole = (callers: Callers) =>
  Effect.gen(function* createFreshRole() {
    const role = createRole(`role_${randomUUID().slice(0, 8)}`);
    const id = role.op === "createRole" ? role.definition.id : "";
    const response = yield* postChangeSet(asBearer(callers), "admin", [role]);

    assert.strictEqual(response.status, 201, response.text);

    return { changeSetId: textOf(objectOf(response.json).id), id };
  });

const DEFINITION_ROWS: readonly DefinitionRow[] = [
  {
    admin: { status: 201 },
    alice: refused(403, "NotAllowed"),
    bob: refused(403, "NotAllowed"),
    path: "POST /applyChangeSet (create a local role)",
    run: (callers, who) =>
      postChangeSet(callers, who, [
        createRole(`role_${randomUUID().slice(0, 8)}`),
      ]).pipe(measuredWrite),
  },
  {
    admin: refused(403, "DefinitionProtected"),
    alice: refused(422, "DefinitionInvalid"),
    bob: refused(422, "DefinitionInvalid"),
    path: "POST /applyChangeSet (rename an app table; hidden is missing)",
    run: (callers, who) =>
      Effect.gen(function* renameApp() {
        const version = yield* definitionVersion(ACME.asset);

        return yield* measuredWrite(
          postChangeSet(callers, who, [
            { id: ACME.asset, name: "thing", op: "rename", version },
          ])
        );
      }),
  },
  {
    admin: { status: 200 },
    alice: refused(404, "NotFound"),
    bob: refused(404, "NotFound"),
    path: "GET /applyChangeSet/{id} (a committed change set)",
    run: (callers, who) =>
      Effect.gen(function* readChangeSet() {
        const { changeSetId } = yield* freshRole(callers);

        return yield* measuredWrite(
          send(callers, who, "GET", `${CHANGE_SETS}/${changeSetId}`)
        );
      }),
  },
  {
    admin: refused(404, "NotFound"),
    alice: refused(404, "NotFound"),
    bob: refused(404, "NotFound"),
    path: "GET /applyChangeSet/{random ID}",
    run: (callers, who) =>
      send(callers, who, "GET", `${CHANGE_SETS}/${randomUUID()}`).pipe(
        Effect.map(writeStatus)
      ),
  },
  {
    admin: { status: 201 },
    alice: refused(404, "UnknownTable"),
    bob: refused(404, "UnknownTable"),
    path: "POST /core.role (generic create, a one-operation change set)",
    run: (callers, who) =>
      send(callers, who, "POST", listPath("core.role"), {
        body: { label: "Generic", name: `role_${randomUUID().slice(0, 8)}` },
      }).pipe(measuredWrite),
  },
  {
    admin: { status: 200 },
    alice: refused(404, "UnknownTable"),
    bob: refused(404, "UnknownTable"),
    path: "PATCH /core.role/{local role} (label)",
    run: (callers, who) =>
      Effect.gen(function* relabelRole() {
        const { id } = yield* freshRole(callers);

        return yield* measuredWrite(
          send(callers, who, "PATCH", recordPath("core.role", id), {
            body: { label: "Relabelled" },
            headers: ifMatch(1),
          })
        );
      }),
  },
  {
    admin: { status: 200 },
    alice: refused(404, "UnknownTable"),
    bob: refused(404, "UnknownTable"),
    path: "PATCH /core.role/{local role} (retire)",
    run: (callers, who) =>
      Effect.gen(function* retireRole() {
        const { id } = yield* freshRole(callers);

        return yield* measuredWrite(
          send(callers, who, "PATCH", recordPath("core.role", id), {
            body: { state: "retired" },
            headers: ifMatch(1),
          })
        );
      }),
  },
  {
    admin: { status: 204 },
    alice: refused(404, "UnknownTable"),
    bob: refused(404, "UnknownTable"),
    path: "DELETE /core.role/{local role}",
    run: (callers, who) =>
      Effect.gen(function* deleteRole() {
        const { id } = yield* freshRole(callers);

        return yield* measuredWrite(
          send(callers, who, "DELETE", recordPath("core.role", id), {
            headers: ifMatch(1),
          })
        );
      }),
  },
  {
    admin: { status: 200 },
    alice: refused(404, "UnknownTable"),
    bob: refused(404, "UnknownTable"),
    path: "PATCH /core.class/{acme.asset} (label: a local override)",
    run: (callers, who) =>
      Effect.gen(function* relabelApp() {
        const version = yield* definitionVersion(ACME.asset);

        return yield* measuredWrite(
          send(callers, who, "PATCH", recordPath("core.class", ACME.asset), {
            body: { label: `Asset ${randomUUID().slice(0, 4)}` },
            headers: ifMatch(version),
          })
        );
      }),
  },
  {
    admin: refused(409, "UseRetireOrPurge"),
    alice: refused(404, "UnknownTable"),
    bob: refused(404, "UnknownTable"),
    path: "DELETE /core.field/{acme cost}",
    run: (callers, who) =>
      Effect.gen(function* deleteField() {
        const version = yield* definitionVersion(ACME.cost);

        return yield* measuredWrite(
          send(callers, who, "DELETE", recordPath("core.field", ACME.cost), {
            headers: ifMatch(version),
          })
        );
      }),
  },
  {
    admin: refused(403, "NotAllowed"),
    alice: refused(404, "UnknownTable"),
    bob: refused(404, "UnknownTable"),
    path: "POST /core.change (the history, never written generically)",
    run: (callers, who) =>
      send(callers, who, "POST", listPath("core.change"), {
        body: { kind: "update" },
      }).pipe(measuredWrite),
  },
];

const byName = (left: JsonValue, right: JsonValue): number => {
  const a = textOf(objectOf(left).name);
  const b = textOf(objectOf(right).name);

  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
};

/**
 * One caller's table list against the metadata of every candidate table:
 * the list holds exactly the tables whose metadata answers 200, with that
 * metadata's name, label and `creatable`; every other table is
 * `UnknownTable`. Every related list of those tables accepts the filter
 * the web app lists related records with.
 *
 * @param callers - The callers.
 * @param who - The caller.
 * @param candidates - Every table name, hidden ones included.
 */
const checkTableList = Effect.fn("AuthzPaths.checkTableList")(
  function* checkTableList(
    callers: Callers,
    who: Who,
    candidates: readonly string[]
  ) {
    const where = `${callers.transport} ${who}`;
    const listed = yield* send(callers, who, "GET", "/api/v1/tableMetadata");

    assert.strictEqual(listed.status, 200, where);

    const opened: JsonValue[] = [];
    const related: { table: string; field: string }[] = [];

    for (const name of candidates) {
      const meta = yield* send(
        callers,
        who,
        "GET",
        `/api/v1/tableMetadata/${collectionOf(name)}`
      );

      const table = objectOf(meta.json);

      if (meta.status === 200) {
        opened.push({
          creatable: table.creatable ?? null,
          label: table.label ?? null,
          name: table.name ?? null,
        });
        related.push(
          ...arrayOf(table.relatedLists).map((entry) => ({
            field: textOf(objectOf(entry).field),
            table: textOf(objectOf(entry).table),
          }))
        );
      } else {
        assert.deepStrictEqual(
          observe(meta),
          refused(404, "UnknownTable"),
          `${where}: ${name}`
        );
      }
    }

    const tables = arrayOf(listed.json).map((entry) => {
      const { creatable, label, name } = objectOf(entry);

      return {
        creatable: creatable ?? null,
        label: label ?? null,
        name: name ?? null,
      };
    });

    assert.deepStrictEqual(
      tables.toSorted(byName),
      opened.toSorted(byName),
      where
    );

    const names = tables.map((entry) => textOf(entry.name));

    assert.include(names, ASSET, where);

    if (who !== "admin") {
      assert.notInclude(names, "core.access_rule", where);
      assert.notInclude(names, "core.change", where);
    }

    assert.isAbove(related.length, 0, where);

    // The web app lists related records with this condition; every related
    // list the caller is shown must accept it.
    for (const entry of related) {
      const attribute = apiAttributeNameOf(entry.field);

      const page = yield* send(
        callers,
        who,
        "GET",
        listPath(entry.table, {
          condition: `${attribute} = "${randomUUID()}"`,
        })
      );

      assert.strictEqual(
        page.status,
        200,
        `${where}: ${entry.table}.${entry.field} ${page.text}`
      );
    }
  }
);

describe("authz-paths", () => {
  it("covers every Contracts 3.3 caller on every row", () => {
    for (const row of [...READ_ROWS, ...WRITE_ROWS]) {
      assert.isAtLeast(row.alice.status, 200, row.path);
      assert.isAtLeast(row.bob.status, 200, row.path);
    }
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "every read path, for Alice and Bob, by bearer token and by session cookie",
      () =>
        Effect.gen(function* readPaths() {
          for (const transport of TRANSPORTS) {
            const callers = yield* signInAllBy(transport);

            for (const row of READ_ROWS) {
              for (const who of ["alice", "bob"] as const) {
                const seen = yield* row.run(callers, who);

                assert.deepStrictEqual(
                  seen,
                  row[who],
                  `${transport} ${who}: ${row.path}`
                );
              }
            }
          }
        })
    );

    dbTest.effect(
      "metadata paths, for Alice, Bob, the admin and no session, by bearer token and by session cookie, commit nothing",
      () =>
        Effect.gen(function* metadataPaths() {
          const http = yield* TestHttpClient;

          for (const transport of TRANSPORTS) {
            const callers = yield* signInAllBy(transport);
            const before = yield* committedState;

            const admin = yield* metadataOf("core.access_rule")(
              callers,
              "admin"
            );

            assert.strictEqual(admin.status, 200, transport);
            assert.include(textOf(admin.detail), "condition:yes", transport);

            for (const path of [
              "/api/v1/tableMetadata/acmeAsset",
              "/api/v1/tableMetadata/acmeAsset/schema.json",
              "/api/v1/tableMetadata/acmeAsset/openapi.json",
            ]) {
              assert.strictEqual((yield* http.get(path)).status, 401, path);
            }

            for (const who of ["alice", "bob", "admin"] as const) {
              const missing = yield* metadataOf("acme.nosuch")(callers, who);

              assert.deepStrictEqual(
                missing,
                refused(404, "UnknownTable"),
                `${transport} ${who}`
              );
            }

            assert.deepStrictEqual(yield* committedState, before, transport);
          }
        })
    );

    dbTest.effect(
      "the table list holds exactly the tables whose metadata each caller gets, and every related list filters, by bearer token and by session cookie",
      () =>
        Effect.gen(function* tableListPaths() {
          const http = yield* TestHttpClient;
          const snapshot = yield* (yield* Catalog).refresh;

          // Every table name the database has, hidden and platform ones
          // included, and one that does not exist.
          const candidates = [
            ...snapshot.all("class").flatMap((entry) => {
              const name = snapshot.qualifiedNameOf(entry.id);

              return name === undefined ? [] : [name];
            }),
            "acme.nosuch",
          ];

          assert.strictEqual(
            (yield* http.get("/api/v1/tableMetadata")).status,
            401
          );

          for (const transport of TRANSPORTS) {
            const callers = yield* signInAllBy(transport);
            const before = yield* committedState;

            for (const who of ["alice", "bob", "admin"] as const) {
              yield* checkTableList(callers, who, candidates);
            }

            assert.deepStrictEqual(yield* committedState, before, transport);
          }
        })
    );

    dbTest.effect(
      "every write path, for Alice and Bob, by bearer token and by session cookie",
      () =>
        Effect.gen(function* writePaths() {
          // Every committed save of an asset writes a delivery row in its
          // transaction (Contracts 4.6); a refused one must leave none.
          const { alice } = yield* AcmeFixture;

          yield* subscribeToEverySave(ACME.asset, alice.id);

          for (const transport of TRANSPORTS) {
            const callers = yield* signInAllBy(transport);

            for (const row of WRITE_ROWS) {
              for (const who of ["alice", "bob"] as const) {
                const before = yield* deliveries();
                const seen = yield* row.run(callers, who);
                const written = (yield* deliveries()) - before;
                const where = `${transport} ${who}: ${row.path}`;

                assert.deepStrictEqual(seen, row[who], where);

                if (seen.status >= 400) {
                  assert.strictEqual(written, 0, `deliveries after ${where}`);
                } else if (row.path.includes("acme.")) {
                  assert.strictEqual(written, 1, `deliveries after ${where}`);
                }
              }
            }
          }
        })
    );

    dbTest.effect(
      "every definition and change-set path, for Alice, Bob and the admin, by bearer token and by session cookie",
      () =>
        Effect.gen(function* definitionPaths() {
          for (const transport of TRANSPORTS) {
            const callers = yield* signInAllBy(transport);

            for (const row of DEFINITION_ROWS) {
              for (const who of ["alice", "bob", "admin"] as const) {
                const seen = yield* row.run(callers, who);

                assert.deepStrictEqual(
                  seen,
                  row[who],
                  `${transport} ${who}: ${row.path}`
                );
              }
            }
          }
        })
    );

    dbTest.effect(
      "every write and definition path refuses the session cookie without STD-Client: web, committing nothing",
      () =>
        Effect.gen(function* forgedWrites() {
          const callers = {
            ...(yield* signInAllBy("cookie")),
            transport: "cookieWithoutHeader" as const,
          };

          const unauthenticated = refused(401, "Unauthenticated");

          // The write test's subscription to every asset save is in place,
          // so a committed save would write a delivery row; the definition
          // rows measure every committed table themselves.
          for (const row of WRITE_ROWS) {
            for (const who of ["alice", "bob"] as const) {
              const before = yield* deliveries();
              const seen = yield* row.run(callers, who);
              const where = `${who}: ${row.path}`;

              assert.deepStrictEqual(seen, unauthenticated, where);
              assert.strictEqual(
                yield* deliveries(),
                before,
                `deliveries after ${where}`
              );
            }
          }

          // A read needs no header: the cookie alone authenticates it.
          for (const row of DEFINITION_ROWS) {
            for (const who of ["alice", "bob", "admin"] as const) {
              const seen = yield* row.run(callers, who);

              assert.deepStrictEqual(
                seen,
                row.path.startsWith("GET ") ? row[who] : unauthenticated,
                `${who}: ${row.path}`
              );
            }
          }
        })
    );

    dbTest.effect(
      "a nested save from an after-write hook acts as the acting user",
      () =>
        Effect.gen(function* nestedSaves() {
          const callers = yield* signInAllBy("bearer");
          const { records } = callers.fixture;
          const bob = userOf(callers.fixture, "bob");
          const alice = userOf(callers.fixture, "alice");
          const outer = yield* fresh(callers, "bob", ACME.asset);
          const ownAsset = yield* fresh(callers, "bob", ACME.asset);
          const ownLaptop = yield* fresh(callers, "bob", ACME.laptop);
          const spare = { status: "spare" };

          // The write test's subscription to every asset save is in place,
          // so the outer save writes a delivery before its hook runs.
          const before = yield* deliveries();

          // Alice's monitor is invisible to Bob: NotFound, and nothing of
          // the outer save stays, its delivery row included.
          assert.deepStrictEqual(
            yield* nestedSave(bob, outer.id, records.AM, spare),
            { nested: ["NotFound"], outer: "refused" }
          );
          assert.strictEqual(yield* versionOf(outer.id), 1);
          assert.strictEqual(yield* versionOf(records.AM), 1);

          // Rule 9 refuses Bob a laptop's status, through the parent
          // endpoint too.
          assert.deepStrictEqual(
            yield* nestedSave(bob, outer.id, ownLaptop.id, spare),
            { nested: ["NotAllowed"], outer: "refused" }
          );
          assert.strictEqual(yield* versionOf(ownLaptop.id), 1);

          // A record the save is saving: RecordInSave.
          assert.deepStrictEqual(
            yield* nestedSave(bob, outer.id, outer.id, spare),
            { nested: ["RecordInSave"], outer: "refused" }
          );
          assert.strictEqual(yield* deliveries(), before);

          // Bob's own asset: saved, audited as Bob, in the same operation.
          assert.deepStrictEqual(
            yield* nestedSave(bob, outer.id, ownAsset.id, spare),
            { nested: ["saved"], outer: "saved" }
          );
          assert.strictEqual(yield* versionOf(ownAsset.id), 2);
          // One delivery for the outer save, one for the nested one.
          assert.strictEqual(yield* deliveries(), before + 2);
          assert.deepStrictEqual(
            yield* values(
              `SELECT count(DISTINCT operation_id)::text AS value FROM core."change"
               WHERE record_id IN ($1::uuid, $2::uuid) AND record_version = 2`,
              [outer.id, ownAsset.id]
            ),
            ["1"]
          );
          assert.deepStrictEqual(
            yield* values(
              `SELECT updated_by::text AS value FROM acme.asset WHERE id = $1::uuid`,
              [ownAsset.id]
            ),
            [bob]
          );

          // The same nested save as Alice, whose rules reach her monitor.
          const aliceOuter = yield* fresh(callers, "alice", ACME.asset);

          assert.deepStrictEqual(
            yield* nestedSave(alice, aliceOuter.id, records.AM, spare),
            { nested: ["saved"], outer: "saved" }
          );
        })
    );
  });
});
