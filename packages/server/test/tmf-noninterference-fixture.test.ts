/**
 * `tmf-noninterference-fixture` (Contracts 3.4, 11.1, 11.6): a TMF API
 * built with the framework never shows or accepts more than the record
 * service allows the caller. Over the fixture mapping (Bob is an
 * employee: he never reads `priority`, never sees `restricted` tickets,
 * and never sees `internal` notes):
 *
 * - a hidden field is an absent attribute, also inside a derived one;
 * - a filter, `fields` or `sort` naming it, and a write of it, are
 *   `UnknownField`, as for an attribute that does not exist;
 * - an invisible ticket is `NotFound`, byte for byte the answer for a
 *   random ID, on every operation, with and without `If-Match`;
 * - a merge-patch array replaces only the parts he can see, and a delete
 *   that would leave a hidden part is refused;
 * - property: randomizing the values Bob cannot read changes none of his
 *   TMF responses.
 *
 * The same tests through TMF621 are `tmf-noninterference` (workstream 3I).
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";
import { constantFrom, record, string, tuple } from "fast-check";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type {
  TestHttpClientApi,
  TestRequestOptions,
  TestResponse,
} from "../../testing/src/http-client.ts";
import { count, versionOf } from "./aggregates-support.ts";
import { asArray, asObject, textOf, apiCallers } from "./api-support.ts";
import { hiddenValuesProperty as checkHiddenValues } from "./noninterference-support.ts";
import { values } from "./schema-support.ts";
import {
  createFixtureTicket,
  FIXTURE_TICKETS,
  mergeOptions,
  tmfTestLayer,
} from "./tmf-fixture.ts";

const RANDOM_ID = "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f";
const TICKETS = '"tmffx"."ticket"';
const NOTES = '"tmffx"."note"';
const RUNS = 12;
const SEED = 20_261_023;

/** Alice's tickets: one Bob sees (with a hidden note), one he cannot. */
const seed = Effect.fn("TmfNoninterferenceFixture.seed")(function* seedTickets(
  alice: TestRequestOptions
) {
  const http = yield* TestHttpClient;

  const openTicket = yield* createFixtureTicket(alice, {
    description: "Open to employees",
    name: "Open",
    note: [{ "@type": "Note", text: "visible note" }],
    priority: "P1",
    severity: "Major",
  });

  const open = textOf(openTicket.id);

  const hiddenNote = yield* http.request("POST", "/api/v1/tmffxNote", {
    ...alice,
    body: { internal: true, text: "internal note", ticket: { id: open } },
  });

  assert.strictEqual(hiddenNote.status, 201, hiddenNote.text);

  const restrictedTicket = yield* createFixtureTicket(alice, {
    description: "Managers only",
    name: "Restricted",
    priority: "P2",
    restricted: true,
    severity: "Critical",
  });

  return {
    hiddenNote: textOf(asObject(hiddenNote.json).id),
    open,
    restricted: textOf(restrictedTicket.id),
  };
});

type Seeded = Effect.Success<ReturnType<typeof seed>>;

/** Values Bob cannot read, written without a version change. */
interface HiddenSample {
  readonly priority: string;
  readonly restricted: readonly [string, string];
  readonly note: string;
}

const hiddenSamples = record({
  note: string({ maxLength: 20, minLength: 1 }),
  priority: constantFrom("P1", "P2", "Open", "Major"),
  restricted: tuple(
    constantFrom("Restricted", "Open", "Other"),
    constantFrom("Major", "Critical", "Minor")
  ),
});

const queriesOf = ({ open, restricted }: Seeded): readonly string[] => [
  FIXTURE_TICKETS,
  `${FIXTURE_TICKETS}?severity=Major`,
  `${FIXTURE_TICKETS}?severity=Critical`,
  `${FIXTURE_TICKETS}?status=acknowledged&sort=-name`,
  `${FIXTURE_TICKETS}?name=Restricted`,
  `${FIXTURE_TICKETS}?fields=note,name&limit=1&offset=0`,
  `${FIXTURE_TICKETS}/${open}`,
  `${FIXTURE_TICKETS}/${restricted}`,
];

const answerOf = (
  http: TestHttpClientApi,
  caller: TestRequestOptions,
  path: string
) =>
  http
    .get(path, caller)
    .pipe(Effect.map((response) => `${response.status} ${response.text}`));

// Hidden values, written without a version change, as stored data.
const writeHidden = (
  { hiddenNote, open, restricted }: Seeded,
  sample: HiddenSample
) =>
  Effect.all(
    [
      values(
        `UPDATE ${TICKETS} SET priority = $1 WHERE id = $2::uuid RETURNING 'ok' AS value`,
        [sample.priority, open]
      ),
      values(
        `UPDATE ${TICKETS} SET name = $1, severity = $2 WHERE id = $3::uuid RETURNING 'ok' AS value`,
        [...sample.restricted, restricted]
      ),
      values(
        `UPDATE ${NOTES} SET text = $1 WHERE id = $2::uuid RETURNING 'ok' AS value`,
        [sample.note, hiddenNote]
      ),
    ],
    { concurrency: "unbounded", discard: true }
  );

const hiddenValuesProperty = (ids: Seeded, caller: TestRequestOptions) =>
  Effect.gen(function* hiddenValuesPropertyWork() {
    const http = yield* TestHttpClient;

    const answers = Effect.all(
      queriesOf(ids).map((path) => answerOf(http, caller, path)),
      { concurrency: "unbounded" }
    );

    yield* checkHiddenValues(
      hiddenSamples,
      (sample) => writeHidden(ids, sample),
      answers,
      { numRuns: RUNS, seed: SEED }
    );
  });

const sameAnswer = (left: TestResponse, right: TestResponse) => {
  assert.strictEqual(left.status, right.status);
  assert.strictEqual(left.text, right.text);
  assert.strictEqual(left.headers.get("etag"), right.headers.get("etag"));
};

describe("tmf-noninterference-fixture", () => {
  it("the property runs a fixed number of seeded samples", () => {
    assert.isAbove(RUNS, 0);
    assert.isAbove(SEED, 0);
  });

  layer(tmfTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a hidden field is an absent attribute, and naming it anywhere is UnknownField as for a missing attribute",
      () =>
        Effect.gen(function* hiddenFields() {
          const http = yield* TestHttpClient;
          const { alice, bob } = yield* apiCallers;
          const { open } = yield* seed(alice);

          const asAlice = asObject(
            (yield* http.get(`${FIXTURE_TICKETS}/${open}`, alice)).json
          );

          const asBob = yield* http.get(`${FIXTURE_TICKETS}/${open}`, bob);

          assert.strictEqual(asAlice.priority, "P1");
          assert.strictEqual(asBob.status, 200, asBob.text);
          assert.notProperty(asObject(asBob.json), "priority");
          assert.notProperty(asObject(asBob.json), "withheld");

          // The generic API does not show it to him either.
          const generic = asObject(
            (yield* http.get(`/api/v1/tmffxTicket/${open}`, bob)).json
          );

          assert.strictEqual(
            generic.description,
            asObject(asBob.json).description
          );
          assert.notProperty(generic, "priority");

          for (const path of [
            `${FIXTURE_TICKETS}?priority=P1`,
            `${FIXTURE_TICKETS}?fields=priority`,
            `${FIXTURE_TICKETS}?sort=priority`,
            `${FIXTURE_TICKETS}/${open}?fields=priority`,
          ]) {
            const refused = yield* http.get(path, bob);

            assert.strictEqual(refused.status, 400, `${path}: ${refused.text}`);
            assert.strictEqual(
              asObject(refused.json).code,
              "UnknownField",
              path
            );
          }

          const missing = yield* http.get(
            `${FIXTURE_TICKETS}?noSuchAttribute=1`,
            bob
          );

          const hidden = yield* http.get(`${FIXTURE_TICKETS}?priority=1`, bob);

          assert.strictEqual(
            hidden.text,
            missing.text.replaceAll("noSuchAttribute", "priority")
          );

          const write = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${open}`,
            mergeOptions(bob, { priority: "P9" })
          );

          assert.strictEqual(write.status, 400, write.text);
          assert.strictEqual(asObject(write.json).code, "UnknownField");

          const created = yield* http.request("POST", FIXTURE_TICKETS, {
            ...bob,
            body: {
              "@type": "TroubleTicket",
              description: "x",
              priority: "P0",
            },
          });

          assert.strictEqual(created.status, 400, created.text);
          assert.strictEqual(asObject(created.json).code, "UnknownField");
        })
    );

    dbTest.effect(
      "an invisible ticket is NotFound byte for byte as a random ID, on every operation",
      () =>
        Effect.gen(function* invisible() {
          const http = yield* TestHttpClient;
          const { alice, bob } = yield* apiCallers;
          const { restricted } = yield* seed(alice);

          const listed = yield* http.get(FIXTURE_TICKETS, bob);

          assert.notInclude(
            asArray(listed.json).map((item) => textOf(asObject(item).id)),
            restricted
          );

          const requests: readonly (readonly [string, TestRequestOptions])[] = [
            ["GET", bob],
            ["PATCH", mergeOptions(bob, { severity: "Minor" })],
            [
              "PATCH",
              mergeOptions(bob, { severity: "Minor" }, { "if-match": '"1"' }),
            ],
            ["DELETE", bob],
            ["DELETE", { ...bob, headers: { "if-match": '"1"' } }],
          ];

          for (const [method, options] of requests) {
            const hidden = yield* http.request(
              method,
              `${FIXTURE_TICKETS}/${restricted}`,
              options
            );

            const random = yield* http.request(
              method,
              `${FIXTURE_TICKETS}/${RANDOM_ID}`,
              options
            );

            assert.strictEqual(hidden.status, 404, `${method}: ${hidden.text}`);
            sameAnswer(hidden, random);
          }

          assert.strictEqual(yield* versionOf(TICKETS, restricted), 1);
        })
    );

    dbTest.effect(
      "a merge-patch array replaces only the parts the caller can see, and a delete that would leave a hidden part is refused",
      () =>
        Effect.gen(function* hiddenParts() {
          const http = yield* TestHttpClient;
          const { alice, bob } = yield* apiCallers;
          const { hiddenNote, open } = yield* seed(alice);

          const read = asObject(
            (yield* http.get(`${FIXTURE_TICKETS}/${open}`, bob)).json
          );

          assert.deepStrictEqual(
            asArray(read.note).map((note) => textOf(asObject(note).text)),
            ["visible note"]
          );

          const replaced = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${open}`,
            mergeOptions(bob, {
              note: [{ "@type": "Note", text: "Bob's note" }],
            })
          );

          assert.strictEqual(replaced.status, 200, replaced.text);

          assert.deepStrictEqual(
            asArray(asObject(replaced.json).note).map((note) =>
              textOf(asObject(note).text)
            ),
            ["Bob's note"]
          );

          // An `id` naming the hidden note is not used: a new note is made.
          const guessed = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${open}`,
            mergeOptions(bob, {
              note: [{ "@type": "Note", id: hiddenNote, text: "guess" }],
            })
          );

          assert.strictEqual(guessed.status, 200, guessed.text);

          assert.strictEqual(
            yield* count(
              `SELECT count(*)::text AS value FROM ${NOTES} WHERE id = $1::uuid AND text = 'internal note'`,
              [hiddenNote]
            ),
            1
          );

          const deleted = yield* http.request(
            "DELETE",
            `${FIXTURE_TICKETS}/${open}`,
            bob
          );

          assert.strictEqual(deleted.status, 409, deleted.text);
          assert.strictEqual(asObject(deleted.json).code, "Referenced");
          assert.strictEqual(
            yield* count(
              `SELECT count(*)::text AS value FROM ${NOTES} WHERE ticket = $1::uuid`,
              [open]
            ),
            2
          );
        })
    );

    dbTest.effect(
      "property: randomizing the values Bob cannot read changes none of his TMF responses",
      () =>
        Effect.gen(function* property() {
          const { alice, bob } = yield* apiCallers;

          yield* hiddenValuesProperty(yield* seed(alice), bob);
        })
    );
  });
});
