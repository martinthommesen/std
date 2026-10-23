/**
 * `aggregate-race-http` (Contracts 4.9, decision 0029's follow-up): the
 * aggregate race over HTTP. A note added through the generic API
 * (`/api/v1/tmffxNote`, the TMF630 API's collection of the part class)
 * races a TMF-style `PATCH` of its ticket through the framework (the
 * fixture mapping, shaped as TMF621), with and without `If-Match`:
 *
 * - with `If-Match` on the version before the note, the `PATCH` is
 *   `VersionConflict` (TMF621's declared `409`) with the current `ETag`;
 * - concurrent notes and patches never deadlock; the ticket's final
 *   version is 1 + its own field saves + one per transaction that wrote a
 *   note; every version has exactly one change entry; no two answers carry
 *   the same `ETag` for different states.
 *
 * The record-service variant is `aggregate-race`; TMF621's own `PATCH`
 * reuses this path (workstream 3I).
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestRequestOptions } from "../../testing/src/http-client.ts";
import { entriesOf, versionOf } from "./aggregates-support.ts";
import { asArray, asObject, textOf, apiCallers } from "./api-support.ts";
import { FIXTURE_TICKETS, tmfTestLayer } from "./tmf-fixture.ts";

const TICKETS = '"tmffx"."ticket"';
const RACERS = 6;

const mergeOptions = (
  caller: TestRequestOptions,
  body: JsonValue,
  headers: Readonly<Record<string, string>> = {}
): TestRequestOptions => ({
  ...caller,
  headers: { "content-type": "application/merge-patch+json", ...headers },
  rawBody: JSON.stringify(body),
});

const newTicket = (caller: TestRequestOptions) =>
  Effect.gen(function* newTicketWork() {
    const http = yield* TestHttpClient;

    const created = yield* http.request("POST", FIXTURE_TICKETS, {
      ...caller,
      body: { "@type": "TroubleTicket", description: "Race" },
    });

    assert.strictEqual(created.status, 201, created.text);

    return textOf(asObject(created.json).id);
  });

const addNote = (caller: TestRequestOptions, ticket: string, text: string) =>
  Effect.gen(function* addNoteWork() {
    const http = yield* TestHttpClient;

    return yield* http.request("POST", "/api/v1/tmffxNote", {
      ...caller,
      body: { text, ticket: { id: ticket } },
    });
  });

describe("aggregate-race-http", () => {
  it("a race has at least two racers", () => {
    assert.isAbove(RACERS, 1);
  });

  layer(tmfTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "with If-Match on the version before a note, a TMF PATCH of the ticket is VersionConflict with the current ETag",
      () =>
        Effect.gen(function* stalePatch() {
          const http = yield* TestHttpClient;
          const { alice } = yield* apiCallers;
          const ticket = yield* newTicket(alice);

          const note = yield* addNote(alice, ticket, "before the patch");

          assert.strictEqual(note.status, 201, note.text);
          assert.strictEqual(yield* versionOf(TICKETS, ticket), 2);

          const stale = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${ticket}`,
            mergeOptions(alice, { severity: "Major" }, { "if-match": '"1"' })
          );

          assert.strictEqual(stale.status, 409, stale.text);
          assert.strictEqual(asObject(stale.json).code, "VersionConflict");
          assert.strictEqual(stale.headers.get("etag"), '"2"');
          assert.strictEqual(yield* versionOf(TICKETS, ticket), 2);

          const current = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${ticket}`,
            mergeOptions(alice, { severity: "Major" }, { "if-match": '"2"' })
          );

          assert.strictEqual(current.status, 200, current.text);
          assert.strictEqual(current.headers.get("etag"), '"3"');
        })
    );

    dbTest.effect(
      "concurrent notes through /api/v1 and TMF PATCHes of the ticket never deadlock, and every version has one change entry",
      () =>
        Effect.gen(function* race() {
          const http = yield* TestHttpClient;
          const { alice } = yield* apiCallers;
          const ticket = yield* newTicket(alice);

          const notes = Array.from({ length: RACERS }, (_, index) =>
            addNote(alice, ticket, `note ${index}`)
          );

          const patches = Array.from({ length: RACERS }, (_, index) =>
            http.request(
              "PATCH",
              `${FIXTURE_TICKETS}/${ticket}`,
              mergeOptions(alice, { severity: `S${index}` })
            )
          );

          const answers = yield* Effect.all(
            notes.flatMap((note, index) => [note, patches[index] ?? note]),
            { concurrency: "unbounded" }
          );

          const statuses = answers.map((answer) => answer.status);

          assert.deepStrictEqual(
            statuses,
            Array.from({ length: RACERS }, () => [201, 200]).flat(),
            answers.map((answer) => answer.text).join("\n")
          );

          // 1 for the create, one per own field save, one per note.
          const expected = 1 + RACERS + RACERS;
          const entries = yield* entriesOf(ticket);

          assert.strictEqual(yield* versionOf(TICKETS, ticket), expected);
          assert.deepStrictEqual(
            entries.map((entry) => entry.version),
            Array.from({ length: expected }, (_, index) => index + 1)
          );

          // Each PATCH answered its own state: distinct ETags, each with the
          // severity it wrote.
          const patched = answers.filter((answer) => answer.status === 200);
          const etags = patched.map((answer) => answer.headers.get("etag"));

          assert.strictEqual(new Set(etags).size, RACERS);

          const final = yield* http.get(`${FIXTURE_TICKETS}/${ticket}`, alice);

          assert.strictEqual(final.headers.get("etag"), `"${expected}"`);
          assert.lengthOf(asArray(asObject(final.json).note), RACERS);
        })
    );

    dbTest.effect(
      "with If-Match, racing PATCHes on one version give one 200 and VersionConflicts, never a deadlock",
      () =>
        Effect.gen(function* raceIfMatch() {
          const http = yield* TestHttpClient;
          const { alice } = yield* apiCallers;
          const ticket = yield* newTicket(alice);

          const answers = yield* Effect.all(
            [
              ...Array.from({ length: RACERS }, (_, index) =>
                http.request(
                  "PATCH",
                  `${FIXTURE_TICKETS}/${ticket}`,
                  mergeOptions(
                    alice,
                    { severity: `S${index}` },
                    { "if-match": '"1"' }
                  )
                )
              ),
              addNote(alice, ticket, "racing note"),
            ],
            { concurrency: "unbounded" }
          );

          const patches = answers.slice(0, RACERS);
          const ok = patches.filter((answer) => answer.status === 200);
          const conflicts = patches.filter((answer) => answer.status === 409);

          assert.isAtMost(ok.length, 1);
          assert.strictEqual(ok.length + conflicts.length, RACERS);
          assert.strictEqual(answers.at(-1)?.status, 201);

          for (const conflict of conflicts) {
            assert.strictEqual(asObject(conflict.json).code, "VersionConflict");
          }

          const version = yield* versionOf(TICKETS, ticket);

          assert.strictEqual(version, 2 + ok.length);
          assert.lengthOf(yield* entriesOf(ticket), version);
        })
    );
  });
});
