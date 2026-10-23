/** Shared helpdesk v3 fixture and clients built from the live API definition. */
import { assert } from "@effect/vitest";
import { StdApi } from "@std/api/api";
import { BUILT_IN_ROLE_IDS } from "@std/definitions/well-known";
import { stringifyJson } from "@std/values/json";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { HttpApiClient } from "effect/http-api";

import {
  HelpdeskFixture,
  helpdeskTestLayer,
  HELPDESK,
} from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type {
  TestHttpClientApi,
  TestRequestOptions,
} from "../../testing/src/http-client.ts";
import { Actor } from "../src/auth/actor.ts";
import { ensureUser } from "../src/auth/bootstrap-admin.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { runUpgrade } from "../src/config/upgrade.ts";
import { RecordRuleSaveHooks } from "../src/hooks/record-rule-hooks.ts";
import { updateRecord } from "../src/records/save-pipeline.ts";
import { WriteAccess } from "../src/records/write-access.ts";
import { WriteOnlyValues } from "../src/records/write-only-values.ts";
import { asObject, textOf, numberOf } from "./api-support.ts";
import { addRecordRule } from "./schema-support.ts";
import { bodyOf, TICKETS, tmf621As } from "./tmf621-support.ts";

const account = (login: string, fixture: HelpdeskFixture["Service"]) => {
  if (login === "manager") {
    return { login: "itil-manager", password: "itil-manager-password" };
  }

  if (login === "agent2") {
    return fixture.agent2;
  }

  return login === "agent" ? fixture.agent : fixture.admin;
};

// Browser-like session reuse keeps record scenarios from repeatedly signing in.
// Keys are fixture HTTP clients, so independent test databases never share tokens.
const fixtureSessions = new WeakMap<
  object,
  Map<string, ReturnType<TestHttpClientApi["signIn"]>>
>();

const fixtureToken = Effect.fn("Itil.fixtureToken")(function* fixtureToken(
  login: string
) {
  const http = yield* TestHttpClient;
  const fixture = yield* HelpdeskFixture;

  const tokens =
    fixtureSessions.get(http) ??
    new Map<string, ReturnType<TestHttpClientApi["signIn"]>>();

  fixtureSessions.set(http, tokens);
  const existing = tokens.get(login);

  if (existing !== undefined) {
    return yield* existing;
  }

  const user = account(login, fixture);
  const token = yield* Effect.cached(http.signIn(user.login, user.password));
  tokens.set(login, token);

  return yield* token;
});

/** The shipped set, without a hard-coded transport prefix. */
export const HELPDESK_V3 = new URL(
  "../../../examples/helpdesk/v3",
  import.meta.url
).pathname;

/** A Step 2 helpdesk database upgraded to v3, with a major incident manager. */
export const upgradedHelpdesk = Layer.effectDiscard(
  Effect.gen(function* upgraded() {
    yield* runUpgrade({ sets: [HELPDESK_V3] });
    const snapshot = yield* (yield* Catalog).refresh;
    const role = snapshot.roleByName("major_incident_manager");

    if (role === undefined) {
      return yield* Effect.die(new Error("Missing manager role"));
    }

    yield* ensureUser(
      {
        login: "itil-manager",
        name: "Incident Manager",
        password: Redacted.make("itil-manager-password"),
      },
      [role.id]
    );

    return yield* Effect.void;
  })
).pipe(Layer.provideMerge(helpdeskTestLayer({ version: "v2" })));

/** Production HTTP app over an upgraded Step 2 database. */
export const itilLayer = TestHttpClient.layer.pipe(
  Layer.provideMerge(upgradedHelpdesk)
);

/** Record-service saves as the fixture admin, with production rules. */
export const recordServices = Layer.mergeAll(
  WriteAccess.allowAll,
  RecordRuleSaveHooks,
  WriteOnlyValues.unavailable,
  Layer.effect(
    Actor,
    Effect.gen(function* recordServices() {
      const fixture = yield* HelpdeskFixture;

      return Actor.of({
        roleIds: [BUILT_IN_ROLE_IDS.admin],
        userId: fixture.admin.id,
      });
    })
  )
);

/** Resolve a shipped field by name for local overrides and assertions. */
export const fieldId = Effect.fn("Itil.fieldId")(function* fieldId(
  name: string,
  table?: string
) {
  const snapshot = yield* (yield* Catalog).refresh;
  const classId = snapshot.classByName(table ?? "helpdesk.ticket")?.id ?? "";
  const field = snapshot.fields(classId).find((entry) => entry.name === name);

  if (field === undefined) {
    return yield* Effect.die(new Error(`Missing ${table}.${name}`));
  }

  return field.id;
});

const makeClient = Effect.fn("Itil.makeClient")(function* makeClient(
  login?: string
) {
  const http = yield* TestHttpClient;
  const token = yield* fixtureToken(login ?? "admin");

  return yield* HttpApiClient.makeWith(StdApi, {
    baseUrl: "http://std.test",
    httpClient: HttpClient.make((request, url) =>
      Effect.gen(function* httpClient() {
        const options: TestRequestOptions = { headers: request.headers, token };

        const response = yield* http.request(
          request.method,
          `${url.pathname}${url.search}`,
          request.body._tag === "Uint8Array"
            ? {
                ...options,
                rawBody: new TextDecoder().decode(request.body.body),
              }
            : options
        );

        return HttpClientResponse.fromWeb(
          request,
          new Response(response.text || null, {
            headers: response.headers,
            status: response.status,
          })
        );
      })
    ),
  });
});

// Generated clients share the fixture HTTP client's lifetime, as its sessions do.
const fixtureClients = new WeakMap<
  TestHttpClientApi,
  Map<string, ReturnType<typeof makeClient>>
>();

/** Use one generated API client per fixture HTTP client and login. */
export const clientFor = Effect.fn("Itil.client")(function* clientFor(
  login?: string
) {
  const http = yield* TestHttpClient;
  const key = login ?? "admin";

  const clients =
    fixtureClients.get(http) ??
    new Map<string, ReturnType<typeof makeClient>>();

  fixtureClients.set(http, clients);
  const existing = clients.get(key);

  if (existing !== undefined) {
    return yield* existing;
  }

  const client = yield* Effect.cached(makeClient(key));
  clients.set(key, client);

  return yield* client;
});

/** Make a ticket with a useful default description through the generic API. */
export const createTicket = Effect.fn("Itil.create")(function* createTicket(
  table:
    | "helpdeskIncident"
    | "helpdeskProblem"
    | "helpdeskTicket" = "helpdeskIncident",
  body: JsonObject = {},
  login?: string
) {
  const client = yield* clientFor(login);

  return asObject(
    yield* client.records.create({
      params: { table },
      payload: { description: "Service unavailable", ...body },
    })
  );
});

/** Patch at the latest version through the shared API, optionally through the parent collection. */
export const patchTicket = Effect.fn("Itil.patch")(function* patchTicket(
  record: JsonObject,
  body: JsonObject,
  table?: string,
  login?: string
) {
  const client = yield* clientFor(login);
  const id = textOf(record.id);

  const current = asObject(
    yield* client.records.get({
      params: { id, table: table ?? "helpdeskIncident" },
      query: {},
    })
  );

  return asObject(
    yield* client.records.patch({
      headers: { "if-match": `"${numberOf(current.revision)}"` },
      params: { id, table: table ?? "helpdeskIncident" },
      payload: body,
    })
  );
});

/** A resource reference.
 * @param record - The referenced resource.
 * @returns Its entity reference.
 */
export const reference = (record: JsonObject): JsonValue => ({
  id: textOf(record.id),
});

/** Request a patch and retain the error status for the transition matrix. */
export const patchResponse = Effect.fn("Itil.patchResponse")(
  function* patchResponse(
    record: JsonObject,
    body: JsonValue,
    table?: string,
    login?: string,
    contentType?: string
  ) {
    const http = yield* TestHttpClient;
    const token = yield* fixtureToken(login ?? "admin");

    const path = StdApi.groups.records.endpoints.patch.path
      .replace(":table", table ?? "helpdeskIncident")
      .replace(":id", textOf(record.id));

    return yield* http.request("PATCH", path, {
      headers: {
        "content-type": contentType ?? "application/merge-patch+json",
        "if-match": `"${numberOf(record.revision)}"`,
      },
      rawBody: stringifyJson(body),
      token,
    });
  }
);

/**
 * A local after rule writing a separate incident when one named incident changes.
 * @param triggerNumber - The triggering incident's stable ticket number.
 * @param targetNumber - The incident to update.
 * @param field - The field to write.
 * @param value - The assigned value.
 * @param runAsId - An explicit identity, or null for the acting user.
 * @returns The local rule's creation operation and ID.
 */
export const localIncidentWrite = (
  triggerNumber: string,
  targetNumber: string,
  field: string,
  value: JsonValue,
  runAsId: string | null = null
) =>
  addRecordRule(HELPDESK.incident, {
    actions: [
      {
        forEach: {
          classId: HELPDESK.incident,
          where: {
            left: { path: [HELPDESK.fields.number] },
            op: "eq",
            right: { value: targetNumber },
          },
        },
        target: "self",
        type: "updateEach",
        values: [{ fieldId: field, value: { value } }],
      },
    ],
    condition: {
      left: { path: [HELPDESK.fields.number] },
      op: "eq",
      right: { value: triggerNumber },
    },
    phase: "after",
    ruleKind: null,
    runAsId,
  });

/** All source/target pairs through the generic API, including refused writes. */
export const genericTransitions = Effect.fn("Itil.genericTransitions")(
  function* genericTransitions(
    table: "helpdeskIncident" | "helpdeskProblem",
    transitions: Readonly<Record<string, readonly string[]>>
  ) {
    const client = yield* clientFor();

    for (const [source, allowed] of Object.entries(transitions)) {
      for (const target of Object.keys(transitions)) {
        const record = yield* createTicket(table, { status: source });

        const response = yield* patchResponse(
          record,
          { status: target },
          table
        );

        if (source === target || allowed.includes(target)) {
          assert.strictEqual(
            response.status,
            200,
            `${source} -> ${target}: ${response.text}`
          );
          assert.strictEqual(asObject(response.json).status, target);
        } else {
          assert.strictEqual(
            response.status,
            422,
            `${source} -> ${target}: ${response.text}`
          );
          assert.strictEqual(asObject(response.json).code, "InvalidTransition");

          const unchanged = yield* client.records.get({
            params: { id: textOf(record.id), table },
            query: {},
          });

          assert.deepStrictEqual(
            [unchanged.status, unchanged.revision],
            [source, record.revision]
          );
        }
      }
    }
  }
);

/** TMF621 status writes use each class's independently specified state mapping. */
export const tmfTransitions = Effect.fn("Itil.tmfTransitions")(
  function* tmfTransitions(
    table: "helpdeskIncident" | "helpdeskProblem",
    transitions: Readonly<Record<string, readonly string[]>>,
    statusesOf: (source: string) => readonly (readonly [string, string])[]
  ) {
    const admin = yield* tmf621As("admin");

    for (const [source, allowed] of Object.entries(transitions)) {
      for (const [status, target] of statusesOf(source)) {
        const record = yield* createTicket(table, { status: source });
        const path = `${TICKETS}/${textOf(record.id)}`;
        const accepted = source === target || allowed.includes(target);
        const before = accepted ? undefined : bodyOf(yield* admin.get(path));
        const response = yield* admin.patch(path, { status });
        assert.strictEqual(
          response.status,
          accepted ? 200 : 400,
          `${source} -> ${status}: ${response.text}`
        );

        if (accepted) {
          assert.strictEqual(bodyOf(response).status, status);
        } else {
          assert.strictEqual(asObject(response.json).code, "InvalidTransition");
          assert.deepStrictEqual(bodyOf(yield* admin.get(path)), before);
        }
      }
    }
  }
);

/** Settled saves bypass every guard installed on the shipped class. */
export const settledTransitions = Effect.fn("Itil.settledTransitions")(
  function* settledTransitions(
    table: "helpdeskIncident" | "helpdeskProblem",
    className: "helpdesk.incident" | "helpdesk.problem",
    guardCount: number
  ) {
    const record = yield* createTicket(table, { status: "closed" });
    const snapshot = yield* (yield* Catalog).refresh;
    const definition = snapshot.classByName(className);

    if (definition === undefined) {
      throw new Error(`Missing ${className} class`);
    }

    assert.strictEqual(
      snapshot
        .recordRulesOf(definition.id)
        .filter((rule) => rule.ruleKind === "guard").length,
      guardCount
    );

    const saved = yield* updateRecord({
      body: { status: "new" },
      endpointClassId: definition.id,
      expectedVersion: null,
      id: textOf(record.id),
      mode: "settled",
    }).pipe(Effect.provide(recordServices));

    assert.strictEqual(asObject(saved.record?.values).status, "new");
  }
);
