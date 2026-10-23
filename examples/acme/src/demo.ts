/**
 * The Stage 0 spike demo (plan, "Runnable result"): the two-user example of
 * Contracts 3.3 on a fresh database, through the real HTTP API.
 *
 * It signs in as Alice (asset manager) and Bob (employee), prints what each
 * sees and is refused through `/acmeAsset` and `/acmeLaptop`, performs the
 * two-user write scenario on Bob's laptop L, and prints L's history for
 * both users through both endpoints.
 */
import { ChangeEntry, EntityRef, Resource } from "@std/api/resource";
import { AcmeFixture } from "@std/testing/acme-fixture";
import { TestHttpClient } from "@std/testing/http-client";
import type { TestResponse } from "@std/testing/http-client";
import { stringifyJson } from "@std/values/json";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Schema } from "effect";

/** Prints one line of the demo. */
export type Print = (line: string) => Effect.Effect<void>;

const ASSET = "acmeAsset";
const LAPTOP = "acmeLaptop";
const TABLES = [ASSET, LAPTOP] as const;
const MERGE_PATCH = "application/merge-patch+json";

// The resource's own members and its audit attributes are left out of the
// printed attributes to keep lines short.
const HIDDEN_MEMBERS: ReadonlySet<string> = new Set([
  "@baseType",
  "@schemaLocation",
  "@type",
  "createdBy",
  "creationDate",
  "href",
  "id",
  "lastUpdate",
  "revision",
  "updatedBy",
  "withheld",
]);

const collectionPath = (collection: string, query = ""): string =>
  `/api/v1/${collection}${query}`;

const resourcePath = (collection: string, id: string): string =>
  `${collectionPath(collection)}/${id}`;

const decodeList = Schema.decodeUnknownEffect(Schema.Array(Resource));
const decodeHistory = Schema.decodeUnknownEffect(Schema.Array(ChangeEntry));
const decodeRef = Schema.decodeUnknownOption(EntityRef);

const decodeError = Schema.decodeUnknownOption(
  Schema.Struct({ code: Schema.String })
);

const outcome = (response: TestResponse): string => {
  const error = decodeError(response.json);

  return error._tag === "Some"
    ? `${response.status} ${error.value.code}`
    : String(response.status);
};

// A reference shows as its name (or ID), anything else as its JSON.
const valueText = (value: JsonValue | undefined): string => {
  if (value === undefined) {
    return "";
  }

  if (isJsonString(value)) {
    return value;
  }

  if (isJsonObject(value)) {
    const ref = decodeRef(value);

    if (ref._tag === "Some") {
      return ref.value.name ?? ref.value.id;
    }
  }

  return stringifyJson(value);
};

const resourceLine = (resource: typeof Resource.Type): string => {
  const shown = Object.entries(resource)
    .flatMap(([name, value]) =>
      HIDDEN_MEMBERS.has(name) ? [] : [`${name}=${valueText(value)}`]
    )
    .join(", ");

  const withheld =
    resource.withheld === undefined || resource.withheld.length === 0
      ? ""
      : ` [withheld: ${resource.withheld.join(", ")}]`;

  return `    ${valueText(resource.name)} (${resource["@type"]} r${resource.revision}): ${shown}${withheld}`;
};

const showLists = Effect.fn("Demo.showLists")(function* showLists(
  print: Print,
  users: readonly (readonly [string, string])[]
) {
  const http = yield* TestHttpClient;

  yield* print("== What each user sees ==");

  for (const [name, token] of users) {
    for (const collection of TABLES) {
      const list = yield* decodeList(
        (yield* http.get(collectionPath(collection), { token })).json
      ).pipe(Effect.orDie);

      yield* print(`  ${name} via /${collection}: ${list.length} records`);

      for (const resource of list) {
        yield* print(resourceLine(resource));
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

  for (const collection of TABLES) {
    const hidden = yield* http.get(resourcePath(collection, K), {
      token: bob,
    });

    yield* print(
      `  bob GET /${collection}/{Alice's laptop K} -> ${outcome(hidden)} (identical to an unknown ID)`
    );
  }

  const costCondition = yield* http.get(
    collectionPath(ASSET, "?condition=cost%20%3E%200"),
    { token: bob }
  );

  yield* print(`  bob condition "cost > 0" -> ${outcome(costCondition)}`);

  const diskKey = yield* http.request("PATCH", resourcePath(LAPTOP, L), {
    body: { diskKey: "x" },
    headers: { "content-type": MERGE_PATCH, "if-match": '"1"' },
    token: bob,
  });

  yield* print(`  bob PATCH /acmeLaptop/L {diskKey} -> ${outcome(diskKey)}`);
});

const patchL = Effect.fn("Demo.patchL")(function* patchL(
  token: string,
  collection: string,
  revision: number,
  body: JsonValue
) {
  const http = yield* TestHttpClient;
  const fixture = yield* AcmeFixture;

  return yield* http.request(
    "PATCH",
    resourcePath(collection, fixture.records.L),
    {
      headers: { "content-type": MERGE_PATCH, "if-match": `"${revision}"` },
      rawBody: JSON.stringify(body),
      token,
    }
  );
});

const RevisionSchema = Schema.Struct({
  currentVersion: Schema.optionalKey(Schema.Int),
  revision: Schema.optionalKey(Schema.Int),
});

const decodeRevision = Schema.decodeUnknownOption(RevisionSchema);

const revisionNote = (response: TestResponse): string => {
  const body = decodeRevision(response.json);

  if (body._tag === "None") {
    return "";
  }

  if (body.value.revision !== undefined) {
    return `, revision ${body.value.revision}`;
  }

  return body.value.currentVersion === undefined
    ? ""
    : `, current revision ${body.value.currentVersion}`;
};

const step = (response: TestResponse): string =>
  `${outcome(response)}${revisionNote(response)}`;

const twoUserWrite = Effect.fn("Demo.twoUserWrite")(function* twoUserWrite(
  print: Print,
  alice: string,
  bob: string
) {
  yield* print("== Two-user write on Bob's laptop L (revision 1) ==");

  yield* print(
    `  1. bob PATCH /acmeLaptop/L {name} -> ${step(yield* patchL(bob, LAPTOP, 1, { name: "L (Bob's)" }))}`
  );
  yield* print(
    `  2. alice PATCH /acmeAsset/L {cost} at revision 1 -> ${step(yield* patchL(alice, ASSET, 1, { cost: "1300.00" }))}`
  );
  yield* print(
    `  3. alice rereads, PATCH /acmeAsset/L {cost} at revision 2 -> ${step(yield* patchL(alice, ASSET, 2, { cost: "1300.00" }))}`
  );

  for (const collection of TABLES) {
    yield* print(
      `  4. bob PATCH /${collection}/L {status} -> ${step(yield* patchL(bob, collection, 3, { status: "spare" }))}`
    );
  }

  yield* print(
    `  5. alice PATCH /acmeAsset/L {purchasedOn: null} -> ${step(yield* patchL(alice, ASSET, 3, { purchasedOn: null }))}`
  );
});

// The attributes a change entry lists, in API names.
const changedAttributes = (changes: JsonValue | undefined): string[] =>
  changes !== undefined && isJsonObject(changes) ? Object.keys(changes) : [];

const showHistory = Effect.fn("Demo.showHistory")(function* showHistory(
  print: Print,
  users: readonly (readonly [string, string])[]
) {
  const http = yield* TestHttpClient;
  const fixture = yield* AcmeFixture;

  yield* print("== History of L ==");

  for (const [name, token] of users) {
    for (const collection of TABLES) {
      const response = yield* http.get(
        `${resourcePath(collection, fixture.records.L)}/history`,
        { token }
      );

      const history = yield* decodeHistory(response.json).pipe(Effect.orDie);

      const entries = history.map(
        (entry) =>
          `r${valueText(entry.revision)} ${entry.kind} [${changedAttributes(entry.changes).join(", ")}]`
      );

      yield* print(`  ${name} via /${collection}: ${entries.join("; ")}`);
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
