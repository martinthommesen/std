/** Shared helpdesk v3 fixture and clients built from the live API definition. */
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
import type { TestRequestOptions } from "../../testing/src/http-client.ts";
import { Actor } from "../src/auth/actor.ts";
import { ensureUser } from "../src/auth/bootstrap-admin.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { runUpgrade } from "../src/config/upgrade.ts";
import { RecordRuleSaveHooks } from "../src/hooks/record-rule-hooks.ts";
import { WriteAccess } from "../src/records/write-access.ts";
import { WriteOnlyValues } from "../src/records/write-only-values.ts";
import { asObject, textOf, numberOf } from "./api-support.ts";
import { addRecordRule } from "./schema-support.ts";

const account = (login: string, fixture: HelpdeskFixture["Service"]) => {
  if (login === "manager") {
    return { login: "itil-manager", password: "itil-manager-password" };
  }

  if (login === "agent2") {
    return fixture.agent2;
  }

  return login === "agent" ? fixture.agent : fixture.admin;
};

/** The shipped set, without a hard-coded transport prefix. */
export const HELPDESK_V3 = new URL(
  "../../../examples/helpdesk/v3",
  import.meta.url
).pathname;

const upgraded = Layer.effectDiscard(
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
  Layer.provideMerge(upgraded)
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

/** Use the shared HttpApi's generated methods; its path is the only source of truth. */
export const clientFor = Effect.fn("Itil.client")(function* clientFor(
  login?: string
) {
  const http = yield* TestHttpClient;
  const fixture = yield* HelpdeskFixture;
  const user = account(login ?? "admin", fixture);
  const token = yield* http.signIn(user.login, user.password);

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
    const fixture = yield* HelpdeskFixture;
    const user = account(login ?? "admin", fixture);
    const token = yield* http.signIn(user.login, user.password);

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
