/**
 * `tmf-noninterference` (Contracts 3.4, 11.1, 11.6): through TMF621 itself,
 * an agent's view of tickets with hidden fields equals his generic view.
 * Local access rules hide from agents `impact` and `priority` (so TMF621
 * `severity` and `priority`), tickets of type `secret`, and notes whose
 * text is `internal note`:
 *
 * - a hidden field is an absent attribute (also inside a derived one);
 * - a filter, `fields` or `sort` naming it, and a write of it, are
 *   `UnknownField`, byte for byte as for an attribute that does not exist;
 * - an invisible ticket is `NotFound`, byte for byte the answer for a
 *   random ID, on every operation, with and without `If-Match`;
 * - a merge-patch `note` array replaces only the notes he can see, and a
 *   delete that would leave a hidden note is refused;
 * - property: randomizing the values he cannot read changes none of his
 *   TMF621 responses (`noninterference` through TMF621 queries).
 *
 * The framework's version over a fixture mapping is
 * `tmf-noninterference-fixture`.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { Condition } from "@std/definitions/condition";
import type {
  AccessAction,
  AccessRuleDraft,
} from "@std/definitions/definition";
import {
  HELPDESK_CLASS_IDS,
  NOTE_FIELD_IDS,
  TICKET_FIELD_IDS,
} from "@std/tmf/helpdesk-ids";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";
import {
  asyncProperty,
  assert as check,
  constantFrom,
  record,
  string,
} from "fast-check";

import { HELPDESK } from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { count, versionOf } from "./aggregates-support.ts";
import { asArray, asObject, textOf } from "./api-support.ts";
import { itilLayer } from "./itil-support.ts";
import { change, freshId, values } from "./schema-support.ts";
import { bodyOf, TICKETS, ticketBody, tmf621As } from "./tmf621-support.ts";
import type { Tmf621Client } from "./tmf621-support.ts";

const RANDOM_ID = "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f";
const TICKET_TABLE = "helpdesk.ticket";
const NOTE_TABLE = "helpdesk.ticket_note";
const RUNS = 12;
const SEED = 20_261_023;
const SECRET_TYPE = "secret";
const INTERNAL_NOTE = "internal note";

const F = TICKET_FIELD_IDS;

const denyRead = (
  classId: string,
  rule: {
    readonly fields?: readonly string[];
    readonly condition?: Condition;
    readonly actions?: readonly AccessAction[];
  }
): AccessRuleDraft => ({
  actions: rule.actions ?? ["read"],
  active: true,
  classId,
  condition: rule.condition ?? null,
  description: null,
  effect: "deny",
  id: freshId(),
  kind: "accessRule",
  name: null,
  owner: { layer: "local" },
  protected: false,
  roleIds: [HELPDESK.agentRole],
  target:
    rule.fields === undefined
      ? { kind: "records" }
      : { fields: rule.fields, kind: "fields" },
});

/** The local rules that hide fields, tickets and notes from agents. */
const hideFromAgents = change(
  [
    denyRead(HELPDESK_CLASS_IDS.ticket, {
      actions: ["read", "create", "update"],
      fields: [F.impact, F.priority],
    }),
    denyRead(HELPDESK_CLASS_IDS.ticket, {
      condition: {
        left: { path: [F.ticketType] },
        op: "eq",
        right: { value: SECRET_TYPE },
      },
    }),
    denyRead(HELPDESK_CLASS_IDS.note, {
      condition: {
        left: { path: [NOTE_FIELD_IDS.text] },
        op: "eq",
        right: { value: INTERNAL_NOTE },
      },
    }),
  ].map((definition) => ({ definition, op: "createAccessRule" as const }))
);

const noninterferenceLayer = Layer.effectDiscard(hideFromAgents).pipe(
  Layer.provideMerge(itilLayer)
);

const create = Effect.fn("TmfNoninterference.create")(function* create(
  client: Tmf621Client,
  body: JsonObject
) {
  const created = yield* client.post(TICKETS, {
    "@type": "TroubleTicket",
    description: "The mail server rejects every login.",
    ticketType: "incident",
    ...body,
  });

  assert.strictEqual(created.status, 201, created.text);

  return textOf(bodyOf(created).id);
});

/**
 * The agent's ticket (with a note he sees and one he does not) and an
 * admin's secret ticket he cannot see.
 */
const seed = Effect.gen(function* seedTickets() {
  const agent = yield* tmf621As("agent");
  const admin = yield* tmf621As("admin");

  // The agent cannot name severity or priority: he opens it without them.
  const open = yield* create(agent, {
    name: "Open",
    note: [{ text: "visible note" }],
  });

  const withHidden = yield* admin.patch(`${TICKETS}/${open}`, {
    note: [
      ...asArray(bodyOf(yield* admin.get(`${TICKETS}/${open}`)).note),
      { text: INTERNAL_NOTE },
    ],
    priority: "Low",
    severity: "Major",
  });

  assert.strictEqual(withHidden.status, 200, withHidden.text);

  const hiddenNote = textOf(
    asObject(
      asArray(bodyOf(withHidden).note).find(
        (note) => asObject(note).text === INTERNAL_NOTE
      )
    ).id
  );

  const secret = yield* create(admin, {
    name: "Secret",
    severity: "Critical",
    ticketType: SECRET_TYPE,
  });

  return { agent, hiddenNote, open, secret };
});

type Seeded = Effect.Success<typeof seed>;

/** Values the agent cannot read, written without a version change. */
interface HiddenSample {
  readonly impact: string;
  readonly priority: string;
  readonly secretName: string;
  readonly secretDescription: string;
}

const hiddenSamples = record({
  impact: constantFrom("1", "2", "3"),
  priority: constantFrom("1", "2", "3", "4", "5"),
  secretDescription: string({ maxLength: 20, minLength: 1 }),
  secretName: constantFrom("Secret", "Open", "Other"),
});

const queriesOf = ({ open, secret }: Seeded): readonly string[] => [
  TICKETS,
  `${TICKETS}?name=Open`,
  `${TICKETS}?name=Secret`,
  `${TICKETS}?status=acknowledged&sort=-name`,
  `${TICKETS}?ticketType=${SECRET_TYPE}`,
  `${TICKETS}?fields=note,name&limit=1&offset=0`,
  `${TICKETS}/${open}`,
  `${TICKETS}/${secret}`,
];

// Hidden values, written without a version change, as stored data.
const writeHidden = ({ open, secret }: Seeded, sample: HiddenSample) =>
  Effect.gen(function* writeHiddenWork() {
    yield* values(
      `UPDATE ${TICKET_TABLE} SET impact = $1, priority = $2 WHERE id = $3::uuid RETURNING 'ok' AS value`,
      [sample.impact, sample.priority, open]
    );

    yield* values(
      `UPDATE ${TICKET_TABLE} SET short_description = $1, description = $2 WHERE id = $3::uuid RETURNING 'ok' AS value`,
      [sample.secretName, sample.secretDescription, secret]
    );
  });

/**
 * Checks the seeded samples: each, once written, leaves the observed
 * answers equal to the baseline.
 *
 * @param observe - Writes a sample and returns the answers.
 * @param baseline - The answers before any sample.
 * @returns When every sample held.
 */
const holdsForEverySample = async (
  observe: (sample: HiddenSample) => Promise<readonly string[]>,
  baseline: readonly string[]
) => {
  await check(
    asyncProperty(hiddenSamples, async (sample) => {
      assert.deepStrictEqual(await observe(sample), baseline);
    }),
    { numRuns: RUNS, seed: SEED }
  );
};

const answerText = (response: TestResponse) =>
  `${response.status} ${response.text}`;

/**
 * The property: writing any sample of hidden values leaves every one of
 * the agent's TMF621 answers as it was.
 *
 * @param seeded - The seeded tickets and the agent's client.
 * @returns When every sample held.
 */
const hiddenValuesProperty = (seeded: Seeded) =>
  Effect.gen(function* hiddenValuesPropertyWork() {
    const answers = Effect.all(
      queriesOf(seeded).map((path) =>
        Effect.map(seeded.agent.get(path), answerText)
      )
    );

    const baseline = yield* answers;

    const apply = (sample: HiddenSample) =>
      writeHidden(seeded, sample).pipe(Effect.andThen(answers));

    const services = yield* Effect.context<
      SqlClient.SqlClient | TestHttpClient
    >();

    const run = Effect.runPromiseWith(services);

    yield* Effect.promise(async () => {
      await holdsForEverySample(
        async (sample) => await run(apply(sample)),
        baseline
      );
    });
  });

const sameAnswer = (left: TestResponse, right: TestResponse) => {
  assert.strictEqual(left.status, right.status);
  assert.strictEqual(left.text, right.text);
  assert.strictEqual(left.headers.get("etag"), right.headers.get("etag"));
};

const codeOf = (response: TestResponse): JsonValue =>
  asObject(response.json).code ?? null;

describe("tmf-noninterference", () => {
  it("the property runs a fixed number of seeded samples", () => {
    assert.isAbove(RUNS, 0);
    assert.isAbove(SEED, 0);
  });

  layer(noninterferenceLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a hidden field is an absent attribute, and naming it anywhere is UnknownField as for a missing attribute",
      () =>
        Effect.gen(function* hiddenFields() {
          const http = yield* TestHttpClient;
          const admin = yield* tmf621As("admin");
          const { agent, open } = yield* seed;

          const asAdmin = bodyOf(yield* admin.get(`${TICKETS}/${open}`));
          const asAgent = yield* agent.get(`${TICKETS}/${open}`);

          assert.deepStrictEqual(
            [asAdmin.severity, asAdmin.priority],
            ["Major", "Low"]
          );
          assert.strictEqual(asAgent.status, 200, asAgent.text);
          assert.notProperty(bodyOf(asAgent), "severity");
          assert.notProperty(bodyOf(asAgent), "priority");

          // The generic API does not show them to him either.
          const token = yield* http.signIn(
            "agent",
            "helpdesk-agent-demo-password"
          );

          const generic = asObject(
            (yield* http.get(`/api/v1/helpdeskIncident/${open}`, { token }))
              .json
          );

          assert.strictEqual(generic.description, bodyOf(asAgent).description);
          assert.notProperty(generic, "impact");
          assert.notProperty(generic, "priority");

          for (const path of [
            `${TICKETS}?severity=Major`,
            `${TICKETS}?priority=Low`,
            `${TICKETS}?fields=severity`,
            `${TICKETS}?sort=priority`,
            `${TICKETS}/${open}?fields=priority`,
          ]) {
            const refused = yield* agent.get(path);

            assert.deepStrictEqual(
              [refused.status, codeOf(refused)],
              [400, "UnknownField"],
              path
            );
          }

          const missing = yield* agent.get(`${TICKETS}?noSuchAttribute=1`);
          const hidden = yield* agent.get(`${TICKETS}?severity=1`);

          assert.strictEqual(
            hidden.text,
            missing.text.replaceAll("noSuchAttribute", "severity")
          );

          const write = yield* agent.patch(`${TICKETS}/${open}`, {
            priority: "High",
          });

          assert.deepStrictEqual(
            [write.status, codeOf(write)],
            [400, "UnknownField"]
          );

          const created = yield* agent.post(TICKETS, ticketBody());

          assert.deepStrictEqual(
            [created.status, codeOf(created)],
            [400, "UnknownField"]
          );
        })
    );

    dbTest.effect(
      "an invisible ticket is NotFound byte for byte as a random ID, on every operation",
      () =>
        Effect.gen(function* invisible() {
          const { agent, secret } = yield* seed;

          const listed = yield* agent.get(TICKETS);

          assert.notInclude(
            asArray(listed.json).map((item) => textOf(asObject(item).id)),
            secret
          );

          const operations: readonly ((
            id: string
          ) => Effect.Effect<TestResponse>)[] = [
            (id) => agent.get(`${TICKETS}/${id}`),
            (id) => agent.patch(`${TICKETS}/${id}`, { name: "x" }),
            (id) =>
              agent.patch(
                `${TICKETS}/${id}`,
                { name: "x" },
                { ifMatch: '"1"' }
              ),
            (id) => agent.del(`${TICKETS}/${id}`),
            (id) => agent.del(`${TICKETS}/${id}`, { ifMatch: '"1"' }),
          ];

          for (const operation of operations) {
            const hidden = yield* operation(secret);
            const random = yield* operation(RANDOM_ID);

            assert.strictEqual(hidden.status, 404, hidden.text);
            sameAnswer(hidden, random);
          }

          assert.strictEqual(yield* versionOf(TICKET_TABLE, secret), 1);
        })
    );

    dbTest.effect(
      "a merge-patch note array replaces only the notes the agent can see, and a delete that would leave a hidden note is refused",
      () =>
        Effect.gen(function* hiddenParts() {
          const { agent, hiddenNote, open } = yield* seed;

          const read = bodyOf(yield* agent.get(`${TICKETS}/${open}`));

          assert.deepStrictEqual(
            asArray(read.note).map((note) => textOf(asObject(note).text)),
            ["visible note"]
          );

          const replaced = yield* agent.patch(`${TICKETS}/${open}`, {
            note: [{ text: "agent's note" }],
          });

          assert.strictEqual(replaced.status, 200, replaced.text);
          assert.deepStrictEqual(
            asArray(bodyOf(replaced).note).map((note) =>
              textOf(asObject(note).text)
            ),
            ["agent's note"]
          );

          // An `id` naming the hidden note is not used: a new note is made.
          const guessed = yield* agent.patch(`${TICKETS}/${open}`, {
            note: [{ id: hiddenNote, text: "guess" }],
          });

          assert.strictEqual(guessed.status, 200, guessed.text);
          assert.strictEqual(
            yield* count(
              `SELECT count(*)::text AS value FROM ${NOTE_TABLE} WHERE id = $1::uuid AND text = $2`,
              [hiddenNote, INTERNAL_NOTE]
            ),
            1
          );

          const deleted = yield* agent.del(`${TICKETS}/${open}`);

          assert.deepStrictEqual(
            [deleted.status, codeOf(deleted)],
            [409, "Referenced"]
          );
          assert.strictEqual(
            yield* count(
              `SELECT count(*)::text AS value FROM ${NOTE_TABLE} WHERE ticket = $1::uuid`,
              [open]
            ),
            2
          );
        })
    );

    dbTest.effect(
      "property: randomizing the values the agent cannot read changes none of his TMF621 responses",
      () =>
        Effect.gen(function* property() {
          yield* hiddenValuesProperty(yield* seed);
        })
    );
  });
});
