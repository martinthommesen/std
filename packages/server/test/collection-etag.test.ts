import { createServer } from "node:http";
import { createConnection } from "node:net";

import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { TMF688_PREFIX } from "@std/api/tmf688";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { seedDeadLetters } from "../../testing/src/dead-letter-fixture.ts";
import { helpdeskTestLayer } from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { answerApiFailures } from "../src/http/api-cache.ts";
import { HttpAppLayer, tmfRoutes } from "../src/http/app.ts";
import {
  API,
  asArray,
  asObject,
  numberOf,
  textOf,
  UNKNOWN_ID,
} from "./api-support.ts";
import { hubTestLayer, listener } from "./hub-support.ts";
import { readsTestLayer } from "./reads-support.ts";
import {
  createFixtureTicket,
  FIXTURE_API,
  FIXTURE_TICKETS,
  tmfTestLayer,
} from "./tmf-fixture.ts";
import { TICKETS, SPECIFICATIONS, ticketBody } from "./tmf621-support.ts";

// WebCrypto is independent of the server's Node hash and serialization helpers.
const bodyTag = (bytes: Uint8Array) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      Uint8Array.from(bytes)
    );

    return `"sha256-${Buffer.from(digest).toString("hex")}"`;
  });

const textTag = (text: string) => bodyTag(new TextEncoder().encode(text));

// Capture every byte after the header terminator, including illegal HEAD bodies
// that an HTTP client's HEAD parser would silently discard.
const wireRequest = (
  origin: string,
  path: string,
  method: "GET" | "HEAD",
  token: string
) =>
  Effect.callback<Buffer>((resume) => {
    const url = new URL(origin);
    const chunks: Buffer[] = [];

    const socket = createConnection(
      { host: url.hostname, port: Number(url.port) },
      () => {
        socket.write(
          `${method} ${path} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`
        );
      }
    );

    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on("error", (error) => {
      resume(Effect.die(error));
    });
    socket.on("end", () => {
      resume(Effect.succeed(Buffer.concat(chunks)));
    });

    return Effect.sync(() => {
      socket.destroy();
    });
  });

// The alias lets Sonar recognize Effect tests using the live I/O clock.
const test = it.live;

describe("collection-etag", () => {
  test("tags final generic bytes across callers, filters, projections, language, order and pages", () =>
    Effect.gen(function* genericCollections() {
      const http = yield* TestHttpClient;
      const alice = { token: yield* http.signIn("alice", "alice-password") };
      const bob = { token: yield* http.signIn("bob", "bob-password") };
      const { records } = yield* AcmeFixture;
      const path = `${API.asset}?id=${records.L}`;
      const full = yield* http.get(path, alice);
      const masked = yield* http.get(path, bob);
      assert.strictEqual(full.status, 200);
      assert.strictEqual(masked.status, 200);
      assert.isDefined(asObject(asArray(full.json)[0]).cost);
      assert.isUndefined(asObject(asArray(masked.json)[0]).cost);
      assert.notStrictEqual(full.text, masked.text);
      assert.notStrictEqual(
        full.headers.get("etag"),
        masked.headers.get("etag")
      );

      const identity = yield* http.get(`${path}&fields=none`, alice);
      const sameIdentity = yield* http.get(`${path}&fields=none`, bob);
      assert.strictEqual(identity.text, sameIdentity.text);
      assert.strictEqual(
        identity.headers.get("etag"),
        sameIdentity.headers.get("etag")
      );
      assert.notStrictEqual(
        identity.headers.get("etag"),
        full.headers.get("etag")
      );

      const responses = [full, masked, identity, sameIdentity];

      for (const caller of [alice, bob]) {
        for (const query of [
          "",
          "?fields=name",
          "?fields=!name",
          "?fields=none",
          "?sort=name&limit=1",
          "?sort=-name&offset=1&limit=1",
          `?id=${UNKNOWN_ID}`,
          "?offset=1000",
        ]) {
          const response = yield* http.get(`${API.asset}${query}`, caller);
          const repeated = yield* http.get(`${API.asset}${query}`, caller);
          assert.strictEqual(response.status, 200, response.text);
          assert.strictEqual(response.text, repeated.text);
          assert.strictEqual(
            response.headers.get("etag"),
            repeated.headers.get("etag")
          );
          responses.push(response);
        }
      }

      const empty = yield* http.get(`${API.asset}?id=${UNKNOWN_ID}`, alice);
      assert.strictEqual(empty.text, "[]");

      const filteredSame = yield* http.get(
        `${API.asset}?id=${records.L}&name=L`,
        alice
      );

      assert.strictEqual(filteredSame.text, full.text);
      assert.strictEqual(
        filteredSame.headers.get("etag"),
        full.headers.get("etag")
      );

      const conditional = yield* http.get(path, {
        ...alice,
        headers: { "if-none-match": full.headers.get("etag") ?? "" },
      });

      assert.strictEqual(conditional.status, 200);
      assert.strictEqual(conditional.text, full.text);
      assert.strictEqual(
        conditional.headers.get("etag"),
        full.headers.get("etag")
      );

      const language = yield* http.get(path, {
        ...alice,
        headers: { "accept-language": "nb-NO" },
      });

      assert.strictEqual(language.text, full.text);
      assert.strictEqual(
        language.headers.get("etag"),
        full.headers.get("etag")
      );

      const ids: string[] = [];

      for (const name of ["Blåbær 東京 😀", "Örn"]) {
        const created = yield* http.request("POST", API.monitor, {
          ...alice,
          body: { name },
        });

        assert.strictEqual(created.status, 201, created.text);
        ids.push(textOf(asObject(created.json).id));
      }

      const orderedPath = `${API.monitor}?id=${ids.join(",")}&fields=name&sort=`;
      const ascending = yield* http.get(`${orderedPath}name`, alice);
      const descending = yield* http.get(`${orderedPath}-name`, alice);
      assert.strictEqual(asArray(ascending.json).length, 2);
      assert.deepStrictEqual(
        asArray(ascending.json).map((row) => asObject(row).id),
        asArray(descending.json)
          .toReversed()
          .map((row) => asObject(row).id)
      );
      assert.notStrictEqual(ascending.text, descending.text);
      assert.notStrictEqual(
        ascending.headers.get("etag"),
        descending.headers.get("etag")
      );
      responses.push(empty, filteredSame, language, ascending, descending);

      for (const response of responses) {
        assert.strictEqual(
          response.headers.get("etag"),
          yield* textTag(response.text)
        );
        assert.strictEqual(response.headers.get("cache-control"), "no-store");
        assert.strictEqual(
          response.headers.get("content-type"),
          "application/json"
        );
        assert.strictEqual(
          response.headers.get("content-length"),
          String(Buffer.byteLength(response.text))
        );
      }
    }).pipe(Effect.provide(readsTestLayer())));

  test("changes tags for visible target labels and membership while preserving revision write preconditions", () =>
    Effect.gen(function* labelAndMembership() {
      const http = yield* TestHttpClient;
      const alice = { token: yield* http.signIn("alice", "alice-password") };
      const { records } = yield* AcmeFixture;
      const bob = { token: yield* http.signIn("bob", "bob-password") };
      const path = `${API.laptop}?id=${records.L}&fields=dockedTo`;
      const before = yield* http.get(path, alice);
      const beforeBob = yield* http.get(path, bob);

      const beforeIdentity = yield* http.get(
        `${API.laptop}?id=${records.L}&fields=none`,
        alice
      );

      assert.isUndefined(
        asObject(asObject(asArray(beforeBob.json)[0]).dockedTo).name
      );
      const row = asObject(asArray(before.json)[0]);
      const target = asObject(row.dockedTo);
      const targetPath = new URL(textOf(target.href)).pathname;
      const targetBefore = yield* http.get(targetPath, alice);
      assert.strictEqual(
        targetBefore.headers.get("etag"),
        `"${numberOf(asObject(targetBefore.json).revision)}"`
      );

      const changed = yield* http.request("PATCH", targetPath, {
        ...alice,
        body: { name: "Ny 東京 😀 label" },
        headers: { "if-match": targetBefore.headers.get("etag") ?? "" },
      });

      assert.strictEqual(changed.status, 200, changed.text);
      const after = yield* http.get(path, alice);
      const afterBob = yield* http.get(path, bob);

      const afterIdentity = yield* http.get(
        `${API.laptop}?id=${records.L}&fields=none`,
        alice
      );

      assert.strictEqual(afterBob.text, beforeBob.text);
      assert.strictEqual(
        afterBob.headers.get("etag"),
        beforeBob.headers.get("etag")
      );
      assert.strictEqual(afterIdentity.text, beforeIdentity.text);
      assert.strictEqual(
        afterIdentity.headers.get("etag"),
        beforeIdentity.headers.get("etag")
      );
      const afterRow = asObject(asArray(after.json)[0]);
      assert.strictEqual(afterRow.revision, row.revision);
      assert.strictEqual(asObject(afterRow.dockedTo).name, "Ny 東京 😀 label");
      assert.notStrictEqual(before.text, after.text);
      assert.notStrictEqual(
        before.headers.get("etag"),
        after.headers.get("etag")
      );
      assert.strictEqual(after.headers.get("etag"), yield* textTag(after.text));

      const membershipPath = `${API.monitor}?name=membership&fields=name`;
      const empty = yield* http.get(membershipPath, alice);

      const created = yield* http.request("POST", API.monitor, {
        ...alice,
        body: { name: "membership" },
      });

      assert.strictEqual(created.status, 201, created.text);
      const member = yield* http.get(membershipPath, alice);
      assert.strictEqual(empty.text, "[]");
      assert.strictEqual(asArray(member.json).length, 1);
      assert.notStrictEqual(
        empty.headers.get("etag"),
        member.headers.get("etag")
      );

      const createdPath = new URL(textOf(asObject(created.json).href)).pathname;

      const missing = yield* http.request("PATCH", createdPath, {
        ...alice,
        body: { name: "unchanged" },
      });

      assert.strictEqual(missing.status, 428);

      const patched = yield* http.request("PATCH", createdPath, {
        ...alice,
        body: { name: "membership changed" },
        headers: { "if-match": created.headers.get("etag") ?? "" },
      });

      assert.strictEqual(patched.status, 200, patched.text);

      const stale = yield* http.request("DELETE", createdPath, {
        ...alice,
        headers: { "if-match": created.headers.get("etag") ?? "" },
      });

      assert.strictEqual(stale.status, 412);
      assert.strictEqual(
        stale.headers.get("etag"),
        patched.headers.get("etag")
      );

      const deleted = yield* http.request("DELETE", createdPath, {
        ...alice,
        headers: { "if-match": patched.headers.get("etag") ?? "" },
      });

      assert.strictEqual(deleted.status, 204);
      const emptyAgain = yield* http.get(membershipPath, alice);
      assert.strictEqual(emptyAgain.text, empty.text);
      assert.strictEqual(
        emptyAgain.headers.get("etag"),
        empty.headers.get("etag")
      );
    }).pipe(Effect.provide(readsTestLayer())));

  test("tags history, metadata and deadDelivery lists after selection and leaves collection errors intact", () =>
    Effect.gen(function* fixedCollections() {
      const http = yield* TestHttpClient;
      const admin = { token: yield* http.signIn("ada", "ada-password") };
      const alice = { token: yield* http.signIn("alice", "alice-password") };
      const bob = { token: yield* http.signIn("bob", "bob-password") };
      const { records } = yield* AcmeFixture;
      yield* seedDeadLetters(admin);

      for (const path of [
        "/api/v1/tableMetadata",
        `${API.laptop}/${records.L}/history`,
        `${API.laptop}/${records.L}/history?fields=none`,
        `${API.laptop}/${records.L}/history?count=false&limit=1`,
        `${API.laptop}/${records.L}/history?offset=1000`,
        "/api/v1/deadDelivery",
        "/api/v1/deadDelivery?fields=none&limit=1",
        "/api/v1/deadDelivery?offset=1000",
      ]) {
        const response = yield* http.get(path, admin);
        const repeated = yield* http.get(path, admin);
        assert.strictEqual(response.status, 200, response.text);
        assert.strictEqual(
          response.headers.get("etag"),
          yield* textTag(response.text)
        );
        assert.strictEqual(
          repeated.headers.get("etag"),
          response.headers.get("etag")
        );
        const head = yield* http.request("HEAD", path, admin);
        assert.strictEqual(
          head.headers.get("etag"),
          response.headers.get("etag")
        );
        assert.strictEqual(head.text, "");
        assert.strictEqual(response.headers.get("cache-control"), "no-store");
      }

      for (const [path, caller, status] of [
        [API.asset, {}, 401],
        [`${API.asset}?limit=0`, alice, 400],
        ["/api/v1/noSuchCollection", alice, 404],
        ["/api/v1/deadDelivery", bob, 404],
      ] as const) {
        const response = yield* http.get(path, caller);
        assert.strictEqual(response.status, status);
        assert.strictEqual(response.headers.get("etag"), null);
        assert.strictEqual(
          response.headers.get("content-type"),
          "application/json"
        );
        assert.strictEqual(response.headers.get("cache-control"), "no-store");
      }
    }).pipe(Effect.provide(readsTestLayer())));

  test("tags mapped collections after rendering and masking, retaining optional revision If-Match", () =>
    Effect.gen(function* mappedCollections() {
      const http = yield* TestHttpClient;
      const alice = { token: yield* http.signIn("alice", "alice-password") };
      const bob = { token: yield* http.signIn("bob", "bob-password") };

      const ticket = yield* createFixtureTicket(alice, {
        description: "visible",
        name: "Blåbær 東京 😀",
        priority: "high",
      });

      const path = `${FIXTURE_TICKETS}/${textOf(ticket.id)}`;
      const full = yield* http.get(FIXTURE_TICKETS, alice);
      const masked = yield* http.get(FIXTURE_TICKETS, bob);
      assert.notStrictEqual(full.text, masked.text);
      assert.notStrictEqual(
        full.headers.get("etag"),
        masked.headers.get("etag")
      );

      for (const caller of [alice, bob]) {
        for (const query of [
          "",
          "?fields=name",
          "?fields=none",
          "?name=absent",
          "?offset=1000",
          "?sort=-name&limit=1",
        ]) {
          const response = yield* http.get(
            `${FIXTURE_TICKETS}${query}`,
            caller
          );

          const repeated = yield* http.get(
            `${FIXTURE_TICKETS}${query}`,
            caller
          );

          assert.strictEqual(response.status, 200, response.text);
          assert.strictEqual(
            response.headers.get("etag"),
            yield* textTag(response.text)
          );
          assert.strictEqual(
            repeated.headers.get("etag"),
            response.headers.get("etag")
          );
          assert.strictEqual(response.headers.get("cache-control"), null);

          const head = yield* http.request(
            "HEAD",
            `${FIXTURE_TICKETS}${query}`,
            caller
          );

          assert.strictEqual(
            head.headers.get("etag"),
            response.headers.get("etag")
          );
          assert.strictEqual(head.text, "");
        }
      }

      const single = yield* http.get(path, alice);
      assert.strictEqual(single.headers.get("etag"), '"1"');

      const patched = yield* http.request("PATCH", path, {
        ...alice,
        body: { name: "Changed" },
      });

      assert.strictEqual(patched.status, 200, patched.text);
      assert.strictEqual(patched.headers.get("etag"), '"2"');

      const stale = yield* http.request("PATCH", path, {
        ...alice,
        body: { name: "Stale" },
        headers: { "if-match": '"1"' },
      });

      assert.strictEqual(stale.status, 409);
      assert.strictEqual(stale.headers.get("etag"), '"2"');
      const changed = yield* http.get(FIXTURE_TICKETS, alice);
      assert.notStrictEqual(
        changed.headers.get("etag"),
        full.headers.get("etag")
      );
    }).pipe(Effect.provide(tmfTestLayer())));

  test("tags TMF688 topic, client event and hub lists, including empty and projected pages", () =>
    Effect.gen(function* tmf688Collections() {
      const http = yield* TestHttpClient;
      const admin = { token: yield* http.signIn("ada", "ada-password") };

      const topic = yield* http.request("POST", `${TMF688_PREFIX}/topic`, {
        ...admin,
        body: { name: "Collection 東京 😀" },
      });

      assert.strictEqual(topic.status, 201, topic.text);
      const topicPath = `${TMF688_PREFIX}/topic/${textOf(asObject(topic.json).id)}`;

      const event = yield* http.request("POST", `${topicPath}/event`, {
        ...admin,
        body: {
          "@type": "Event",
          event: { name: "Blåbær 😀" },
          eventId: "collection-event",
          eventType: "CollectionTest",
        },
      });

      assert.strictEqual(event.status, 201, event.text);

      const hubPath = `${topicPath}/hub`;
      const emptyHubs = yield* http.get(hubPath, admin);
      assert.strictEqual(emptyHubs.text, "[]");
      const callback = yield* listener();

      const hub = yield* http.request("POST", hubPath, {
        ...admin,
        body: { callback: callback.origin },
      });

      assert.strictEqual(hub.status, 201, hub.text);
      const hubs = yield* http.get(hubPath, admin);
      const bob = { token: yield* http.signIn("bob", "bob-password") };
      const otherHubs = yield* http.get(hubPath, bob);
      assert.strictEqual(otherHubs.status, 404, otherHubs.text);
      assert.strictEqual(otherHubs.headers.get("etag"), null);
      assert.strictEqual(asArray(hubs.json).length, 1);
      assert.notStrictEqual(
        hubs.headers.get("etag"),
        emptyHubs.headers.get("etag")
      );

      for (const path of [
        `${TMF688_PREFIX}/topic`,
        `${topicPath}/event`,
        `${TMF688_PREFIX}/topic/record:acmeAsset/event`,
        `${topicPath}/hub`,
      ]) {
        for (const query of [
          "",
          "?fields=none",
          "?offset=999&limit=1",
          "?limit=1",
          "?count=false",
        ]) {
          const response = yield* http.get(`${path}${query}`, admin);
          const repeated = yield* http.get(`${path}${query}`, admin);
          assert.strictEqual(response.status, 200, response.text);
          assert.strictEqual(
            response.headers.get("etag"),
            yield* textTag(response.text)
          );
          assert.strictEqual(
            repeated.headers.get("etag"),
            yield* textTag(repeated.text)
          );
          // Resource events include the current renderedAt. Their bytes may
          // change between requests without a stored record changing.
          assert.strictEqual(
            repeated.headers.get("etag") === response.headers.get("etag"),
            repeated.text === response.text
          );
          assert.strictEqual(response.headers.get("cache-control"), "no-store");
        }
      }
    }).pipe(Effect.provide(hubTestLayer)));

  test("tags both shipped TMF621 collection resources with stable final bytes and unchanged cache policy", () =>
    Effect.gen(function* shippedCollections() {
      const http = yield* TestHttpClient;

      const agent = {
        token: yield* http.signIn("agent", "helpdesk-agent-demo-password"),
      };

      const created = yield* http.request("POST", TICKETS, {
        ...agent,
        body: ticketBody({ name: "Blåbær 東京 😀" }),
      });

      assert.strictEqual(created.status, 201, created.text);

      for (const path of [TICKETS, SPECIFICATIONS]) {
        for (const query of [
          "",
          "?fields=name",
          "?fields=none",
          "?offset=1000",
          "?limit=1",
        ]) {
          const response = yield* http.get(`${path}${query}`, agent);
          const repeated = yield* http.get(`${path}${query}`, agent);
          const head = yield* http.request("HEAD", `${path}${query}`, agent);
          assert.strictEqual(response.status, 200, response.text);
          assert.strictEqual(
            response.headers.get("etag"),
            yield* textTag(response.text)
          );
          assert.strictEqual(repeated.text, response.text);
          assert.strictEqual(
            repeated.headers.get("etag"),
            response.headers.get("etag")
          );
          assert.strictEqual(
            head.headers.get("etag"),
            response.headers.get("etag")
          );
          assert.strictEqual(head.text, "");
          // ApiNoStoreLayer currently covers /api/* only. Preserve that policy.
          assert.strictEqual(response.headers.get("cache-control"), null);
        }
      }
    }).pipe(
      Effect.provide(
        TestHttpClient.layer.pipe(Layer.provideMerge(helpdeskTestLayer()))
      )
    ));

  test("raw TCP HEAD matches collection GET tags and length with zero body bytes", () =>
    Effect.gen(function* rawTcp() {
      const http = yield* TestHttpClient;
      const token = yield* http.signIn("alice", "alice-password");
      yield* createFixtureTicket(
        { token },
        { description: "wire", name: "Blåbær 東京 😀" }
      );

      const server = yield* Layer.build(
        HttpRouter.serve(Layer.merge(HttpAppLayer, tmfRoutes([FIXTURE_API])), {
          middleware: answerApiFailures,
        }).pipe(
          Layer.provideMerge(
            NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
          )
        )
      );

      const { address } = yield* HttpServer.HttpServer.pipe(
        Effect.provide(server)
      );

      assert.strictEqual(address._tag, "InetAddressV4");

      if (address._tag === "UnixPathAddress") {
        throw new Error("Expected TCP listener");
      }

      const origin = `http://127.0.0.1:${address.port}`;

      for (const path of [
        API.asset,
        `${API.asset}?fields=none`,
        `${FIXTURE_TICKETS}?fields=name`,
        "/api/v1/tableMetadata",
      ]) {
        const get = yield* wireRequest(origin, path, "GET", token);
        const head = yield* wireRequest(origin, path, "HEAD", token);
        const getEnd = get.indexOf("\r\n\r\n");
        const headEnd = head.indexOf("\r\n\r\n");
        assert.isAtLeast(getEnd, 0);
        assert.isAtLeast(headEnd, 0);
        const body = get.subarray(getEnd + 4);

        const getHeaders = get
          .subarray(0, getEnd)
          .toString("utf-8")
          .split("\r\n");

        const headHeaders = head
          .subarray(0, headEnd)
          .toString("utf-8")
          .split("\r\n");

        assert.strictEqual(getHeaders[0], "HTTP/1.1 200 OK");
        assert.strictEqual(headHeaders[0], getHeaders[0]);
        assert.strictEqual(head.subarray(headEnd + 4).byteLength, 0);
        const expected = yield* bodyTag(body);
        assert.include(getHeaders, `etag: ${expected}`);
        assert.include(headHeaders, `etag: ${expected}`);
        assert.include(getHeaders, `content-length: ${body.byteLength}`);
        assert.include(headHeaders, `content-length: ${body.byteLength}`);

        if (path.startsWith("/api/")) {
          assert.include(headHeaders, "cache-control: no-store");
        }
      }
    }).pipe(Effect.provide(tmfTestLayer())));
});
