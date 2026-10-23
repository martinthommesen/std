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
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestRequestOptions } from "../../testing/src/http-client.ts";
import { entriesOf, versionOf } from "./aggregates-support.ts";
import { asArray, asObject, textOf, apiCallers } from "./api-support.ts";
import { itilLayer } from "./itil-support.ts";
import { FIXTURE_TICKETS, tmfTestLayer } from "./tmf-fixture.ts";
import {
  bodyOf,
  etagOf,
  TICKETS as TMF621_TICKETS,
  ticketBody,
  tmf621As,
} from "./tmf621-support.ts";
import type { Tmf621Client } from "./tmf621-support.ts";

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

const HELPDESK_TICKETS = '"helpdesk"."ticket"';

/** Creates a ticket through TMF621 and returns its id (201 asserted). */
const newTmf621Ticket = Effect.fn("AggregateRace.newTmf621Ticket")(
  function* newTmf621Ticket(client: Tmf621Client) {
    const created = yield* client.post(TMF621_TICKETS, ticketBody());

    assert.strictEqual(created.status, 201, created.text);

    return textOf(bodyOf(created).id);
  }
);

/**
 * Adds a generic note with the admin's existing session, outside sign-in admission.
 * @param client - The signed-in admin.
 * @param ticket - The ticket ID.
 * @param text - The note text.
 * @returns The generic API response.
 */
const addHelpdeskNote = (client: Tmf621Client, ticket: string, text: string) =>
  client.post("/api/v1/helpdeskTicketNote", { text, ticket: { id: ticket } });

describe("aggregate-race-http-tmf621", () => {
  layer(itilLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "TMF621 If-Match on the version before a generic note is 409 VersionConflict with the current ETag",
      () =>
        Effect.gen(function* stalePatch() {
          const admin = yield* tmf621As("admin");
          const ticket = yield* newTmf621Ticket(admin);
          const path = `${TMF621_TICKETS}/${ticket}`;
          const before = etagOf(yield* admin.get(path));

          const note = yield* addHelpdeskNote(
            admin,
            ticket,
            "before the patch"
          );

          assert.strictEqual(note.status, 201, note.text);

          const stale = yield* admin.patch(
            path,
            { description: "Stale" },
            { ifMatch: before }
          );

          assert.strictEqual(stale.status, 409, stale.text);
          assert.strictEqual(bodyOf(stale).code, "VersionConflict");

          const current = etagOf(yield* admin.get(path));

          assert.notStrictEqual(current, before);
          assert.strictEqual(stale.headers.get("etag"), current);
          assert.strictEqual(
            current,
            `"${String(yield* versionOf(HELPDESK_TICKETS, ticket))}"`
          );
        })
    );

    dbTest.effect(
      "concurrent generic notes and TMF621 patches never deadlock and each give their versions and change entries",
      () =>
        Effect.gen(function* race() {
          const admin = yield* tmf621As("admin");
          const ticket = yield* newTmf621Ticket(admin);
          const path = `${TMF621_TICKETS}/${ticket}`;
          const created = yield* versionOf(HELPDESK_TICKETS, ticket);

          const notes = Array.from({ length: RACERS }, (_, index) =>
            addHelpdeskNote(admin, ticket, `note ${index}`)
          );

          // Racer 0 also sends a note array: own attributes plus parts.
          const patchBodies: JsonObject[] = Array.from(
            { length: RACERS },
            (_, index) => ({ name: `Racer ${index}` })
          );

          patchBodies[0] = {
            name: "Racer 0",
            note: [{ text: "patched note" }],
          };

          const patches = patchBodies.map((body) => admin.patch(path, body));

          const answers = yield* Effect.all([...notes, ...patches], {
            concurrency: "unbounded",
          });

          const noteAnswers = answers.slice(0, RACERS);
          const patchAnswers = answers.slice(RACERS);

          assert.deepStrictEqual(
            answers.map((answer) => answer.status),
            [
              ...Array.from({ length: RACERS }, () => 201),
              ...Array.from({ length: RACERS }, () => 200),
            ],
            answers.map((answer) => answer.text).join("\n")
          );
          assert.lengthOf(noteAnswers, RACERS);

          // One version per note, one per patch of own attributes, and one
          // more for the patch that also writes parts.
          const expected = created + RACERS + RACERS + 1;
          const entries = yield* entriesOf(ticket);

          assert.strictEqual(
            yield* versionOf(HELPDESK_TICKETS, ticket),
            expected
          );
          assert.deepStrictEqual(
            entries.map((entry) => entry.version),
            Array.from({ length: expected }, (_, index) => index + 1)
          );

          const etags = patchAnswers.map((answer) => etagOf(answer));

          assert.strictEqual(new Set(etags).size, RACERS);
          assert.strictEqual(etagOf(yield* admin.get(path)), `"${expected}"`);
        })
    );

    dbTest.effect(
      "racing TMF621 patches with the same If-Match give at most one 200",
      () =>
        Effect.gen(function* raceIfMatch() {
          const admin = yield* tmf621As("admin");
          const ticket = yield* newTmf621Ticket(admin);
          const path = `${TMF621_TICKETS}/${ticket}`;
          const ifMatch = etagOf(yield* admin.get(path));

          const answers = yield* Effect.all(
            Array.from({ length: RACERS }, (_, index) =>
              admin.patch(path, { name: `Racer ${index}` }, { ifMatch })
            ),
            { concurrency: "unbounded" }
          );

          const ok = answers.filter((answer) => answer.status === 200);
          const conflicts = answers.filter((answer) => answer.status === 409);

          assert.lengthOf(ok, 1);
          assert.lengthOf(conflicts, RACERS - 1);

          for (const conflict of conflicts) {
            assert.strictEqual(bodyOf(conflict).code, "VersionConflict");
          }
        })
    );
  });
});
