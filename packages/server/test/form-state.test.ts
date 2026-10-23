/** The non-persisting, caller-masked form verdict (Contracts 5.10, 6.3). */
import { assert, describe, it } from "@effect/vitest";
import { StdApi } from "@std/api/api";
import { FormStateRequest } from "@std/api/form-state";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Exit, Result, Schema } from "effect";
import { TestClock } from "effect/testing";

import {
  HELPDESK,
  HelpdeskFixture,
} from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { editDefinition } from "../src/config/config-service.ts";
import { runUpgrade } from "../src/config/upgrade.ts";
import { revisionHeaderValue } from "../src/http/schema-revision-header.ts";
import { asObject, numberOf, textOf } from "./api-support.ts";
import {
  HELPDESK_V3,
  clientFor,
  createTicket,
  itilLayer,
  patchTicket,
} from "./itil-support.ts";
import { addAccessRule, change } from "./schema-support.ts";

const preview = Effect.fn("FormTest.preview")(function* preview(
  values: Readonly<Record<string, JsonValue>>,
  login?: string
) {
  const client = yield* clientFor(login);

  return yield* client.records.formState({
    payload: { id: null, revision: null, table: "helpdeskIncident", values },
  });
});

describe("form-state", () => {
  it("documents one task resource and validates the proposal envelope", () => {
    assert.strictEqual(
      StdApi.groups.records.endpoints.formState.path,
      "/api/v1/checkFormState"
    );
    assert.isTrue(
      Result.isSuccess(
        Schema.decodeResult(FormStateRequest)({
          id: null,
          revision: null,
          table: "helpdeskIncident",
          values: { impact: "1" },
        })
      )
    );
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(FormStateRequest)({
          table: "helpdeskIncident",
          values: {},
        })
      )
    );
  });
  it.effect(
    "derives the proposed priority, returns all field states, and saves no record",
    () =>
      Effect.gen(function* formCase1() {
        const client = yield* clientFor();

        const before = yield* client.records.list({
          params: { table: "helpdeskIncident" },
          query: {},
        });

        const verdict = yield* preview({ impact: "1", urgency: "1" });
        assert.strictEqual(verdict.values.priority, "1");
        assert.strictEqual(verdict.fields.priority?.readOnly, true);
        assert.strictEqual(verdict.fields.description?.required, true);

        assert.strictEqual(verdict.fields.majorIncident?.hidden, false);
        assert.strictEqual(verdict.fields.resolutionCode?.required, false);

        const resolving = yield* preview({
          impact: "3",

          status: "resolved",
          urgency: "3",
        });

        assert.strictEqual(resolving.values.priority, "5");
        assert.strictEqual(resolving.fields.resolutionCode?.required, true);
        assert.strictEqual(resolving.fields.resolutionNotes?.required, true);
        assert.strictEqual(resolving.fields.majorIncident?.hidden, true);

        const after = yield* client.records.list({
          params: { table: "helpdeskIncident" },
          query: {},
        });

        assert.deepStrictEqual(after, before);
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "versioned proposals use the concrete class through a parent and never change the stored version",
    () =>
      Effect.gen(function* formCase2() {
        const client = yield* clientFor();

        const record = yield* createTicket("helpdeskIncident", {
          impact: "1",
          urgency: "1",
        });

        const id = textOf(record.id);

        const revision = numberOf(record.revision);

        const verdict = yield* client.records.formState({
          payload: {
            id,
            revision,

            table: "helpdeskTicket",
            values: { impact: "3", urgency: "3" },
          },
        });

        assert.strictEqual(verdict.values.priority, "5");
        assert.strictEqual(verdict.fields.majorIncident?.hidden, true);
        assert.strictEqual(verdict.revision, revision);

        const read = yield* client.records.get({
          params: { id, table: "helpdeskIncident" },
          query: {},
        });

        assert.strictEqual(read.priority, "1");

        assert.strictEqual(read.revision, revision);
        yield* patchTicket(record, { description: "A concurrent edit" });

        const stale = yield* client.records

          .formState({
            payload: { id, revision, table: "helpdeskIncident", values: {} },
          })

          .pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(stale));
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "masks unreadable fields on proposals and derives a note author without an editable picker",
    () =>
      Effect.gen(function* formCase3() {
        const fixture = yield* HelpdeskFixture;
        const agent = yield* clientFor("agent");

        const record = yield* createTicket("helpdeskIncident", {
          internalCost: "900.00",
        });

        const id = textOf(record.id);

        const verdict = yield* agent.records.formState({
          payload: { id, revision: 1, table: "helpdeskIncident", values: {} },
        });

        assert.isFalse(Object.hasOwn(verdict.values, "internalCost"));
        assert.isFalse(Object.hasOwn(verdict.fields, "internalCost"));

        const owned = yield* createTicket("helpdeskIncident", {
          assignedTo: { id: fixture.agent.id },
          customerEmail: "caller@example.test",
        });

        const unassigned = yield* agent.records.formState({
          payload: {
            id: textOf(owned.id),
            revision: 1,
            table: "helpdeskIncident",
            values: { assignedTo: null },
          },
        });

        assert.isFalse(Object.hasOwn(unassigned.fields, "customerEmail"));
        assert.isFalse(Object.hasOwn(unassigned.values, "customerEmail"));

        const note = yield* agent.records.formState({
          payload: {
            id: null,
            revision: null,
            table: "helpdeskTicketNote",
            values: {},
          },
        });

        assert.strictEqual(note.fields.author?.readOnly, true);
        assert.strictEqual(note.values.author, fixture.agent.id);

        const denied = yield* agent.records
          .formState({
            payload: {
              id,
              revision: 1,
              table: "helpdeskIncident",
              values: { internalCost: "1" },
            },
          })
          .pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(denied));
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );
  it.effect(
    "checks existing and proposed access, then hides a denied record's version",
    () =>
      Effect.gen(function* accessOrdering() {
        const fixture = yield* HelpdeskFixture;
        const http = yield* TestHttpClient;

        const token = yield* http.signIn(
          fixture.agent.login,
          fixture.agent.password
        );

        const assigned = yield* createTicket("helpdeskIncident", {
          assignedTo: { id: fixture.agent2.id },
        });

        const unassigned = yield* createTicket();

        const previewRecord = (
          id: string,
          values: Readonly<Record<string, JsonValue>>,
          revision = 1
        ) =>
          http.request("POST", "/api/v1/checkFormState", {
            body: { id, revision, table: "helpdeskIncident", values },
            token,
          });

        const existingDenied = yield* previewRecord(textOf(assigned.id), {
          description: "Not mine",
        });

        assert.strictEqual(existingDenied.status, 403, existingDenied.text);

        const proposedDenied = yield* previewRecord(textOf(unassigned.id), {
          assignedTo: { id: fixture.agent2.id },
        });

        assert.strictEqual(proposedDenied.status, 403, proposedDenied.text);

        const fieldDenied = yield* previewRecord(textOf(unassigned.id), {
          majorIncident: true,
        });

        assert.strictEqual(fieldDenied.status, 403, fieldDenied.text);
        const snapshot = yield* (yield* Catalog).refresh;
        const agentRole = snapshot.roleByName("agent");
        assert.isDefined(agentRole);
        const hidden = addAccessRule(HELPDESK.ticket, [agentRole?.id ?? ""]);

        yield* hidden.op.op === "createAccessRule"
          ? change([
              {
                ...hidden.op,
                definition: {
                  ...hidden.op.definition,
                  condition: null,
                  effect: "deny",
                },
              },
            ])
          : Effect.die(new Error("Expected an access rule"));

        const denied = yield* previewRecord(textOf(assigned.id), {}, 999);
        assert.strictEqual(denied.status, 404, denied.text);
        assert.strictEqual(textOf(asObject(denied.json).code), "NotFound");
        assert.notInclude(denied.text, "currentVersion");
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "checks stale metadata even when the proposal does not name the changed field",
    () =>
      Effect.gen(function* staleMetadata() {
        const fixture = yield* HelpdeskFixture;
        const http = yield* TestHttpClient;
        const catalog = yield* Catalog;

        const token = yield* http.cookieSignIn(
          fixture.admin.login,
          fixture.admin.password
        );

        const built = yield* catalog.refresh;
        const headers = { "std-schema-revision": revisionHeaderValue(built) };

        const body = {
          id: null,
          revision: null,
          table: "helpdeskIncident",
          values: {},
        };

        const before = yield* http.request("POST", "/api/v1/checkFormState", {
          body,
          cookie: token,
          headers,
        });

        assert.strictEqual(before.status, 200, before.text);
        assert.strictEqual(before.headers.get("cache-control"), "no-store");
        yield* change([
          {
            changes: { required: true },
            id: HELPDESK.fields.description,
            op: "update",
            version: built.field(HELPDESK.fields.description)?.version ?? 1,
          },
        ]);

        const stale = yield* http.request("POST", "/api/v1/checkFormState", {
          body,
          cookie: token,
          headers,
        });

        assert.strictEqual(stale.status, 409, stale.text);
        assert.strictEqual(textOf(asObject(stale.json).code), "SchemaChanged");

        const withoutClient = yield* http.request(
          "POST",
          "/api/v1/checkFormState",
          { body, cookie: token, webClient: false }
        );

        assert.strictEqual(withoutClient.status, 401, withoutClient.text);
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );
  it.effect(
    "a local form override survives an unchanged set upgrade without changing API acceptance",
    () =>
      Effect.gen(function* localFormOverride() {
        const fixture = yield* HelpdeskFixture;
        const snapshot = yield* (yield* Catalog).refresh;

        const rule = snapshot
          .all("formRule")
          .find((entry) => entry.name === "priority_locked");

        assert.isDefined(rule);

        if (rule === undefined) {
          return yield* Effect.die(new Error("Missing shipped form rule"));
        }

        yield* editDefinition({
          actorId: fixture.admin.id,
          changes: { active: false },
          id: rule.id,
          version: rule.version,
        });
        yield* runUpgrade({ sets: [HELPDESK_V3] });
        const verdict = yield* preview({ impact: "1", urgency: "1" });
        assert.strictEqual(verdict.fields.priority?.readOnly, false);

        const record = yield* createTicket("helpdeskIncident", {
          impact: "1",
          priority: "5",
          urgency: "1",
        });

        assert.strictEqual(record.priority, "5");

        return yield* Effect.void;
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );
});
