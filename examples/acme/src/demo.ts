/**
 * The Stage 0 spike demo (plan, "Runnable result"): the two-user example of
 * Contracts 3.3 on a fresh database, through the real HTTP API.
 *
 * It signs in as Alice (asset manager) and Bob (employee), prints what each
 * sees and is refused through `/acme.asset` and `/acme.laptop`, performs the
 * two-user write scenario on Bob's laptop L, and prints L's history for
 * both users through both endpoints.
 */
import { HistoryResponseSchema, RecordListSchema } from "@std/api/records";
import type { RecordJson } from "@std/api/records";
import { AcmeFixture } from "@std/testing/acme-fixture";
import { TestHttpClient } from "@std/testing/http-client";
import type { TestResponse } from "@std/testing/http-client";
import { stringifyJson } from "@std/values/json";
import { isJsonString } from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Schema } from "effect";

/** Prints one line of the demo. */
export type Print = (line: string) => Effect.Effect<void>;

const ASSET = "acme.asset";
const LAPTOP = "acme.laptop";
const TABLES = [ASSET, LAPTOP] as const;

// Audit fields are left out of the printed records to keep lines short.
const AUDIT_FIELDS: ReadonlySet<string> = new Set([
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
]);

const recordsPath = (table: string, query = ""): string =>
  `/api/v1/tables/${table}/records${query}`;

const recordPath = (table: string, id: string): string =>
  `${recordsPath(table)}/${id}`;

const decodeList = Schema.decodeUnknownEffect(RecordListSchema);
const decodeHistory = Schema.decodeUnknownEffect(HistoryResponseSchema);
const ErrorSchema = Schema.Struct({ _tag: Schema.String });
const decodeError = Schema.decodeUnknownOption(ErrorSchema);

const outcome = (response: TestResponse): string => {
  const error = decodeError(response.json);

  return error._tag === "Some"
    ? `${response.status} ${error.value._tag}`
    : String(response.status);
};

const valueText = (value: JsonValue | undefined): string => {
  if (value === undefined) {
    return "";
  }

  return isJsonString(value) ? value : stringifyJson(value);
};

const recordLine = (record: RecordJson): string => {
  const shown = Object.entries(record.values)
    .flatMap(([name, value]) =>
      AUDIT_FIELDS.has(name) ? [] : [`${name}=${valueText(value)}`]
    )
    .join(", ");

  const withheld =
    record.withheld === undefined || record.withheld.length === 0
      ? ""
      : ` [withheld: ${record.withheld.join(", ")}]`;

  return `    ${valueText(record.values.name)} (${record.class} v${record.version}): ${shown}${withheld}`;
};

const showLists = Effect.fn("Demo.showLists")(function* showLists(
  print: Print,
  users: readonly (readonly [string, string])[]
) {
  const http = yield* TestHttpClient;

  yield* print("== What each user sees ==");

  for (const [name, token] of users) {
    for (const table of TABLES) {
      const list = yield* decodeList(
        (yield* http.get(recordsPath(table), { token })).json
      ).pipe(Effect.orDie);

      yield* print(`  ${name} via /${table}: ${list.records.length} records`);

      for (const record of list.records) {
        yield* print(recordLine(record));
      }
    }
  }
});

const showRefusals = Effect.fn("Demo.showRefusals")(function* showRefusals(
  print: Print,
  bob: string
) {
  const http = yield* TestHttpClient;
  const fixture = yield* AcmeFixture;
  const { K, L } = fixture.records;

  yield* print("== What Bob is refused ==");

  for (const table of TABLES) {
    const hidden = yield* http.get(recordPath(table, K), { token: bob });

    yield* print(
      `  bob GET /${table}/{Alice's laptop K} -> ${outcome(hidden)} (identical to an unknown ID)`
    );
  }

  const costFilter = yield* http.get(
    recordsPath(ASSET, "?filter=cost%20%3E%200"),
    { token: bob }
  );

  yield* print(`  bob filter "cost > 0" -> ${outcome(costFilter)}`);

  const diskKey = yield* http.request("PATCH", recordPath(LAPTOP, L), {
    body: { disk_key: "x" },
    headers: { "if-match": '"1"' },
    token: bob,
  });

  yield* print(`  bob PATCH /acme.laptop/L {disk_key} -> ${outcome(diskKey)}`);
});

const patchL = Effect.fn("Demo.patchL")(function* patchL(
  token: string,
  table: string,
  version: number,
  body: JsonValue
) {
  const http = yield* TestHttpClient;
  const fixture = yield* AcmeFixture;

  return yield* http.request("PATCH", recordPath(table, fixture.records.L), {
    body,
    headers: { "if-match": `"${version}"` },
    token,
  });
});

const VersionSchema = Schema.Struct({
  currentVersion: Schema.optionalKey(Schema.Int),
  record: Schema.optionalKey(Schema.Struct({ version: Schema.Int })),
});

const decodeVersion = Schema.decodeUnknownOption(VersionSchema);

const versionNote = (response: TestResponse): string => {
  const body = decodeVersion(response.json);

  if (body._tag === "None") {
    return "";
  }

  if (body.value.record !== undefined) {
    return `, version ${body.value.record.version}`;
  }

  return body.value.currentVersion === undefined
    ? ""
    : `, current version ${body.value.currentVersion}`;
};

const step = (response: TestResponse): string =>
  `${outcome(response)}${versionNote(response)}`;

const twoUserWrite = Effect.fn("Demo.twoUserWrite")(function* twoUserWrite(
  print: Print,
  alice: string,
  bob: string
) {
  yield* print("== Two-user write on Bob's laptop L (version 1) ==");

  yield* print(
    `  1. bob PATCH /acme.laptop/L {name} -> ${step(yield* patchL(bob, LAPTOP, 1, { name: "L (Bob's)" }))}`
  );
  yield* print(
    `  2. alice PATCH /acme.asset/L {cost} at version 1 -> ${step(yield* patchL(alice, ASSET, 1, { cost: "1300.00" }))}`
  );
  yield* print(
    `  3. alice rereads, PATCH /acme.asset/L {cost} at version 2 -> ${step(yield* patchL(alice, ASSET, 2, { cost: "1300.00" }))}`
  );

  for (const table of TABLES) {
    yield* print(
      `  4. bob PATCH /${table}/L {status} -> ${step(yield* patchL(bob, table, 3, { status: "spare" }))}`
    );
  }

  yield* print(
    `  5. alice PATCH /acme.asset/L {purchased_on: null} -> ${step(yield* patchL(alice, ASSET, 3, { purchased_on: null }))}`
  );
});

const showHistory = Effect.fn("Demo.showHistory")(function* showHistory(
  print: Print,
  users: readonly (readonly [string, string])[]
) {
  const http = yield* TestHttpClient;
  const fixture = yield* AcmeFixture;

  yield* print("== History of L ==");

  for (const [name, token] of users) {
    for (const table of TABLES) {
      const response = yield* http.get(
        `${recordPath(table, fixture.records.L)}/history`,
        { token }
      );

      const body = yield* decodeHistory(response.json).pipe(Effect.orDie);

      const entries = body.entries.map(
        (entry) =>
          `v${entry.version} ${entry.kind} [${Object.keys(entry.changes).join(", ")}]`
      );

      yield* print(`  ${name} via /${table}: ${entries.join("; ")}`);
    }
  }
});

/**
 * Runs the demo against the acme fixture's database.
 *
 * @param print - Where the lines go.
 * @returns Nothing; the output is the point.
 */
export const runDemo = Effect.fn("Demo.run")(function* runDemo(print: Print) {
  const http = yield* TestHttpClient;
  const alice = yield* http.signIn("alice", "alice-password");
  const bob = yield* http.signIn("bob", "bob-password");

  const users = [
    ["alice", alice],
    ["bob", bob],
  ] as const;

  yield* print(
    "STD spike demo: the acme two-user example (Contracts 3.3) on a fresh database"
  );
  yield* print(
    "Signed in as alice (asset_manager) and bob (employee) over the HTTP API"
  );
  yield* showLists(print, users);
  yield* showRefusals(print, bob);
  yield* twoUserWrite(print, alice, bob);
  yield* showHistory(print, users);
});
