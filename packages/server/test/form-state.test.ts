/** The non-persisting, caller-masked form verdict (Contracts 5.10, 6.3). */
import { randomUUID } from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import { StdApi } from "@std/api/api";
import { FormStateRequest } from "@std/api/form-state";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Exit, Result, Schema } from "effect";

import {
  HELPDESK,
  HelpdeskFixture,
} from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestRequestOptions } from "../../testing/src/http-client.ts";
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
import {
  addAccessRule,
  addField,
  addRecordRule,
  createClass,
  ensureSite,
  change,
  values as sqlValues,
} from "./schema-support.ts";
import { create, patch, savedOf } from "./writes-support.ts";

const checkFormState = Effect.fn("FormTest.checkFormState")(
  function* checkFormState(options: TestRequestOptions) {
    const http = yield* TestHttpClient;

    return yield* http.request(
      "POST",
      StdApi.groups.records.endpoints.formState.path,
      options
    );
  }
);

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
  it.live(
    "part proposals match save owner refusals for notes and parties, and empty proposals are read-only",
    () =>
      Effect.gen(function* partOwnerOracle() {
        const fixture = yield* HelpdeskFixture;
        const http = yield* TestHttpClient;

        const admin = yield* http.signIn(
          fixture.admin.login,
          fixture.admin.password
        );

        const agent = yield* http.signIn(
          fixture.agent.login,
          fixture.agent.password
        );

        const ticket = yield* createTicket("helpdeskIncident", {
          assignedTo: { id: fixture.agent2.id },
        });

        const [party] = yield* sqlValues(
          'SELECT individual::text AS value FROM core."user" WHERE id = $1::uuid',
          [fixture.agent2.id]
        );

        for (const part of [
          {
            body: { text: "Admin's note", ticket: { id: textOf(ticket.id) } },
            edit: { text: "Agent's edit" },
            name: "helpdesk.ticket_note",
            table: "helpdeskTicketNote",
          },
          {
            body: {
              party: { id: party ?? "" },
              role: "reporter",
              ticket: { id: textOf(ticket.id) },
            },
            edit: { role: "contact" },
            name: "helpdesk.ticket_party",
            table: "helpdeskTicketParty",
          },
        ]) {
          const created = yield* create(admin, part.name, part.body);
          assert.strictEqual(created.status, 201, created.text);
          const record = yield* savedOf(created);

          const checkedCreate = yield* checkFormState({
            body: {
              id: null,
              revision: null,
              table: part.table,
              values: part.body,
            },
            token: agent,
          });

          const savedCreate = yield* create(agent, part.name, part.body);
          assert.strictEqual(checkedCreate.status, 403, checkedCreate.text);
          assert.strictEqual(savedCreate.status, checkedCreate.status);
          assert.strictEqual(checkedCreate.text, savedCreate.text);
          assert.strictEqual(asObject(checkedCreate.json).refusedOn, "owner");

          // A stale revision still refuses the owner before revealing a version.
          for (const revision of [record.version, record.version + 1]) {
            const checkedEdit = yield* checkFormState({
              body: {
                id: record.id,
                revision,
                table: part.table,
                values: part.edit,
              },
              token: agent,
            });

            const savedEdit = yield* patch(
              agent,
              part.name,
              record.id,
              revision,
              part.edit
            );

            assert.strictEqual(checkedEdit.status, 403, checkedEdit.text);
            assert.strictEqual(savedEdit.status, checkedEdit.status);
            assert.strictEqual(checkedEdit.text, savedEdit.text);
          }

          const emptySave = yield* patch(
            agent,
            part.name,
            record.id,
            record.version,
            {}
          );

          assert.strictEqual(emptySave.text, checkedCreate.text);
          const client = yield* clientFor("agent");

          const verdict = yield* client.records.formState({
            payload: {
              id: record.id,
              revision: record.version,
              table: part.table,
              values: {},
            },
          });

          assert.isNotEmpty(Object.keys(verdict.fields));
          assert.isTrue(
            Object.values(verdict.fields).every((field) => field.readOnly)
          );
          assert.deepStrictEqual(verdict.messages, [
            "You can view this record but not change it.",
          ]);
          assert.strictEqual(verdict.revision, record.version);
          assert.strictEqual(verdict.values.ticket, textOf(ticket.id));
        }
      }).pipe(Effect.provide(itilLayer))
  );

  it.live(
    "an empty proposal for a colleague's incident returns masked read-only states, while an edit is still refused",
    () =>
      Effect.gen(function* readOnlyIncident() {
        const fixture = yield* HelpdeskFixture;
        const agent = yield* clientFor("agent");

        const record = yield* createTicket("helpdeskIncident", {
          assignedTo: { id: fixture.agent2.id },
          internalCost: "9876.54",
        });

        const payload = {
          id: textOf(record.id),
          revision: numberOf(record.revision),
          table: "helpdeskIncident",
          values: {},
        };

        const verdict = yield* agent.records.formState({ payload });
        assert.isNotEmpty(Object.keys(verdict.fields));
        assert.isTrue(
          Object.values(verdict.fields).every((field) => field.readOnly)
        );
        assert.deepStrictEqual(verdict.messages, [
          "You can view this record but not change it.",
        ]);
        assert.isFalse(Object.hasOwn(verdict.fields, "internalCost"));
        assert.isFalse(Object.hasOwn(verdict.values, "internalCost"));
        assert.strictEqual(verdict.revision, record.revision);

        const denied = yield* agent.records
          .formState({
            payload: {
              ...payload,
              values: { description: "Attempted change" },
            },
          })
          .pipe(Effect.result);

        assert.isTrue(Result.isFailure(denied));
        const client = yield* clientFor();

        const unchanged = yield* client.records.get({
          params: { id: payload.id, table: payload.table },
          query: {},
        });

        assert.deepStrictEqual(unchanged, record);
      }).pipe(Effect.provide(itilLayer))
  );

  it.live(
    "invalid proposal envelopes name the key path without echoing the submitted value",
    () =>
      Effect.gen(function* privateDecoder() {
        const fixture = yield* HelpdeskFixture;
        const http = yield* TestHttpClient;

        const token = yield* http.signIn(
          fixture.agent.login,
          fixture.agent.password
        );

        for (const [key, value] of Object.entries({
          id: "private-record-id",
          revision: "private-revision",
          table: { private: "private-table" },
          values: "private-values",
        })) {
          const reply = yield* checkFormState({
            body: {
              id: null,
              revision: null,
              table: "helpdeskIncident",
              values: {},
              [key]: value,
            },
            token,
          });

          assert.strictEqual(reply.status, 400);
          assert.include(reply.text, `body.${key}`);
          assert.notInclude(reply.text, "private-");
        }
      }).pipe(Effect.provide(itilLayer))
  );

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
  it.live(
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
      }).pipe(Effect.provide(itilLayer))
  );

  it.live(
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
      }).pipe(Effect.provide(itilLayer))
  );

  it.live(
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
      }).pipe(Effect.provide(itilLayer))
  );
  it.live(
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
          checkFormState({
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

        const hidden = addAccessRule(
          HELPDESK.ticket,
          [agentRole?.id ?? ""],
          {},
          { effect: "deny" }
        );

        yield* change([hidden.op]);

        const denied = yield* previewRecord(textOf(assigned.id), {}, 999);
        assert.strictEqual(denied.status, 404, denied.text);
        assert.strictEqual(textOf(asObject(denied.json).code), "NotFound");
        assert.notInclude(denied.text, "currentVersion");
      }).pipe(Effect.provide(itilLayer))
  );

  it.live(
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

        const before = yield* checkFormState({
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

        const stale = yield* checkFormState({
          body,
          cookie: token,
          headers,
        });

        assert.strictEqual(stale.status, 409, stale.text);
        assert.strictEqual(textOf(asObject(stale.json).code), "SchemaChanged");

        const withoutClient = yield* checkFormState({
          body,
          cookie: token,
          webClient: false,
        });

        assert.strictEqual(withoutClient.status, 401, withoutClient.text);
      }).pipe(Effect.provide(itilLayer))
  );
  it.live(
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
      }).pipe(Effect.provide(itilLayer))
  );
  it.live("hidden values cannot change a form-state outcome", () =>
    Effect.gen(function* hiddenOracle() {
      const amount = addField(HELPDESK.ticket, "visible_amount", {
        kind: "decimal",
        precision: 12,
        scale: 2,
      });

      yield* change([
        amount.op,
        {
          definition: {
            active: true,
            classId: HELPDESK.incident,
            condition: {
              left: { path: [amount.id] },
              op: "eq",
              right: { path: [HELPDESK.fields.internalCost] },
            },
            fieldId: HELPDESK.fields.shortDescription,
            id: randomUUID(),
            kind: "formRule",
            name: "hidden_oracle",
            order: 100,
            owner: { layer: "local" },
            property: "readOnly",
            protected: false,
            value: true,
          },
          op: "createFormRule",
        },
      ]);

      const created = yield* createTicket("helpdeskIncident", {
        internalCost: "101.00",
        visibleAmount: "101.00",
      });

      const id = textOf(created.id);
      const agent = yield* clientFor("agent");

      const before = yield* agent.records.formState({
        payload: { id, revision: 1, table: "helpdeskIncident", values: {} },
      });

      const saved = yield* patchTicket(created, { internalCost: "202.00" });

      const after = yield* agent.records.formState({
        payload: {
          id,
          revision: numberOf(saved.revision),
          table: "helpdeskIncident",
          values: {},
        },
      });

      assert.deepStrictEqual(after.fields, before.fields);
      assert.deepStrictEqual(after.values, before.values);
      assert.deepStrictEqual(after.messages, before.messages);
      assert.strictEqual(before.fields.shortDescription?.readOnly, false);
      assert.isFalse(Object.hasOwn(after.values, "internalCost"));
    }).pipe(Effect.provide(itilLayer))
  );

  it.live(
    "a denied edit gets the save's exact refusal and reveals no conditionally readable derived output",
    () =>
      Effect.gen(function* deniedOracle() {
        const output = addField(HELPDESK.ticket, "oracle_output", {
          kind: "text",
        });

        const hidden = addAccessRule(
          HELPDESK.ticket,
          [HELPDESK.agentRole],
          {
            condition: {
              arg: {
                left: { path: [HELPDESK.fields.status] },
                op: "eq",
                right: { value: "in_progress" },
              },
              op: "not",
            },
            fields: [output.id],
          },
          { effect: "deny" }
        );

        const denied = addAccessRule(
          HELPDESK.ticket,
          [HELPDESK.agentRole],
          {
            fields: [HELPDESK.fields.status],
          },
          { actions: ["update"], effect: "deny" }
        );

        yield* change([
          output.op,
          hidden.op,
          denied.op,
          addRecordRule(HELPDESK.incident, {
            actions: [
              {
                type: "set",
                values: [
                  {
                    fieldId: output.id,
                    value: { value: "private-derived-output" },
                  },
                ],
              },
            ],
            ruleKind: "derive",
          }).op,
        ]);
        const record = yield* createTicket();
        const fixture = yield* HelpdeskFixture;
        const http = yield* TestHttpClient;

        const token = yield* http.signIn(
          fixture.agent.login,
          fixture.agent.password
        );

        const values = { status: "in_progress" };

        const admin = yield* clientFor();

        const permitted = yield* admin.records.formState({
          payload: {
            id: textOf(record.id),
            revision: 1,
            table: "helpdeskIncident",
            values,
          },
        });

        assert.strictEqual(
          permitted.values.oracleOutput,
          "private-derived-output"
        );

        const check = yield* checkFormState({
          body: {
            id: textOf(record.id),
            revision: 1,
            table: "helpdeskIncident",
            values,
          },
          token,
        });

        const save = yield* patch(
          token,
          "helpdesk.incident",
          textOf(record.id),
          1,
          values
        );

        assert.strictEqual(check.status, 403, check.text);
        assert.strictEqual(save.status, check.status, save.text);
        assert.deepStrictEqual(check.json, save.json);
        assert.notInclude(check.text, "private-derived-output");
        assert.notInclude(check.text, "oracleOutput");

        return yield* Effect.void;
      }).pipe(Effect.provide(itilLayer))
  );

  it.live(
    "derive-added existing access is checked before invalid supplied values, just as on save",
    () =>
      Effect.gen(function* deriveAccessOrdering() {
        const record = yield* createTicket();
        const snapshot = yield* (yield* Catalog).refresh;

        const major = snapshot
          .fields(HELPDESK.incident)
          .find((field) => field.name === "major_incident");

        if (major === undefined) {
          return yield* Effect.die(new Error("Missing major flag"));
        }

        yield* change([
          addRecordRule(HELPDESK.incident, {
            actions: [
              {
                type: "set",
                values: [{ fieldId: major.id, value: { value: true } }],
              },
            ],
            ruleKind: "derive",
          }).op,
        ]);
        const fixture = yield* HelpdeskFixture;
        const http = yield* TestHttpClient;

        const token = yield* http.signIn(
          fixture.agent.login,
          fixture.agent.password
        );

        const values = { priority: "invalid-choice" };

        const check = yield* checkFormState({
          body: {
            id: textOf(record.id),
            revision: 1,
            table: "helpdeskIncident",
            values,
          },
          token,
        });

        const save = yield* patch(
          token,
          "helpdesk.incident",
          textOf(record.id),
          1,
          values
        );

        assert.strictEqual(check.status, 403, check.text);
        assert.strictEqual(save.status, check.status, save.text);
        assert.deepStrictEqual(check.json, save.json);

        return yield* Effect.void;
      }).pipe(Effect.provide(itilLayer))
  );

  it.live(
    "a required password with a form rule accepts presence without decoding a surrogate credential",
    () =>
      Effect.gen(function* passwordPresence() {
        yield* ensureSite;
        const table = createClass("credential_form");

        const password = addField(
          table.id,
          "password",
          { kind: "password" },
          { required: true }
        );

        const label = addField(table.id, "label", {
          kind: "text",
          maxLength: 1,
        });

        yield* change([
          table.op,
          password.op,
          label.op,
          {
            definition: {
              active: true,
              classId: table.id,
              condition: {
                arg: { arg: { path: [password.id] }, op: "empty" },
                op: "not",
              },
              fieldId: label.id,
              id: randomUUID(),
              kind: "formRule",
              name: "password_present",
              order: 0,
              owner: { layer: "local" },
              property: "required",
              protected: false,
              value: true,
            },
            op: "createFormRule",
          },
        ]);
        const client = yield* clientFor();

        const verdict = yield* client.records.formState({
          payload: {
            id: null,
            revision: null,
            table: "siteCredentialForm",
            values: { label: "x", password: { set: true } },
          },
        });

        assert.strictEqual(verdict.fields.label?.required, true);
        assert.isFalse(Object.hasOwn(verdict.values, "password"));
      }).pipe(Effect.provide(itilLayer))
  );

  it.live(
    "invalid proposal envelopes keep the failing key in the HTTP error",
    () =>
      Effect.gen(function* invalidEnvelope() {
        const fixture = yield* HelpdeskFixture;
        const http = yield* TestHttpClient;

        const token = yield* http.signIn(
          fixture.admin.login,
          fixture.admin.password
        );

        const response = yield* checkFormState({
          body: {
            id: null,
            revision: "invalid",
            table: "helpdeskIncident",
            values: {},
          },
          token,
        });

        assert.strictEqual(response.status, 400, response.text);
        assert.include(response.text, "revision");
      }).pipe(Effect.provide(itilLayer))
  );
});
