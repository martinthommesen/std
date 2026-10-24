import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { TMF688_PREFIX } from "@std/api/tmf688";
import { Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { ACME } from "../../testing/src/acme-ids.ts";
import { seedDeadLetters } from "../../testing/src/dead-letter-fixture.ts";
import { HelpdeskFixture } from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestRequestOptions } from "../../testing/src/http-client.ts";
import { answerApiFailures } from "../src/http/api-cache.ts";
import { withoutBody } from "../src/http/api/methods.ts";
import { HttpAppLayer, tmfRoutes } from "../src/http/app.ts";
import { API, asArray, asObject, textOf, UNKNOWN_ID } from "./api-support.ts";
import { edgeRequest } from "./http-edge-support.ts";
import { itilLayer } from "./itil-support.ts";
import { readsTestLayer } from "./reads-support.ts";
import { addField } from "./schema-support.ts";
import {
  createFixtureTicket,
  FIXTURE_API,
  FIXTURE_TICKETS,
  tmfTestLayer,
} from "./tmf-fixture.ts";
import { TICKETS, SPECIFICATIONS, ticketBody } from "./tmf621-support.ts";

const UNICODE = "Blåbær 東京 😀";

const headersWithoutDate = (headers: Headers) =>
  [...headers].filter(([name]) => name !== "date");

// HEAD removes content, not the selected GET representation's metadata.
const compareHead = Effect.fn("Test.compareHead")(function* compareHead(
  path: string,
  options: TestRequestOptions,
  status = 200
) {
  const http = yield* TestHttpClient;
  const get = yield* http.get(path, options);
  const head = yield* http.request("HEAD", path, options);
  assert.strictEqual(get.status, status, `${path}: ${get.text}`);
  assert.strictEqual(head.status, get.status, path);
  assert.strictEqual(head.text, "", path);
  assert.strictEqual(
    get.headers.get("content-length"),
    String(Buffer.byteLength(get.text)),
    path
  );
  // Date can change between requests; all application headers must agree.
  assert.deepStrictEqual(
    headersWithoutDate(head.headers),
    headersWithoutDate(get.headers),
    path
  );

  return get;
});

describe("head-metadata", () => {
  it("preserves known representation metadata, statuses and cookies without consuming unknown streams", () => {
    const bytes = new TextEncoder().encode(UNICODE);

    const metadata = {
      "cache-control": "no-store",
      etag: '"revision"',
      "last-modified": "Wed, 21 Oct 2026 10:00:00 GMT",
      link: '</resource>; rel="self"',
    };

    const responses = [
      HttpServerResponse.text(UNICODE, {
        headers: metadata,
        statusText: "Fixture OK",
      }),
      HttpServerResponse.text(""),
      HttpServerResponse.setHeader(
        HttpServerResponse.text(UNICODE),
        "content-type",
        "application/custom"
      ),
      HttpServerResponse.jsonUnsafe(
        { reason: UNICODE },
        { headers: { "retry-after": "1" }, status: 503 }
      ),
      HttpServerResponse.jsonUnsafe(
        { name: UNICODE },
        { headers: metadata, status: 404 }
      ),
      HttpServerResponse.uint8Array(bytes),
      HttpServerResponse.stream(Stream.fromIterable([bytes]), {
        contentLength: bytes.byteLength,
        contentType: "application/json",
      }),
      HttpServerResponse.stream(
        Stream.die(new Error("HEAD must not pull the stream")),
        { contentType: "application/json" }
      ),
      HttpServerResponse.raw("opaque", {
        headers: {
          "content-length": "6",
          "content-type": "application/custom",
        },
      }),
      HttpServerResponse.empty({ status: 204 }),
      HttpServerResponse.empty({
        headers: { etag: '"unchanged"' },
        status: 304,
      }),
    ];

    for (const response of responses) {
      const original = HttpServerResponse.setCookieUnsafe(
        response,
        "fixture",
        "value"
      );

      const head = withoutBody(original);
      assert.strictEqual(head.body._tag, "Empty");
      assert.strictEqual(head.status, original.status);
      assert.strictEqual(head.statusText, original.statusText);
      assert.deepStrictEqual(head.headers, original.headers);
      assert.deepStrictEqual(head.cookies, original.cookies);
      assert.deepStrictEqual(withoutBody(head).headers, head.headers);
    }

    assert.strictEqual(
      responses[0]?.headers["content-length"],
      String(bytes.byteLength)
    );
    assert.isAbove(bytes.byteLength, UNICODE.length);
  });

  it.live(
    "generic and fixed HEAD paths preserve GET byte lengths, projections, masks and error metadata",
    () =>
      Effect.gen(function* genericMetadata() {
        const http = yield* TestHttpClient;
        const alice = { token: yield* http.signIn("alice", "alice-password") };
        const bob = { token: yield* http.signIn("bob", "bob-password") };
        const admin = { token: yield* http.signIn("ada", "ada-password") };
        const { records } = yield* AcmeFixture;

        const created = yield* http.request("POST", API.monitor, {
          ...alice,
          body: { name: UNICODE },
        });

        assert.strictEqual(created.status, 201, created.text);
        const path = `${API.monitor}/${textOf(asObject(created.json).id)}`;
        const full = yield* compareHead(path, alice);
        assert.strictEqual(asObject(full.json).name, UNICODE);
        assert.isAbove(Buffer.byteLength(full.text), full.text.length);
        const projected = yield* compareHead(`${path}?fields=none`, alice);
        assert.isUndefined(asObject(projected.json).name);
        assert.isBelow(
          Number(projected.headers.get("content-length")),
          Number(full.headers.get("content-length"))
        );
        yield* compareHead(path, {
          cookie: yield* http.cookieSignIn("alice", "alice-password"),
        });

        for (const caller of [alice, bob, admin]) {
          for (const target of [
            API.asset,
            `${API.asset}?fields=name&limit=1`,
            `${API.asset}?fields=none`,
            `${API.asset}/${records.L}`,
            `${API.laptop}/${records.L}?fields=name`,
            `${API.laptop}/${records.L}/history`,
            `${API.laptop}/${records.L}/history?fields=none`,
            "/api/v1/session/current",
            "/api/v1/tableMetadata",
            "/api/v1/tableMetadata/acmeAsset",
            "/api/v1/tableMetadata/acmeAsset/schema.json",
            "/api/v1/tableMetadata/acmeAsset/openapi.json",
          ]) {
            const got = yield* compareHead(target, caller);
            assert.strictEqual(got.headers.get("cache-control"), "no-store");
          }
        }

        const masked = yield* compareHead(`${API.laptop}/${records.L}`, bob);
        assert.isUndefined(asObject(masked.json).cost);

        for (const target of [
          "checkFormState",
          "applyChangeSet",
          "retryDeadDelivery",
          "discardDeadDelivery",
        ]) {
          yield* compareHead(`/api/v1/${target}`, admin, 405);
        }

        const history = yield* http.get(`${path}/history`, alice);
        const entry = asObject(asArray(history.json)[0]);
        yield* compareHead(new URL(textOf(entry.href)).pathname, alice);
        yield* compareHead("/api/v1/openapi.json", {});

        for (const [target, caller, status] of [
          [path, {}, 401],
          [`${API.asset}/${records.K}`, bob, 404],
          [`${API.asset}/${UNKNOWN_ID}`, bob, 404],
          [`${API.asset}?limit=0`, alice, 400],
          [`${API.asset}?fields=name,!name`, alice, 409],
          ["/api/v1/session", {}, 405],
          ["/api/v1/not/a/known/path", alice, 404],
          [`/api/v1/applyChangeSet/${UNKNOWN_ID}`, admin, 404],
          [`/api/v1/deadDelivery/${UNKNOWN_ID}`, admin, 404],
        ] as const) {
          yield* compareHead(target, caller, status);
        }

        const seeded = yield* seedDeadLetters(admin);
        yield* compareHead("/api/v1/deadDelivery", admin);
        yield* compareHead(`/api/v1/deadDelivery/${seeded.firstId}`, admin);
        yield* compareHead(
          `/api/v1/deadDelivery/${seeded.firstId}?fields=attempts`,
          admin
        );

        const applied = yield* http.request("POST", "/api/v1/applyChangeSet", {
          ...admin,
          body: {
            operations: [
              addField(ACME.asset, "head_note", { kind: "text" }).op,
            ],
          },
        });

        assert.strictEqual(applied.status, 201, applied.text);
        yield* compareHead(
          new URL(textOf(asObject(applied.json).href)).pathname,
          admin
        );
      }).pipe(Effect.provide(readsTestLayer()))
  );

  it.live(
    "mapped collection and resource HEAD preserve Unicode, selected and masked GET metadata and mapped errors",
    () =>
      Effect.gen(function* mappedMetadata() {
        const http = yield* TestHttpClient;
        const alice = { token: yield* http.signIn("alice", "alice-password") };
        const bob = { token: yield* http.signIn("bob", "bob-password") };

        const ticket = yield* createFixtureTicket(alice, {
          description: UNICODE,
          name: UNICODE,
          priority: "High",
          status: "acknowledged",
        });

        const path = `${FIXTURE_TICKETS}/${textOf(ticket.id)}`;

        for (const caller of [alice, bob]) {
          for (const target of [
            FIXTURE_TICKETS,
            `${FIXTURE_TICKETS}?fields=name`,
            `${FIXTURE_TICKETS}?fields=none`,
            path,
            `${path}?fields=name`,
            `${path}?fields=none`,
          ]) {
            yield* compareHead(target, caller);
          }
        }

        const masked = yield* http.get(path, bob);
        assert.isUndefined(asObject(masked.json).priority);

        for (const [target, caller, status] of [
          [path, {}, 401],
          [`${FIXTURE_TICKETS}/${UNKNOWN_ID}`, alice, 404],
          [`${FIXTURE_TICKETS}?limit=0`, alice, 400],
        ] as const) {
          yield* compareHead(target, caller, status);
        }
      }).pipe(Effect.provide(tmfTestLayer()))
  );

  it.live(
    "shipped TMF621 collection and resource HEAD retain GET metadata, projections and pinned errors",
    () =>
      Effect.gen(function* shippedMetadata() {
        const http = yield* TestHttpClient;
        const fixture = yield* HelpdeskFixture;

        const agent = {
          token: yield* http.signIn(
            fixture.agent.login,
            fixture.agent.password
          ),
        };

        const created = yield* http.request("POST", TICKETS, {
          ...agent,
          body: ticketBody({ description: UNICODE, name: UNICODE }),
        });

        assert.strictEqual(created.status, 201, created.text);
        const path = `${TICKETS}/${textOf(asObject(created.json).id)}`;

        for (const target of [
          TICKETS,
          `${TICKETS}?fields=name`,
          path,
          `${path}?fields=none`,
          SPECIFICATIONS,
        ]) {
          yield* compareHead(target, agent);
        }

        const specifications = yield* http.get(SPECIFICATIONS, agent);
        const specification = asObject(asArray(specifications.json)[0]);
        yield* compareHead(
          `${SPECIFICATIONS}/${textOf(specification.id)}`,
          agent
        );
        yield* compareHead(`${TICKETS}/${UNKNOWN_ID}`, agent, 404);
        yield* compareHead(path, {}, 401);
        yield* compareHead(`${TICKETS}?limit=0`, agent, 400);
      }).pipe(Effect.provide(itilLayer))
  );

  it.live(
    "TCP HEAD carries the GET representation length and no bytes through the Node transport",
    () =>
      Effect.gen(function* tcpMetadata() {
        const http = yield* TestHttpClient;
        const token = yield* http.signIn("alice", "alice-password");

        const created = yield* createFixtureTicket(
          { token },
          { description: UNICODE, name: UNICODE }
        );

        const server = yield* Layer.build(
          HttpRouter.serve(
            Layer.merge(HttpAppLayer, tmfRoutes([FIXTURE_API])),
            { middleware: answerApiFailures }
          ).pipe(
            Layer.provideMerge(
              NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
            )
          )
        );

        const { address } = yield* HttpServer.HttpServer.pipe(
          Effect.provide(server)
        );

        if (address._tag === "UnixPathAddress") {
          throw new Error("Expected TCP server");
        }

        const origin = `http://127.0.0.1:${address.port}`;

        for (const [path, authenticated, status] of [
          [`${FIXTURE_TICKETS}/${textOf(created.id)}`, true, 200],
          [`${FIXTURE_TICKETS}?fields=name`, true, 200],
          [API.asset, true, 200],
          [`${API.asset}/${UNKNOWN_ID}`, true, 404],
          [API.asset, false, 401],
          ["/api/v1/session", false, 405],
          [`${FIXTURE_TICKETS}/extra/path`, true, 404],
          [`${TMF688_PREFIX}/topic`, true, 405],
          [`${TMF688_PREFIX}/topic/${UNKNOWN_ID}`, true, 405],
          [`${TMF688_PREFIX}/topic/${UNKNOWN_ID}/event`, true, 405],
          [
            `${TMF688_PREFIX}/topic/${UNKNOWN_ID}/event/${UNKNOWN_ID}`,
            true,
            405,
          ],
          [`${TMF688_PREFIX}/topic/${UNKNOWN_ID}/hub`, true, 405],
          [`${TMF688_PREFIX}/topic/${UNKNOWN_ID}/hub/${UNKNOWN_ID}`, true, 405],
          [`${TMF688_PREFIX}/hub/${UNKNOWN_ID}`, true, 405],
        ] as const) {
          const headers = authenticated
            ? { authorization: `Bearer ${token}` }
            : {};

          const get = yield* edgeRequest(origin, path, {
            headers,
            method: "GET",
          });

          const head = yield* edgeRequest(origin, path, {
            headers,
            method: "HEAD",
          });

          assert.strictEqual(head.status, status, path);
          assert.strictEqual(head.text, "", path);

          if (path.startsWith(TMF688_PREFIX)) {
            // TMF688 offers GET, but currently does not offer HEAD (405).
            assert.strictEqual(
              head.headers["content-type"],
              "application/json;charset=utf-8"
            );

            const rejected = yield* edgeRequest(origin, path, {
              headers,
              method: "PUT",
            });

            assert.strictEqual(rejected.status, 405);
            assert.strictEqual(
              rejected.headers["content-length"],
              String(Buffer.byteLength(rejected.text))
            );
            assert.strictEqual(
              head.headers["content-length"],
              rejected.headers["content-length"]
            );
            assert.strictEqual(head.headers["cache-control"], "no-store");
            continue;
          }

          assert.strictEqual(get.status, status, `${path}: ${get.text}`);
          assert.strictEqual(
            get.headers["content-length"],
            String(Buffer.byteLength(get.text)),
            path
          );

          for (const name of [
            "content-length",
            "content-type",
            "etag",
            "link",
            "content-location",
            "cache-control",
            "std-schema-revision",
            "x-result-count",
            "x-total-count",
            "allow",
          ]) {
            assert.deepStrictEqual(
              head.headers[name],
              get.headers[name],
              `${path}: ${name}`
            );
          }
        }
      }).pipe(Effect.provide(tmfTestLayer()))
  );
});
