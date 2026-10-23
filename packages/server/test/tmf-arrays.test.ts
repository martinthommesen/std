/**
 * `tmf-arrays` (Contracts 4.9, 11.1, 11.6; decision 0021, decision 41):
 * an array of parts in a TMF merge-patch follows RFC 7396 strictly. Over
 * the fixture mapping (`note` parts of a ticket, the shape of TMF621):
 *
 * - adding a note through the TMF API creates one note, bumps the ticket's
 *   version once and writes one change entry per version;
 * - adding a note through the generic API does the same;
 * - a merge-patch whose `note` array omits one note, changes another and
 *   adds a third deletes, updates and creates exactly those in one
 *   aggregate save: one version, one change entry;
 * - a JSON Patch on the same array is written the same way;
 * - an owner field and parts in one write give the owner's own version and
 *   one aggregate version: two owner versions (Contracts 11.1);
 * - the array's order persists (the item mapping's order field): a reorder,
 *   by merge-patch or a JSON Patch `move`, is a change with a new version;
 * - an existing part is written as its own concrete class: a field the
 *   caller cannot name there is `UnknownField`, and a replacement never
 *   clears it.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestRequestOptions } from "../../testing/src/http-client.ts";
import { count, entriesOf, versionOf } from "./aggregates-support.ts";
import { values } from "./schema-support.ts";
import { FIXTURE_TICKETS, tmfTestLayer } from "./tmf-fixture.ts";
import { asArray, asObject, textOf, v2Callers } from "./v2-support.ts";

const TICKETS = '"tmffx"."ticket"';
const NOTES = '"tmffx"."note"';

const notesOf = (ticketId: string) =>
  count(
    `SELECT count(*)::text AS value FROM ${NOTES} WHERE ticket = $1::uuid`,
    [ticketId]
  );

const patchOptions = (
  caller: TestRequestOptions,
  contentType: string,
  body: JsonValue
): TestRequestOptions => ({
  ...caller,
  headers: { "content-type": contentType },
  rawBody: JSON.stringify(body),
});

const newTicket = (caller: TestRequestOptions, body: JsonObject = {}) =>
  Effect.gen(function* newTicketWork() {
    const http = yield* TestHttpClient;

    const created = yield* http.request("POST", FIXTURE_TICKETS, {
      ...caller,
      body: { "@type": "TroubleTicket", description: "Arrays", ...body },
    });

    assert.strictEqual(created.status, 201, created.text);

    return asObject(created.json);
  });

const noteTexts = (resource: JsonObject): string[] =>
  asArray(resource.note).map((note) => textOf(asObject(note).text));

describe("tmf-arrays", () => {
  it("the notes of a resource are listed by their text", () => {
    assert.deepStrictEqual(
      noteTexts({ note: [{ text: "first" }, { text: "second" }] }),
      ["first", "second"]
    );
  });

  layer(tmfTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "adding a note through the TMF API creates one note and bumps the ticket's version once, one change entry per version",
      () =>
        Effect.gen(function* addThroughTmf() {
          const http = yield* TestHttpClient;
          const { alice } = yield* v2Callers;
          const ticket = yield* newTicket(alice);
          const id = textOf(ticket.id);

          const patched = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${id}`,
            patchOptions(alice, "application/merge-patch+json", {
              note: [{ "@type": "Note", author: "Alice", text: "first" }],
            })
          );

          assert.strictEqual(patched.status, 200, patched.text);
          assert.deepStrictEqual(noteTexts(asObject(patched.json)), ["first"]);
          assert.strictEqual(patched.headers.get("etag"), '"2"');
          assert.strictEqual(yield* notesOf(id), 1);
          assert.strictEqual(yield* versionOf(TICKETS, id), 2);

          const entries = yield* entriesOf(id);

          assert.deepStrictEqual(
            entries.map((entry) => entry.version),
            [1, 2]
          );
          assert.strictEqual(entries[1]?.kind, "update");
        })
    );

    dbTest.effect("adding a note through the generic API does the same", () =>
      Effect.gen(function* addThroughGeneric() {
        const http = yield* TestHttpClient;
        const { alice } = yield* v2Callers;
        const ticket = yield* newTicket(alice);
        const id = textOf(ticket.id);

        const note = yield* http.request("POST", "/api/v2/tmffxNote", {
          ...alice,
          body: { text: "generic", ticket: { id } },
        });

        assert.strictEqual(note.status, 201, note.text);
        assert.strictEqual(yield* notesOf(id), 1);
        assert.strictEqual(yield* versionOf(TICKETS, id), 2);

        assert.deepStrictEqual(
          (yield* entriesOf(id)).map((entry) => entry.version),
          [1, 2]
        );

        const read = yield* http.get(`${FIXTURE_TICKETS}/${id}`, alice);

        assert.deepStrictEqual(noteTexts(asObject(read.json)), ["generic"]);
        assert.strictEqual(read.headers.get("etag"), '"2"');
      })
    );

    dbTest.effect(
      "a merge-patch whose note array omits one note, changes another and adds a third deletes, updates and creates exactly those in one aggregate save",
      () =>
        Effect.gen(function* replaceArray() {
          const http = yield* TestHttpClient;
          const { alice } = yield* v2Callers;

          const ticket = yield* newTicket(alice, {
            note: [
              { "@type": "Note", text: "keep" },
              { "@type": "Note", text: "drop" },
            ],
          });

          const id = textOf(ticket.id);
          const notes = asArray(ticket.note).map(asObject);
          const keep = notes.find((note) => note.text === "keep") ?? {};
          const drop = notes.find((note) => note.text === "drop") ?? {};
          const before = yield* versionOf(TICKETS, id);
          const entriesBefore = (yield* entriesOf(id)).length;

          assert.strictEqual(yield* notesOf(id), 2);

          const patched = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${id}`,
            patchOptions(alice, "application/merge-patch+json", {
              note: [
                // Read back and changed: read-only `date` repeats its value.
                { ...keep, text: "kept and changed" },
                { "@type": "Note", text: "added" },
              ],
            })
          );

          assert.strictEqual(patched.status, 200, patched.text);
          assert.sameMembers(noteTexts(asObject(patched.json)), [
            "kept and changed",
            "added",
          ]);

          assert.strictEqual(yield* versionOf(TICKETS, id), before + 1);
          assert.strictEqual((yield* entriesOf(id)).length, entriesBefore + 1);
          assert.strictEqual(yield* notesOf(id), 2);

          const dropped = yield* count(
            `SELECT count(*)::text AS value FROM ${NOTES} WHERE id = $1::uuid`,
            [textOf(drop.id)]
          );

          assert.strictEqual(dropped, 0);

          const kept = asArray(asObject(patched.json).note)
            .map(asObject)
            .find((note) => note.id === keep.id);

          assert.strictEqual(kept?.text, "kept and changed");

          const last = (yield* entriesOf(id)).at(-1);

          assert.strictEqual(
            asObject(asObject(last?.cause).aggregate).reason,
            "parts"
          );
        })
    );

    dbTest.effect(
      "a JSON Patch on the array is written the same way, and an owner field with parts gives the owner's own version and one aggregate version",
      () =>
        Effect.gen(function* jsonPatchArray() {
          const http = yield* TestHttpClient;
          const { alice } = yield* v2Callers;
          const ticket = yield* newTicket(alice);
          const id = textOf(ticket.id);

          const added = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${id}`,
            patchOptions(alice, "application/json-patch+json", [
              {
                op: "add",
                path: "/note",
                value: [{ "@type": "Note", text: "one" }],
              },
              {
                op: "add",
                path: "/note/-",
                value: { "@type": "Note", text: "two" },
              },
            ])
          );

          assert.strictEqual(added.status, 200, added.text);
          assert.deepStrictEqual(noteTexts(asObject(added.json)), [
            "one",
            "two",
          ]);
          assert.strictEqual(yield* versionOf(TICKETS, id), 2);

          const both = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${id}`,
            patchOptions(alice, "application/json-patch+json", [
              { op: "test", path: "/note/0/text", value: "one" },
              { op: "remove", path: "/note/0" },
              // Empty attributes are not in the image: `add` sets one.
              { op: "add", path: "/severity", value: "Minor" },
            ])
          );

          assert.strictEqual(both.status, 200, both.text);
          assert.deepStrictEqual(noteTexts(asObject(both.json)), ["two"]);
          assert.strictEqual(asObject(both.json).severity, "Minor");
          // Its own save, then one aggregate save for the part.
          assert.strictEqual(yield* versionOf(TICKETS, id), 4);

          const failed = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${id}`,
            patchOptions(alice, "application/json-patch+json", [
              { op: "test", path: "/note/0/text", value: "one" },
              { op: "remove", path: "/note/0" },
            ])
          );

          assert.strictEqual(failed.status, 409, failed.text);
          assert.strictEqual(asObject(failed.json).code, "PatchTestFailed");
          assert.strictEqual(yield* versionOf(TICKETS, id), 4);
          assert.strictEqual(yield* notesOf(id), 1);
        })
    );

    dbTest.effect(
      "a reordered array persists its order and is a change: merge-patch and JSON Patch move",
      () =>
        Effect.gen(function* reorder() {
          const http = yield* TestHttpClient;
          const { alice } = yield* v2Callers;

          const ticket = yield* newTicket(alice, {
            note: [
              { "@type": "Note", text: "one" },
              { "@type": "Note", text: "two" },
            ],
          });

          const id = textOf(ticket.id);
          const [one = {}, two = {}] = asArray(ticket.note).map(asObject);

          assert.deepStrictEqual(noteTexts(ticket), ["one", "two"]);

          const before = yield* versionOf(TICKETS, id);

          const swapped = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${id}`,
            patchOptions(alice, "application/merge-patch+json", {
              note: [two, one],
            })
          );

          assert.strictEqual(swapped.status, 200, swapped.text);
          assert.deepStrictEqual(noteTexts(asObject(swapped.json)), [
            "two",
            "one",
          ]);
          assert.strictEqual(yield* versionOf(TICKETS, id), before + 1);
          assert.strictEqual(swapped.headers.get("etag"), `"${before + 1}"`);

          const read = yield* http.get(`${FIXTURE_TICKETS}/${id}`, alice);

          assert.deepStrictEqual(noteTexts(asObject(read.json)), [
            "two",
            "one",
          ]);

          const moved = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${id}`,
            patchOptions(alice, "application/json-patch+json", [
              { from: "/note/0", op: "move", path: "/note/1" },
            ])
          );

          assert.strictEqual(moved.status, 200, moved.text);
          assert.deepStrictEqual(noteTexts(asObject(moved.json)), [
            "one",
            "two",
          ]);
          assert.strictEqual(yield* versionOf(TICKETS, id), before + 2);

          const same = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${id}`,
            patchOptions(alice, "application/merge-patch+json", {
              note: asArray(asObject(moved.json).note),
            })
          );

          // The same array again changes nothing.
          assert.strictEqual(same.status, 200, same.text);
          assert.strictEqual(yield* versionOf(TICKETS, id), before + 2);
        })
    );

    dbTest.effect(
      "an existing part is written as its own class: a field the caller cannot name there is UnknownField and never cleared",
      () =>
        Effect.gen(function* lockedNote() {
          const http = yield* TestHttpClient;
          const { alice, bob } = yield* v2Callers;
          const ticket = yield* newTicket(alice);
          const id = textOf(ticket.id);

          const locked = yield* http.request(
            "POST",
            "/api/v2/tmffxLockedNote",
            {
              ...alice,
              body: { author: "Alice", text: "locked", ticket: { id } },
            }
          );

          assert.strictEqual(locked.status, 201, locked.text);

          const noteId = textOf(asObject(locked.json).id);

          const asBob = asObject(
            (yield* http.get(`${FIXTURE_TICKETS}/${id}`, bob)).json
          );

          const [item = {}] = asArray(asBob.note).map(asObject);

          assert.strictEqual(item.id, noteId);
          assert.notProperty(item, "author");

          const named = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${id}`,
            patchOptions(bob, "application/merge-patch+json", {
              note: [{ ...item, author: "Bob" }],
            })
          );

          const missing = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${id}`,
            patchOptions(bob, "application/merge-patch+json", {
              note: [{ ...item, nosuch: "Bob" }],
            })
          );

          assert.strictEqual(named.status, 400, named.text);
          assert.strictEqual(asObject(named.json).code, "UnknownField");
          assert.strictEqual(
            named.text,
            missing.text.replaceAll("nosuch", "author")
          );

          const replaced = yield* http.request(
            "PATCH",
            `${FIXTURE_TICKETS}/${id}`,
            patchOptions(bob, "application/merge-patch+json", {
              note: [{ ...item, text: "edited by Bob" }],
            })
          );

          assert.strictEqual(replaced.status, 200, replaced.text);

          const [author] = yield* values(
            `SELECT coalesce(author, '') AS value FROM ${NOTES} WHERE id = $1::uuid`,
            [noteId]
          );

          assert.strictEqual(author, "Alice");
        })
    );

    dbTest.effect(
      "a caller who cannot read the order field cannot reorder, and the refusal names no hidden part",
      () =>
        Effect.gen(function* unreadableOrder() {
          const http = yield* TestHttpClient;
          const { alice, bob } = yield* v2Callers;

          const ticket = yield* newTicket(alice, {
            note: [
              { "@type": "Note", text: "a" },
              { "@type": "Note", text: "b" },
            ],
          });

          const id = textOf(ticket.id);
          const path = `${FIXTURE_TICKETS}/${id}`;
          const asBob = asObject((yield* http.get(path, bob)).json);
          const [a = {}, b = {}] = asArray(asBob.note).map(asObject);
          const version = yield* versionOf(TICKETS, id);

          for (const options of [
            patchOptions(bob, "application/merge-patch+json", { note: [b, a] }),
            patchOptions(bob, "application/json-patch+json", [
              { from: "/note/0", op: "move", path: "/note/1" },
            ]),
          ]) {
            const refused = yield* http.request("PATCH", path, options);

            assert.strictEqual(refused.status, 400, refused.text);
            assert.strictEqual(asObject(refused.json).code, "ValidationFailed");
            assert.notInclude(refused.text, textOf(a.id));
          }

          assert.strictEqual(yield* versionOf(TICKETS, id), version);
          assert.deepStrictEqual(
            noteTexts(asObject((yield* http.get(path, alice)).json)),
            ["a", "b"]
          );

          const kept = yield* http.request(
            "PATCH",
            path,
            patchOptions(bob, "application/merge-patch+json", { note: [a, b] })
          );

          assert.strictEqual(kept.status, 200, kept.text);
          assert.strictEqual(yield* versionOf(TICKETS, id), version);
        })
    );

    dbTest.effect(
      "sending back the array as read keeps duplicate and negative positions and changes nothing",
      () =>
        Effect.gen(function* keptPositions() {
          const http = yield* TestHttpClient;
          const { alice } = yield* v2Callers;

          const ticket = yield* newTicket(alice, {
            note: [
              { "@type": "Note", text: "a" },
              { "@type": "Note", text: "b" },
              { "@type": "Note", text: "c" },
            ],
          });

          const id = textOf(ticket.id);
          const path = `${FIXTURE_TICKETS}/${id}`;

          // Generic writes give b and c the same negative position.
          for (const [note, position] of [
            [asObject(asArray(ticket.note)[1]), -3],
            [asObject(asArray(ticket.note)[2]), -3],
            [asObject(asArray(ticket.note)[0]), -5],
          ] as const) {
            const stored = yield* http.get(
              `/api/v2/tmffxNote/${textOf(note.id)}`,
              alice
            );

            const written = yield* http.request(
              "PATCH",
              `/api/v2/tmffxNote/${textOf(note.id)}`,
              {
                ...alice,
                headers: {
                  "content-type": "application/merge-patch+json",
                  "if-match": stored.headers.get("etag") ?? "",
                },
                rawBody: JSON.stringify({ position }),
              }
            );

            assert.strictEqual(written.status, 200, written.text);
          }

          const read = yield* http.get(path, alice);

          assert.deepStrictEqual(noteTexts(asObject(read.json)), [
            "a",
            "b",
            "c",
          ]);

          const etag = read.headers.get("etag");

          const again = yield* http.request(
            "PATCH",
            path,
            patchOptions(alice, "application/merge-patch+json", {
              note: asArray(asObject(read.json).note),
            })
          );

          assert.strictEqual(again.status, 200, again.text);
          assert.strictEqual(again.headers.get("etag"), etag);

          const positions = yield* values(
            `SELECT position::text AS value FROM ${NOTES} WHERE ticket = $1::uuid ORDER BY position, created_at`,
            [id]
          );

          assert.deepStrictEqual(positions, ["-5", "-3", "-3"]);

          // A new item at the end gets the position after the highest.
          const appended = yield* http.request(
            "PATCH",
            path,
            patchOptions(alice, "application/merge-patch+json", {
              note: [...asArray(asObject(read.json).note), { text: "d" }],
            })
          );

          assert.deepStrictEqual(noteTexts(asObject(appended.json)), [
            "a",
            "b",
            "c",
            "d",
          ]);
        })
    );
  });
});
