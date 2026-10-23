import type { AsyncHook } from "node:async_hooks";
import { createHook } from "node:async_hooks";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it, layer } from "@effect/vitest";
import { checkPasswordLength, PASSWORD_MAX_LENGTH } from "@std/values/password";
import { Effect, Predicate, Schema } from "effect";
import type { VisitorObject } from "oxc-parser";
import { parseSync, Visitor } from "oxc-parser";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import { edgeRequest, edgeServer } from "./http-edge-support.ts";
import { readsTestLayer } from "./reads-support.ts";

const sourceFiles = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory() && entry.name !== "node_modules") {
      return sourceFiles(file);
    }

    return entry.isFile() && file.endsWith(".ts") ? [file] : [];
  });

const disableHook = (hook: AsyncHook) =>
  Effect.sync(() => {
    hook.disable();
  });

const SESSION = "/api/v1/session";
const MAX_PASSWORD = "🔑".repeat(PASSWORD_MAX_LENGTH);
const TOO_LONG = `${MAX_PASSWORD}x`;

// The alias lets the repository's test-file linter recognize Effect test files.
const test = it.effect;

describe("password-policy", () => {
  test("no shipped fixture or demo credential exceeds the shared code-point cap", () =>
    Effect.sync(() => {
      const root = new URL("../../../", import.meta.url).pathname;

      const paths = [
        ...sourceFiles(path.join(root, "examples")),
        ...sourceFiles(path.join(root, "packages/testing/src")),
      ];

      let checked = 0;

      for (const file of paths) {
        const { program, errors } = parseSync(
          file,
          readFileSync(file, "utf-8")
        );

        assert.isEmpty(errors, file);
        const ranges: { readonly start: number; readonly end: number }[] = [];

        const strings: { readonly start: number; readonly value: string }[] =
          [];

        const onCall: VisitorObject["CallExpression"] = (node) => {
          if (
            node.callee.type === "MemberExpression" &&
            node.callee.property.type === "Identifier" &&
            node.callee.property.name === "signIn"
          ) {
            const [, password] = node.arguments;

            if (password !== undefined) {
              ranges.push(password);
            }
          }
        };

        const onLiteral: VisitorObject["Literal"] = (node) => {
          if (Predicate.isString(node.value)) {
            strings.push({ start: node.start, value: node.value });
          }
        };

        const onProperty: VisitorObject["Property"] = (node) => {
          if (
            node.key.type === "Identifier" &&
            /password/iu.test(node.key.name)
          ) {
            ranges.push(node.value);
          }
        };

        const onVariable: VisitorObject["VariableDeclarator"] = (node) => {
          if (
            node.id.type === "Identifier" &&
            /password/iu.test(node.id.name) &&
            node.init !== null
          ) {
            ranges.push(node.init);
          }
        };

        new Visitor({
          CallExpression: onCall,
          Literal: onLiteral,
          Property: onProperty,
          VariableDeclarator: onVariable,
        }).visit(program);

        for (const literal of strings) {
          if (
            ranges.some(
              (range) =>
                literal.start >= range.start && literal.start < range.end
            )
          ) {
            assert.isTrue(
              checkPasswordLength(literal.value).ok,
              `${file}:${literal.start}`
            );
            checked += 1;
          }
        }
      }

      assert.isAbove(checked, 0);
    }));

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "creates and changes passwords by code points and refuses excess before KDF work",
      () =>
        Effect.gen(function* sharedPasswordPolicy() {
          const http = yield* TestHttpClient;
          const token = yield* http.signIn("ada", "ada-password");
          const origin = yield* edgeServer;
          let jobs = 0;

          const hook = createHook({
            init: (_id, type) => {
              if (type === "SCRYPTREQUEST") {
                jobs += 1;
              }
            },
          });

          hook.enable();
          yield* Effect.addFinalizer(() => disableHook(hook));

          const create = yield* edgeRequest(origin, "/api/v1/coreUser", {
            body: JSON.stringify({
              active: true,
              login: "edge-password",
              name: "Password policy",
              password: TOO_LONG,
            }),
            headers: { authorization: `Bearer ${token}` },
          });

          assert.strictEqual(create.status, 422, create.text);
          assert.include(create.text, "ValidationFailed");
          assert.include(
            create.text,
            "password_max_length=1024 code points; received 1025"
          );

          for (const login of ["bob", "unknown-password-policy"]) {
            const refused = yield* edgeRequest(origin, SESSION, {
              body: JSON.stringify({ login, password: TOO_LONG }),
            });

            assert.strictEqual(refused.status, 400, refused.text);
            assert.include(
              refused.text,
              "password_max_length=1024 code points; received 1025"
            );
          }

          assert.strictEqual(jobs, 0);

          const largest = JSON.stringify({
            login: "🔑".repeat(4000),
            password: MAX_PASSWORD,
            tokenDelivery: "cookie",
          });

          const escaped = largest.replaceAll("🔑", "\\ud83d\\udd11");
          assert.strictEqual(Buffer.byteLength(largest), 20_147);
          assert.strictEqual(Buffer.byteLength(escaped), 60_339);

          for (const body of [largest, escaped]) {
            const permitted = yield* edgeRequest(origin, SESSION, {
              body,
              headers: { "std-client": "web" },
            });

            assert.strictEqual(permitted.status, 401, permitted.text);
          }

          const accepted = yield* edgeRequest(origin, "/api/v1/coreUser", {
            body: JSON.stringify({
              active: true,
              login: "edge-password",
              name: "Password policy",
              password: MAX_PASSWORD,
            }),
            headers: { authorization: `Bearer ${token}` },
          });

          assert.strictEqual(accepted.status, 201, accepted.text);

          const location = yield* Schema.decodeUnknownEffect(Schema.String)(
            accepted.headers.location
          );

          const userPath = new URL(location).pathname;

          const change = yield* edgeRequest(origin, userPath, {
            body: JSON.stringify({ password: TOO_LONG }),
            headers: { authorization: `Bearer ${token}`, "if-match": '"1"' },
            method: "PATCH",
          });

          assert.strictEqual(change.status, 422, change.text);
          assert.include(
            change.text,
            "password_max_length=1024 code points; received 1025"
          );

          const signedIn = yield* edgeRequest(origin, SESSION, {
            body: JSON.stringify({
              login: "edge-password",
              password: MAX_PASSWORD,
            }),
          });

          assert.strictEqual(signedIn.status, 201, signedIn.text);
          assert.isAtLeast(jobs, 2);
        }).pipe(Effect.scoped)
    );
  });
});
