/**
 * `config-events` (Contracts 4.6 config subscriptions; the Step 3 part of
 * Contracts 14's `config-events`, before workstream 4D's TMF672 hub
 * renders them): subscriptions on the config kinds `role` and `accessRule`
 * get one delivery per definition version from admin change sets, generic
 * writes on the definition tables, override edits of a shipped role and a
 * set load (`std upgrade` loads sets this way), in each definition's version
 * order and in commit order; an access-rule change bumps the version of
 * each role it names, before or after; a change set that fails after its
 * role write leaves no delivery.
 *
 * A test handler stands in for the hub: it records each payload.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { Operation } from "@std/definitions/operation";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import { Effect, Layer, Ref, Schema } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { editDefinition } from "../src/config/config-service.ts";
import { loadSetDirectory } from "../src/config/load-set.ts";
import { CORE_SET_DIRECTORY } from "../src/config/set-files.ts";
import type { Delivery } from "../src/outbox/delivery-effects.ts";
import { workerPass } from "../src/outbox/worker.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import { signInAll } from "./authz-support.ts";
import { deliveriesWhere, subscribe } from "./outbox-support.ts";
import {
  ACME,
  addAccessRule,
  addRole,
  change,
  values,
} from "./schema-support.ts";
import { serveOnly, workerTestLayer } from "./worker-support.ts";

const HELPDESK_V2 = new URL("../../../examples/helpdesk/v2", import.meta.url)
  .pathname;

/** The role `agent` of the helpdesk set. */
const AGENT_ROLE = "a07fb4d5-0d16-4837-80a4-60582b7210ff";

/** The deliberate failure of the rolled-back change set. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
class Interrupted extends Schema.TaggedError<
  Interrupted,
  { readonly brand: unique symbol }
>()("Interrupted", {}) {}

/** One delivered config event, as the test compares them. */
interface Event {
  readonly recordId: string;
  readonly version: number;
  readonly kind: string;
}

const eventOf = (delivery: Delivery): Event => ({
  kind: delivery.payload.kind,
  recordId: delivery.recordId,
  version: delivery.recordVersion,
});

// Runs worker passes until nothing is left to claim.
const drain = Effect.gen(function* drainOutbox() {
  let claimed = yield* workerPass();

  while (claimed > 0) {
    claimed = yield* workerPass();
  }
});

const storedVersion = (table: string, id: string) =>
  values(
    `SELECT version::text AS value FROM core.${table} WHERE id = $1::uuid`,
    [id]
  ).pipe(Effect.map(([version]) => Number(version)));

const versionsOf = (events: readonly Event[], recordId: string) =>
  events.flatMap((event) =>
    event.recordId === recordId ? [event.version] : []
  );

const consecutive = (versions: readonly number[]): boolean =>
  versions.every((version, index) => version === index + 1);

const configEvents = Effect.gen(function* configEventsTest() {
  const fixture = yield* AcmeFixture;
  const http = yield* TestHttpClient;
  const { tokens } = yield* signInAll;
  const admin = fixture.admin.id;
  const delivered = yield* Ref.make<readonly Delivery[]>([]);

  const roles = yield* subscribe({
    classId: PLATFORM_CLASS_IDS.role,
    identityId: admin,
    operations: ["create", "update"],
  });

  const rules = yield* subscribe({
    classId: PLATFORM_CLASS_IDS.access_rule,
    identityId: admin,
    operations: ["create", "update"],
  });

  const record = (delivery: Delivery) =>
    Ref.update(delivered, (all) => [...all, delivery]);

  yield* serveOnly(roles, { kind: "external", run: record });

  // 1. An admin change set creates role R: version 1.
  const r = addRole("auditor");
  yield* change([r.op]);

  // 2. A generic write relabels it (a one-operation change set): 2.
  const relabelled = yield* http.request(
    "PATCH",
    `/api/v1/tables/core.role/records/${r.id}`,
    {
      body: { label: "Auditor (relabelled)" },
      headers: { "if-match": '"1"' },
      token: tokens.admin,
    }
  );

  assert.strictEqual(relabelled.status, 200, relabelled.text);

  // 3. An access rule naming R bumps R: 3, cause accessRules.
  const rule = addAccessRule(ACME.asset, [r.id]);
  yield* change([rule.op]);

  // 4. Two change sets deactivate the rule, then delete it: R 4 and 5.
  const describeRule: Operation = {
    changes: { active: false, description: "auditors read assets" },
    id: rule.id,
    op: "update",
    version: 1,
  };

  yield* change([describeRule]);
  yield* change([{ id: rule.id, op: "delete", version: 2 }]);

  // 5. Retire and delete R through the generic routes.
  const retire = yield* http.request(
    "PATCH",
    `/api/v1/tables/core.role/records/${r.id}`,
    {
      body: { state: "retired" },
      headers: { "if-match": `"${yield* storedVersion("role", r.id)}"` },
      token: tokens.admin,
    }
  );

  assert.strictEqual(retire.status, 200, retire.text);

  const deleted = yield* http.request(
    "DELETE",
    `/api/v1/tables/core.role/records/${r.id}`,
    {
      headers: { "if-match": `"${yield* storedVersion("role", r.id)}"` },
      token: tokens.admin,
    }
  );

  assert.strictEqual(deleted.status, 200, deleted.text);

  // 6. An override relabels the shipped acme role `employee`.
  const snapshot = yield* (yield* Catalog).refresh;
  const employee = snapshot.roleByName("employee");

  assert.isDefined(employee);

  yield* editDefinition({
    actorId: admin,
    changes: { label: "Employee (local label)" },
    id: employee?.id ?? "",
    version: yield* storedVersion("role", employee?.id ?? ""),
  });

  // 7. A change set that fails after its role write leaves nothing.
  const lost = addRole("never_committed");

  const failed = yield* Effect.flip(
    applyChangeSet({
      extraWrites: {
        adopted: [],
        pending: true,
        write: () => Effect.die(new Interrupted()),
      },
      operations: [lost.op],
    }).pipe(Effect.sandbox)
  );

  assert.isDefined(failed);

  // 8. A set load (as `std upgrade` runs it): the helpdesk's role `agent`,
  // then its access rules, which bump it.
  const core = yield* loadSetDirectory(CORE_SET_DIRECTORY);

  yield* loadSetDirectory(HELPDESK_V2, {
    required: new Map([[core.header.name, core.owner]]),
  });

  yield* drain;

  const events = (yield* Ref.get(delivered)).map(eventOf);
  const finalR = yield* storedVersion("role", r.id);
  const finalAgent = yield* storedVersion("role", AGENT_ROLE);

  // Every version of R, in order, exactly once.
  assert.deepStrictEqual(
    versionsOf(events, r.id),
    Array.from({ length: finalR }, (_, index) => index + 1)
  );
  assert.isAtLeast(finalR, 6, "create, relabel, 3 rule bumps, retire, delete");
  assert.strictEqual(
    events.find((event) => event.recordId === r.id)?.kind,
    "create"
  );

  // The shipped role's override edit arrives as an update.
  assert.include(
    events
      .filter((event) => event.recordId === employee?.id)
      .map((event) => event.kind),
    "update"
  );

  // The set load: agent's every version, created and bumped by its rules.
  const agentVersions = versionsOf(events, AGENT_ROLE);

  assert.isTrue(consecutive(agentVersions), JSON.stringify(agentVersions));
  assert.strictEqual(agentVersions.at(-1), finalAgent);
  assert.isAbove(finalAgent, 1, "the helpdesk rules bumped agent");

  // Nothing from the rolled-back change set.
  assert.deepStrictEqual(
    yield* deliveriesWhere("record_id = $1::uuid", [lost.id]),
    []
  );

  // The bump entries: an update with no fields, caused by the rules.
  const [cause] = yield* values(
    `SELECT cause::text AS value FROM core."change"
     WHERE record_id = $1::uuid AND record_version = 3`,
    [r.id]
  );

  assert.match(
    cause ?? "",
    /^\{"accessRules": \["/u,
    "an update caused by the rules"
  );
  assert.isFalse((cause ?? "").includes("kind"));

  // The payload carries the role's image, filtered for the identity.
  const created = (yield* Ref.get(delivered)).find(
    (delivery) => delivery.recordId === r.id && delivery.recordVersion === 1
  );

  const nameField = snapshot.fieldByName(PLATFORM_CLASS_IDS.role, "name");

  assert.isTrue(created?.payload.visible);
  assert.strictEqual(created?.payload.image[nameField?.id ?? ""], "auditor");

  // The rule subscription got the rule's own versions, unserved so far.
  const ruleRows = yield* deliveriesWhere(
    "subscription_id = $1::uuid AND record_id = $2::uuid",
    [rules, rule.id]
  );

  assert.deepStrictEqual(
    ruleRows.map((row) => row.record_version),
    Array.from({ length: ruleRows.length }, (_, index) => String(index + 1))
  );
});

describe("config-events", () => {
  it("names the helpdesk role it loads", () => {
    assert.match(AGENT_ROLE, /^[\da-f-]{36}$/u);
  });

  layer(TestHttpClient.layer.pipe(Layer.provideMerge(workerTestLayer())), {
    excludeTestServices: true,
  })((dbTest) => {
    dbTest.effect(
      "config-events: role subscriptions get every role version from change sets, generic writes, overrides and set loads, in version order; access-rule changes bump their roles; a rolled-back change set delivers nothing",
      () => configEvents
    );
  });
});
