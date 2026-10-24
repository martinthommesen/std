import { randomUUID } from "node:crypto";
import { createServer, request as nodeRequest } from "node:http";
import type { OutgoingHttpHeaders } from "node:http";
import { MIMEType } from "node:util";

import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { UnknownField } from "@std/api/errors/unknown-field";
import { TMF688_PREFIX } from "@std/api/tmf688";
import { parseJson } from "@std/values/json";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { ACME } from "../../testing/src/acme-ids.ts";
import { seedDeadLetters } from "../../testing/src/dead-letter-fixture.ts";
import { HelpdeskFixture } from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { answerApiFailures } from "../src/http/api-cache.ts";
import { jsonAnswer } from "../src/http/api/records.ts";
import { tmfErrorResponse } from "../src/http/api/tmf-error.ts";
import { HttpAppLayer, tmfRoutes } from "../src/http/app.ts";
import { tmfRouteErrorResponse } from "../src/http/tmf/errors.ts";
import {
  API,
  asArray,
  asObject,
  JSON_PATCH,
  MERGE_PATCH,
  textOf,
  UNKNOWN_ID,
} from "./api-support.ts";
import { itilLayer } from "./itil-support.ts";
import { addField } from "./schema-support.ts";
import { FIXTURE_API, FIXTURE_TICKETS, tmfTestLayer } from "./tmf-fixture.ts";
import { SPECIFICATIONS, ticketBody, TICKETS } from "./tmf621-support.ts";

const UNICODE = "Blåbær 東京 😀";

// Independent UTF-8 octets, including two-, three- and four-byte characters.
const UNICODE_BYTES = Buffer.from(
  "426cc3a562c3a67220e69db1e4baac20f09f9880",
  "hex"
);

const UNSUPPORTED_ACCEPT = "application/xml";

const mediaServer = Effect.gen(function* mediaServer() {
  const server = yield* Layer.build(
    HttpRouter.serve(Layer.merge(HttpAppLayer, tmfRoutes([FIXTURE_API])), {
      middleware: answerApiFailures,
    }).pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
      )
    )
  );

  const { address } = yield* HttpServer.HttpServer.pipe(Effect.provide(server));

  if (address._tag === "UnixPathAddress") {
    return yield* Effect.die(new Error("Expected TCP server"));
  }

  return `http://127.0.0.1:${address.port}`;
});

interface WireResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly bytes: Buffer;
}

// Keep octets until assertions: decoding in a client helper would hide bad UTF-8.
const wireRequest = (
  origin: string,
  path: string,
  options: {
    readonly method?: string;
    readonly token?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
  } = {}
) =>
  Effect.callback<WireResponse>((resume) => {
    const bytes =
      options.body === undefined
        ? undefined
        : Buffer.from(JSON.stringify(options.body), "utf-8");

    const headers: OutgoingHttpHeaders = { ...options.headers };

    if (options.token !== undefined) {
      headers.authorization = `Bearer ${options.token}`;
    }

    if (bytes !== undefined) {
      headers["content-length"] = String(bytes.byteLength);
      headers["content-type"] ??= "application/json";
    }

    const request = nodeRequest(
      `${origin}${path}`,
      {
        headers,
        method: options.method ?? "GET",
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on("error", (error) => {
          resume(Effect.die(error));
        });
        response.on("end", () => {
          resume(
            Effect.succeed({
              bytes: Buffer.concat(chunks),
              headers: response.headers,
              status: response.statusCode ?? 0,
            })
          );
        });
      }
    );

    request.on("error", (error) => {
      resume(Effect.die(error));
    });

    if (bytes !== undefined) {
      // Split an actual multi-byte character across writes when present.
      const emoji = bytes.indexOf(Buffer.from("f09f9880", "hex"));
      const split = emoji === -1 ? bytes.length : emoji + 1;
      request.write(bytes.subarray(0, split));
      request.write(bytes.subarray(split));
    }

    request.end();

    return Effect.sync(() => request.destroy());
  });

const jsonOf = (
  response: WireResponse,
  status: number,
  media = "application/json"
) => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(response.bytes);
  assert.strictEqual(response.status, status, text);
  assert.isString(response.headers["content-type"]);
  const type = new MIMEType(String(response.headers["content-type"]));
  assert.strictEqual(type.essence, media);
  // RFC 8259 §§8.1,11: UTF-8 is required; no charset parameter is defined.
  // Existing optional charset spelling/spacing is not a representation contract.
  const charset = type.params.get("charset");
  assert.isTrue(charset === null || charset.toLowerCase() === "utf-8");
  assert.deepStrictEqual(response.bytes, Buffer.from(text, "utf-8"));
  assert.strictEqual(
    response.headers["content-length"],
    String(response.bytes.length)
  );
  const parsed = parseJson(text);
  assert.isTrue(parsed.ok, text);

  if (!parsed.ok) {
    throw new Error("Expected JSON response");
  }

  return parsed.value;
};

const empty = (response: WireResponse) => {
  assert.strictEqual(response.status, 204);
  assert.strictEqual(response.bytes.length, 0);
  assert.isUndefined(response.headers["content-type"]);
};

const checkReadMedia = Effect.fn("HttpMedia.checkReadMedia")(
  function* checkReadMedia(
    origin: string,
    token: string,
    targets: readonly (readonly [string, number])[]
  ) {
    for (const [path, status] of targets) {
      const normal = yield* wireRequest(origin, path, { token });

      const unsupported = yield* wireRequest(origin, path, {
        headers: { accept: UNSUPPORTED_ACCEPT },
        token,
      });

      jsonOf(normal, status);
      jsonOf(unsupported, status);
      assert.deepStrictEqual(unsupported.bytes, normal.bytes, path);

      if (status !== 200) {
        continue;
      }

      const custom = yield* wireRequest(origin, path, {
        headers: { "x-format": "xml", "x-response-format": "xml" },
        token,
      });

      jsonOf(custom, 200);
      assert.deepStrictEqual(custom.bytes, normal.bytes, path);

      for (const parameter of [
        "format",
        "$format",
        "_format",
        "output",
        "callback",
      ]) {
        const url = new URL(path, origin);
        url.searchParams.set(
          parameter,
          parameter === "callback" ? "render" : "xml"
        );

        const response = yield* wireRequest(
          origin,
          `${url.pathname}${url.search}`,
          { token }
        );

        const body = jsonOf(response, response.status);

        if (response.status === 200) {
          assert.deepStrictEqual(response.bytes, normal.bytes, url.href);
        } else {
          assert.strictEqual(response.status, 400, url.href);
          assert.include(
            ["InvalidRequest", "UnknownField"],
            asObject(body).code
          );
        }
      }

      for (const extension of [".xml", ".json"]) {
        const url = new URL(path, origin);
        url.pathname += extension;

        const response = yield* wireRequest(
          origin,
          `${url.pathname}${url.search}`,
          { token }
        );

        const body = jsonOf(response, response.status);
        assert.include([400, 404, 405], response.status, url.href);
        assert.include(
          [
            "InvalidRequest",
            "UnknownField",
            "UnknownTable",
            "NotFound",
            "MethodNotAllowed",
          ],
          asObject(body).code
        );
      }
    }
  }
);

describe("http-media", () => {
  it("JSON success and error constructors expose their actual representation media", () => {
    const failure = new UnknownField({ field: UNICODE });

    for (const [response, media] of [
      [jsonAnswer({ name: UNICODE }, 200), "application/json"],
      [tmfErrorResponse(failure), "application/json"],
      [tmfRouteErrorResponse(failure, [400]), "application/json"],
    ] as const) {
      const web = HttpServerResponse.toWeb(response);
      assert.strictEqual(
        new MIMEType(web.headers.get("content-type") ?? "").essence,
        media
      );
    }
  });

  it.effect(
    "generic writes exchange UTF-8 octets and return JSON for every offered PATCH MIME and its errors",
    () =>
      Effect.gen(function* genericWrites() {
        const http = yield* TestHttpClient;
        const token = yield* http.signIn("alice", "alice-password");
        const origin = yield* mediaServer;
        assert.deepStrictEqual(Buffer.from(UNICODE, "utf-8"), UNICODE_BYTES);

        const created = yield* wireRequest(origin, API.monitor, {
          body: { name: UNICODE },
          headers: { accept: UNSUPPORTED_ACCEPT },
          method: "POST",
          token,
        });

        const record = asObject(jsonOf(created, 201));
        assert.strictEqual(record.name, UNICODE);
        assert.isTrue(created.bytes.includes(UNICODE_BYTES));
        const path = `${API.monitor}/${textOf(record.id)}`;
        let etag = String(created.headers.etag);

        for (const [index, contentType] of [
          "application/json",
          "application/json; charset=UTF-8",
          MERGE_PATCH,
          JSON_PATCH,
        ].entries()) {
          const name = `${UNICODE} ${index}`;

          const patched = yield* wireRequest(origin, path, {
            body:
              contentType === JSON_PATCH
                ? [{ op: "replace", path: "/name", value: name }]
                : { name },
            headers: {
              accept: UNSUPPORTED_ACCEPT,
              "content-type": contentType,
              "if-match": etag,
            },
            method: "PATCH",
            token,
          });

          assert.strictEqual(asObject(jsonOf(patched, 200)).name, name);
          assert.isTrue(patched.bytes.includes(UNICODE_BYTES));
          etag = String(patched.headers.etag);

          const invalid = yield* wireRequest(origin, path, {
            body:
              contentType === JSON_PATCH
                ? [{ op: "add", path: "/東京😀", value: 1 }]
                : { "東京😀": 1 },
            headers: {
              accept: UNSUPPORTED_ACCEPT,
              "content-type": contentType,
              "if-match": etag,
            },
            method: "PATCH",
            token,
          });

          assert.strictEqual(
            asObject(jsonOf(invalid, 400)).code,
            "UnknownField"
          );
          assert.isTrue(invalid.bytes.includes(Buffer.from("東京😀", "utf-8")));
        }

        const unsupported = yield* wireRequest(origin, path, {
          body: { name: UNICODE },
          headers: { "content-type": "application/xml", "if-match": etag },
          method: "PATCH",
          token,
        });

        assert.strictEqual(
          asObject(jsonOf(unsupported, 415)).code,
          "UnsupportedMediaType"
        );
        const read = yield* wireRequest(origin, path, { token });
        assert.strictEqual(asObject(jsonOf(read, 200)).name, `${UNICODE} 3`);

        const history = jsonOf(
          yield* wireRequest(origin, `${path}/history`, { token }),
          200
        );

        assert.lengthOf(asArray(history), 5);
        empty(
          yield* wireRequest(origin, path, {
            headers: { "if-match": etag },
            method: "DELETE",
            token,
          })
        );
        empty(
          yield* wireRequest(origin, API.monitor, { method: "OPTIONS", token })
        );
      }).pipe(Effect.provide(tmfTestLayer()), TestClock.withLive)
  );

  it.effect(
    "generic and fixed resource variants identify their payload media and unsupported Accept keeps JSON bytes",
    () =>
      Effect.gen(function* genericReads() {
        const http = yield* TestHttpClient;
        const token = yield* http.signIn("ada", "ada-password");
        const bob = yield* http.signIn("bob", "bob-password");
        const { records } = yield* AcmeFixture;
        const origin = yield* mediaServer;
        const seeded = yield* seedDeadLetters({ token });

        const applied = asObject(
          jsonOf(
            yield* wireRequest(origin, "/api/v1/applyChangeSet", {
              body: {
                operations: [
                  addField(ACME.asset, "media_note", { kind: "text" }).op,
                ],
              },
              headers: { accept: UNSUPPORTED_ACCEPT },
              method: "POST",
              token,
            }),
            201
          )
        );

        jsonOf(
          yield* wireRequest(origin, "/api/v1/applyChangeSet", {
            body: { operations: [] },
            method: "POST",
            token,
          }),
          200
        );
        jsonOf(
          yield* wireRequest(origin, "/api/v1/checkFormState", {
            body: {
              id: null,
              revision: null,
              table: "acmeAsset",
              values: { name: UNICODE, status: "spare" },
            },
            headers: { accept: UNSUPPORTED_ACCEPT },
            method: "POST",
            token,
          }),
          200
        );

        yield* checkReadMedia(origin, token, [
          [`/api/v1/deadDelivery/${seeded.firstId}`, 200],
        ]);

        const session = asObject(
          jsonOf(
            yield* wireRequest(origin, "/api/v1/session", {
              body: {
                login: "alice",
                password: "alice-password",
                tokenDelivery: "body",
              },
              headers: { accept: UNSUPPORTED_ACCEPT },
              method: "POST",
            }),
            201
          )
        );

        empty(
          yield* wireRequest(origin, "/api/v1/session/current", {
            method: "DELETE",
            token: textOf(session.token),
          })
        );
        assert.strictEqual(
          asObject(
            jsonOf(
              yield* wireRequest(origin, "/api/v1/session", {
                body: { login: "alice", password: "wrong-password" },
                headers: { accept: UNSUPPORTED_ACCEPT },
                method: "POST",
              }),
              401
            )
          ).code,
          "InvalidCredentials"
        );

        const task = asObject(
          jsonOf(
            yield* wireRequest(origin, "/api/v1/retryDeadDelivery", {
              body: { deliveryId: seeded.firstId },
              headers: { accept: UNSUPPORTED_ACCEPT },
              method: "POST",
              token,
            }),
            201
          )
        );

        jsonOf(
          yield* wireRequest(origin, "/api/v1/discardDeadDelivery", {
            body: { deliveryId: seeded.secondId },
            headers: { accept: UNSUPPORTED_ACCEPT },
            method: "POST",
            token,
          }),
          201
        );

        const history = yield* http.get(`${API.laptop}/${records.L}/history`, {
          token,
        });

        const entry = asObject(asArray(history.json)[0]);
        yield* checkReadMedia(origin, token, [
          [API.asset, 200],
          [`${API.asset}?fields=name&limit=1`, 200],
          [`${API.asset}/${records.L}`, 200],
          [`${API.laptop}/${records.L}?fields=none`, 200],
          [`${API.laptop}/${records.L}/history`, 200],
          [new URL(textOf(entry.href)).pathname, 200],
          ["/api/v1/coreRole", 200],
          ["/api/v1/session/current", 200],
          ["/api/v1/tableMetadata", 200],
          ["/api/v1/tableMetadata/acmeAsset", 200],
          ["/api/v1/tableMetadata/acmeAsset/openapi.json", 200],
          ["/api/v1/tableMetadata/acmeAsset/schema.json", 200],
          ["/api/v1/openapi.json", 200],
          ["/api/v1/deadDelivery", 200],
          [`/api/v1/deadDelivery/${seeded.secondId}`, 404],
          ["/api/v1/coreDeadDeliveryAction", 200],
          [new URL(textOf(task.href)).pathname, 200],
          [new URL(textOf(applied.href)).pathname, 200],
          [`${API.asset}/${UNKNOWN_ID}`, 404],
          [`${API.asset}?limit=0`, 400],
          ["/api/v1/not/a/known/path", 404],
          ["/api/v1/session", 405],
          ["/api/v1/tableMetadata/noSuchTable/schema.json", 404],
        ]);

        const masked = jsonOf(
          yield* wireRequest(origin, `${API.laptop}/${records.L}`, {
            headers: { accept: UNSUPPORTED_ACCEPT },
            token: bob,
          }),
          200
        );

        assert.isUndefined(asObject(masked).cost);
        jsonOf(
          yield* wireRequest(origin, API.asset, {
            headers: { accept: UNSUPPORTED_ACCEPT },
          }),
          401
        );

        // This is a separate schema resource, not a suffix representation of a record.
        for (const accept of [
          undefined,
          "application/schema+json",
          UNSUPPORTED_ACCEPT,
        ]) {
          const schema = jsonOf(
            yield* wireRequest(
              origin,
              "/api/v1/tableMetadata/acmeAsset/schema.json",
              {
                headers: accept === undefined ? {} : { accept },
                token,
              }
            ),
            200
          );

          assert.strictEqual(asObject(schema).title, "AcmeAsset");
        }
      }).pipe(Effect.provide(tmfTestLayer()), TestClock.withLive)
  );

  it.effect(
    "definition writes return representation JSON rather than the merge-patch request MIME",
    () =>
      Effect.gen(function* definitionMedia() {
        const http = yield* TestHttpClient;
        const token = yield* http.signIn("ada", "ada-password");
        const origin = yield* mediaServer;

        const created = yield* wireRequest(origin, "/api/v1/coreRole", {
          body: {
            label: UNICODE,
            name: `media_${randomUUID().replaceAll("-", "")}`,
          },
          headers: { accept: UNSUPPORTED_ACCEPT },
          method: "POST",
          token,
        });

        const role = asObject(jsonOf(created, 201));
        const path = `/api/v1/coreRole/${textOf(role.id)}`;
        let etag = String(created.headers.etag);

        for (const contentType of [
          "application/json",
          "application/json; charset=UTF-8",
          MERGE_PATCH,
        ]) {
          const patched = yield* wireRequest(origin, path, {
            body: { label: `${UNICODE} changed` },
            headers: {
              accept: UNSUPPORTED_ACCEPT,
              "content-type": contentType,
              "if-match": etag,
            },
            method: "PATCH",
            token,
          });

          assert.strictEqual(
            asObject(jsonOf(patched, 200)).label,
            `${UNICODE} changed`
          );
          etag = String(patched.headers.etag);
        }

        const refused = yield* wireRequest(origin, path, {
          body: [{ op: "replace", path: "/label", value: UNICODE }],
          headers: {
            accept: UNSUPPORTED_ACCEPT,
            "content-type": JSON_PATCH,
            "if-match": etag,
          },
          method: "PATCH",
          token,
        });

        assert.strictEqual(
          asObject(jsonOf(refused, 415)).code,
          "UnsupportedMediaType"
        );
        empty(
          yield* wireRequest(origin, path, {
            headers: { "if-match": etag },
            method: "DELETE",
            token,
          })
        );
      }).pipe(Effect.provide(tmfTestLayer()), TestClock.withLive)
  );

  it.effect(
    "mapped resources exchange Unicode JSON for plain, merge and JSON Patch requests including mapped errors",
    () =>
      Effect.gen(function* mappedMedia() {
        const http = yield* TestHttpClient;
        const token = yield* http.signIn("alice", "alice-password");
        const bob = yield* http.signIn("bob", "bob-password");
        const origin = yield* mediaServer;

        const created = yield* wireRequest(origin, FIXTURE_TICKETS, {
          body: {
            "@type": "TroubleTicket",
            description: UNICODE,
            name: UNICODE,
            priority: "High",
          },
          headers: { accept: UNSUPPORTED_ACCEPT },
          method: "POST",
          token,
        });

        const path = `${FIXTURE_TICKETS}/${textOf(asObject(jsonOf(created, 201)).id)}`;
        assert.isTrue(created.bytes.includes(UNICODE_BYTES));

        for (const contentType of [
          "application/json",
          "application/json; charset=UTF-8",
          MERGE_PATCH,
          JSON_PATCH,
        ]) {
          const patched = yield* wireRequest(origin, path, {
            body:
              contentType === JSON_PATCH
                ? [{ op: "replace", path: "/name", value: UNICODE }]
                : { name: UNICODE },
            headers: {
              accept: UNSUPPORTED_ACCEPT,
              "content-type": contentType,
            },
            method: "PATCH",
            token,
          });

          assert.strictEqual(asObject(jsonOf(patched, 200)).name, UNICODE);
          assert.isTrue(patched.bytes.includes(UNICODE_BYTES));

          const invalid = yield* wireRequest(origin, path, {
            body:
              contentType === JSON_PATCH
                ? [{ op: "add", path: "/東京😀", value: 1 }]
                : { "東京😀": 1 },
            headers: {
              accept: UNSUPPORTED_ACCEPT,
              "content-type": contentType,
            },
            method: "PATCH",
            token,
          });

          assert.strictEqual(
            asObject(jsonOf(invalid, 400)).code,
            "UnknownField"
          );
        }

        const invalidMime = yield* wireRequest(origin, path, {
          body: {},
          headers: {
            accept: UNSUPPORTED_ACCEPT,
            "content-type": "application/xml",
          },
          method: "PATCH",
          token,
        });

        assert.strictEqual(
          asObject(jsonOf(invalidMime, 400)).code,
          "InvalidRequest"
        );
        yield* checkReadMedia(origin, token, [
          [FIXTURE_TICKETS, 200],
          [`${FIXTURE_TICKETS}?fields=name`, 200],
          [path, 200],
          [`${path}?fields=none`, 200],
          [`${FIXTURE_TICKETS}/${UNKNOWN_ID}`, 404],
          [`${FIXTURE_TICKETS}?limit=0`, 400],
        ]);
        assert.isUndefined(
          asObject(
            jsonOf(
              yield* wireRequest(origin, path, {
                headers: { accept: UNSUPPORTED_ACCEPT },
                token: bob,
              }),
              200
            )
          ).priority
        );
        empty(yield* wireRequest(origin, path, { method: "DELETE", token }));
      }).pipe(Effect.provide(tmfTestLayer()), TestClock.withLive)
  );

  it.effect(
    "shipped TMF621 tickets and specifications declare JSON on reads, writes and pinned errors",
    () =>
      Effect.gen(function* shippedMedia() {
        const http = yield* TestHttpClient;
        const fixture = yield* HelpdeskFixture;

        const token = yield* http.signIn(
          fixture.admin.login,
          fixture.admin.password
        );

        const origin = yield* mediaServer;

        for (const [collection, body] of [
          [TICKETS, ticketBody({ description: UNICODE, name: UNICODE })],
          [SPECIFICATIONS, { name: UNICODE }],
        ] as const) {
          const created = yield* wireRequest(origin, collection, {
            body,
            headers: { accept: UNSUPPORTED_ACCEPT },
            method: "POST",
            token,
          });

          const path = `${collection}/${textOf(asObject(jsonOf(created, 201)).id)}`;
          assert.isTrue(created.bytes.includes(UNICODE_BYTES));

          for (const contentType of [
            "application/json",
            MERGE_PATCH,
            JSON_PATCH,
          ]) {
            const patched = yield* wireRequest(origin, path, {
              body:
                contentType === JSON_PATCH
                  ? [{ op: "replace", path: "/name", value: UNICODE }]
                  : { name: UNICODE },
              headers: {
                accept: UNSUPPORTED_ACCEPT,
                "content-type": contentType,
              },
              method: "PATCH",
              token,
            });

            assert.strictEqual(asObject(jsonOf(patched, 200)).name, UNICODE);

            const invalid = yield* wireRequest(origin, path, {
              body:
                contentType === JSON_PATCH
                  ? [{ op: "add", path: "/東京😀", value: 1 }]
                  : { "東京😀": 1 },
              headers: {
                accept: UNSUPPORTED_ACCEPT,
                "content-type": contentType,
              },
              method: "PATCH",
              token,
            });

            assert.strictEqual(
              asObject(jsonOf(invalid, 400)).code,
              "UnknownField"
            );
          }

          yield* checkReadMedia(origin, token, [
            [collection, 200],
            [`${collection}?fields=name`, 200],
            [path, 200],
            [`${path}?fields=none`, 200],
            [`${collection}/${UNKNOWN_ID}`, 404],
            [`${collection}?limit=0`, 400],
          ]);
          jsonOf(
            yield* wireRequest(origin, path, {
              headers: { accept: UNSUPPORTED_ACCEPT },
            }),
            401
          );
          empty(yield* wireRequest(origin, path, { method: "DELETE", token }));
        }
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "generic, mapped and TMF688 hubs declare JSON for registrations, reads and errors",
    () =>
      Effect.gen(function* hubMedia() {
        const http = yield* TestHttpClient;
        const token = yield* http.signIn("ada", "ada-password");
        const origin = yield* mediaServer;
        const callback = "https://listener.example.test/events";
        const topics = `${TMF688_PREFIX}/topic`;

        const topic = asObject(
          jsonOf(
            yield* wireRequest(origin, topics, {
              body: { name: "hub media" },
              method: "POST",
              token,
            }),
            201
          )
        );

        const topicPath = `${topics}/${textOf(topic.id)}`;

        for (const [collection, query] of [
          ["/api/v1/hub", "resource=acmeAsset"],
          [`${FIXTURE_API.basePath}/hub`, "eventType=TroubleTicketCreateEvent"],
          [`${TMF688_PREFIX}/hub`, "eventType=TopicCreateEvent"],
          [`${topicPath}/hub`, "eventType=Custom"],
        ] as const) {
          const hub = asObject(
            jsonOf(
              yield* wireRequest(origin, collection, {
                body: { "@type": "Hub", callback, query },
                headers: { accept: UNSUPPORTED_ACCEPT },
                method: "POST",
                token,
              }),
              201
            )
          );

          const path = `${collection}/${textOf(hub.id)}`;
          yield* checkReadMedia(origin, token, [
            [path, 200],
            [`${collection}/${UNKNOWN_ID}`, 404],
          ]);
          jsonOf(
            yield* wireRequest(origin, path, {
              headers: { accept: UNSUPPORTED_ACCEPT },
            }),
            401
          );
          jsonOf(
            yield* wireRequest(origin, path, {
              body: {},
              headers: {
                accept: UNSUPPORTED_ACCEPT,
                "content-type": MERGE_PATCH,
              },
              method: "PATCH",
              token,
            }),
            405
          );
          empty(yield* wireRequest(origin, path, { method: "DELETE", token }));
        }

        for (const accept of [undefined, UNSUPPORTED_ACCEPT]) {
          const events = jsonOf(
            yield* wireRequest(
              origin,
              `${TMF688_PREFIX}/topic/record:acmeAsset/event`,
              {
                headers: accept === undefined ? {} : { accept },
                token,
              }
            ),
            200
          );

          assert.isAbove(asArray(events).length, 0);
        }

        yield* checkReadMedia(origin, token, [
          [`${topicPath}/hub`, 200],
          [`${TMF688_PREFIX}/topic/record:acmeAsset`, 200],
          [
            `${TMF688_PREFIX}/topic/record:acmeAsset/event?fields=eventId,eventType`,
            200,
          ],
        ]);
      }).pipe(Effect.provide(tmfTestLayer()), TestClock.withLive)
  );

  it.effect(
    "TMF688 topics and client events preserve UTF-8 JSON and ignore unsupported response media",
    () =>
      Effect.gen(function* eventMedia() {
        const http = yield* TestHttpClient;
        const token = yield* http.signIn("ada", "ada-password");
        const origin = yield* mediaServer;
        const topics = `${TMF688_PREFIX}/topic`;

        const topic = jsonOf(
          yield* wireRequest(origin, topics, {
            body: { name: UNICODE },
            headers: { accept: UNSUPPORTED_ACCEPT },
            method: "POST",
            token,
          }),
          201
        );

        const path = `${topics}/${textOf(asObject(topic).id)}`;

        const event = yield* wireRequest(origin, `${path}/event`, {
          body: {
            "@type": "Custom",
            event: { text: UNICODE },
            eventId: "media-event",
            eventType: "Custom",
          },
          headers: { accept: UNSUPPORTED_ACCEPT },
          method: "POST",
          token,
        });

        const eventPath = `${path}/event/${textOf(asObject(jsonOf(event, 201)).id)}`;
        assert.isTrue(event.bytes.includes(UNICODE_BYTES));
        yield* checkReadMedia(origin, token, [
          [topics, 200],
          [path, 200],
          [`${path}/event`, 200],
          [eventPath, 200],
          [`${topics}/${UNKNOWN_ID}`, 404],
          [`${topics}?limit=0`, 400],
        ]);
        jsonOf(
          yield* wireRequest(origin, path, {
            headers: { accept: UNSUPPORTED_ACCEPT },
          }),
          401
        );
        jsonOf(
          yield* wireRequest(origin, path, {
            body: {},
            headers: {
              accept: UNSUPPORTED_ACCEPT,
              "content-type": MERGE_PATCH,
            },
            method: "PATCH",
            token,
          }),
          405
        );
        assert.strictEqual(
          asObject(
            jsonOf(
              yield* wireRequest(origin, path, { method: "DELETE", token }),
              409
            )
          ).code,
          "Referenced"
        );

        const unused = asObject(
          jsonOf(
            yield* wireRequest(origin, topics, {
              body: { name: "empty" },
              method: "POST",
              token,
            }),
            201
          )
        );

        empty(
          yield* wireRequest(origin, `${topics}/${textOf(unused.id)}`, {
            method: "DELETE",
            token,
          })
        );
      }).pipe(Effect.provide(tmfTestLayer()), TestClock.withLive)
  );
});
