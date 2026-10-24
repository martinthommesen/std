/**
 * `pnpm ctk:ci`: the TMF621 Conformance Test Kit against a real `std serve`
 * (Contracts 11.1; CI job "ctk-tmf621").
 *
 * On a disposable empty database from `@std/testing`'s harness it runs
 * `std upgrade --set examples/helpdesk/v4`, creates the administrator
 * `tmf_ctk` (random password), starts `std serve` on a port the system
 * picks, signs in for a bearer session token and writes the kit's payloads
 * (`ctk-payloads.ts`) to a fresh temporary directory, removed at the end.
 *
 * Then, always: a self-check of those payloads through TMF621 with plain
 * `fetch` (create, read, list with `fields`, patch, delete), which proves
 * the server answers what the kit will ask, without the kit.
 *
 * Only under GitHub Actions (`GITHUB_ACTIONS` set) it runs the pinned kit
 * with `pnpm ctk tmf621`, in its own process group, and writes its reports
 * to `ctk-reports/tmf621` under the repository root (the CI artifact). The
 * kit never runs on a developer machine. The token is a disposable CI
 * session on a disposable database. The server's log is printed only when
 * a step fails.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NodeRuntime } from "@effect/platform-node";
import { makeStdClient } from "@std/api/client";
import { testDatabaseService } from "@std/testing/test-database";
import { Console, Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import {
  CTK_PAYLOADS,
  TROUBLE_TICKET,
  TROUBLE_TICKET_SPECIFICATION,
  ctkArguments,
} from "./ctk-payloads.ts";
import type { CtkPayload } from "./ctk-payloads.ts";
import { REPOSITORY_ROOT, startHelpdeskServer } from "./helpdesk-server.ts";
import { run } from "./steps.ts";

/** Random bytes in the disposable password. */
const SECRET_BYTES = 8;

const ADMIN = {
  login: "tmf_ctk",
  password: `tmf-ctk-ci-${randomBytes(SECRET_BYTES).toString("hex")}`,
};

const API_PATH = "/tmf-api/troubleTicket/v5";

/** Where the kit's reports go, relative to the repository root. */
const REPORTS = path.join(REPOSITORY_ROOT, "ctk-reports", "tmf621");

/** Fetch without keep-alive, so nothing holds the server open. */
const Fetch = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false })
  )
);

/** The server answered the payload self-check differently than expected. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class PayloadCheckFailed extends Schema.TaggedError<
  PayloadCheckFailed,
  { readonly brand: unique symbol }
>()("PayloadCheckFailed", {
  detail: Schema.String,
  request: Schema.String,
}) {
  /**
   * Names the request and what differed.
   * @returns The message.
   */
  override get message(): string {
    return `${this.request}: ${this.detail}`;
  }
}

/** Only the owner may read the token file (`pnpm ctk --token-file`). */
const OWNER_ONLY = 0o600;

/**
 * The kit's inputs in a fresh temporary directory, removed when the scope
 * closes: the payloads, and the bearer token in a file only its owner may
 * read, so the token never appears in a command line or its echo.
 * @param token - The bearer token.
 * @returns The two files' paths.
 */
const kitFiles = (token: Redacted.Redacted) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const directory = mkdtempSync(path.join(tmpdir(), "std-ctk-"));
      const payloads = path.join(directory, "payloads.json");
      const tokenFile = path.join(directory, "token");

      writeFileSync(payloads, JSON.stringify(CTK_PAYLOADS));
      writeFileSync(tokenFile, Redacted.value(token), { mode: OWNER_ONLY });

      return { directory, payloads, tokenFile };
    }),
    ({ directory }) =>
      Effect.sync(() => {
        rmSync(directory, { force: true, recursive: true });
      })
  );

/**
 * Signs in as the administrator and returns the session token.
 * @param baseUrl - The server's origin.
 * @returns The bearer token.
 */
const signIn = Effect.fn("CtkCi.signIn")(function* signIn(baseUrl: string) {
  const anonymous = yield* makeStdClient({ baseUrl });

  const session = yield* anonymous.session.create({
    payload: {
      login: ADMIN.login,
      password: ADMIN.password,
      tokenDelivery: "body",
    },
  });

  return Redacted.make(session.token ?? "");
}, Effect.provide(Fetch));

/** An answer from the TMF621 API. */
interface Answer {
  readonly body: string;
  readonly status: number;
}

/**
 * Sends one request to the TMF621 API.
 * @param base - The API's base URL.
 * @param token - The bearer token.
 * @param method - The HTTP method.
 * @param resource - The path after the base, with its query.
 * @param payload - A JSON body, if any.
 * @param expected - The expected HTTP status.
 * @returns The status and the body text (empty when there is none).
 */
const call = Effect.fn("CtkCi.call")(function* call(
  base: string,
  token: Redacted.Redacted,
  method: string,
  resource: string,
  payload: CtkPayload | null,
  expected: number
) {
  const label = `${method} ${resource}`;

  const answer = yield* Effect.tryPromise({
    catch: (cause) =>
      new PayloadCheckFailed({
        detail: `the request failed: ${String(cause)}`,
        request: label,
      }),
    try: async (): Promise<Answer> => {
      const headers = new Headers({
        authorization: `Bearer ${Redacted.value(token)}`,
      });

      if (payload !== null) {
        headers.set(
          "content-type",
          method === "PATCH"
            ? "application/merge-patch+json"
            : "application/json"
        );
      }

      const response = await fetch(`${base}${resource}`, {
        body: payload === null ? null : JSON.stringify(payload),
        headers,
        method,
      });

      return { body: await response.text(), status: response.status };
    },
  });

  if (answer.status !== expected) {
    return yield* new PayloadCheckFailed({
      detail: `expected ${expected}, got ${answer.status}: ${answer.body}`,
      request: label,
    });
  }

  return answer;
});

/** What a created resource must answer. */
const Created = Schema.fromJsonString(
  Schema.Struct({ "@type": Schema.String, id: Schema.String })
);

/** What a list must answer. */
const Listed = Schema.fromJsonString(Schema.Array(Schema.Struct({})));

/** What a resource's self-check lists with `fields`. */
interface Resource {
  readonly fields: readonly string[];
  readonly name: string;
  readonly patch: CtkPayload | null;
  readonly payload: CtkPayload;
  /** The TMF type the server must answer a create with. */
  readonly type: string;
}

const RESOURCES: readonly Resource[] = [
  {
    fields: ["description", "severity", "ticketType"],
    name: "troubleTicket",
    patch: null,
    payload: TROUBLE_TICKET,
    type: "TroubleTicket",
  },
  {
    fields: ["name"],
    name: "troubleTicketSpecification",
    patch: TROUBLE_TICKET_SPECIFICATION,
    payload: TROUBLE_TICKET_SPECIFICATION,
    type: "TroubleTicketSpecification",
  },
];

/**
 * Creates, reads, lists, patches (when the resource has a patch payload)
 * and deletes one resource with its payload, as the kit will.
 * @param base - The API's base URL.
 * @param token - The bearer token.
 * @param resource - The resource and its payloads.
 * @returns Fails with `PayloadCheckFailed` on the first unexpected answer.
 */
const selfCheck = Effect.fn("CtkCi.selfCheck")(function* selfCheck(
  base: string,
  token: Redacted.Redacted,
  resource: Resource
) {
  const collection = `/${resource.name}`;

  const created = yield* call(
    base,
    token,
    "POST",
    collection,
    resource.payload,
    201
  );

  const { "@type": type, id } = yield* Schema.decodeEffect(Created)(
    created.body
  ).pipe(
    Effect.mapError(
      (error) =>
        new PayloadCheckFailed({
          detail: `${error.message}: ${created.body}`,
          request: `POST ${collection}`,
        })
    )
  );

  if (type !== resource.type) {
    return yield* new PayloadCheckFailed({
      detail: `expected @type ${resource.type}, got ${type}`,
      request: `POST ${collection}`,
    });
  }

  const item = `${collection}/${id}`;

  yield* call(base, token, "GET", item, null, 200);

  for (const field of resource.fields) {
    const listPath = `${collection}?fields=${field}`;

    const listed = yield* call(base, token, "GET", listPath, null, 200);

    yield* Schema.decodeEffect(Listed)(listed.body).pipe(
      Effect.mapError(
        (error) =>
          new PayloadCheckFailed({
            detail: `${error.message}: ${listed.body}`,
            request: `GET ${listPath}`,
          })
      )
    );
  }

  if (resource.patch !== null) {
    yield* call(base, token, "PATCH", item, resource.patch, 200);
  }

  yield* call(base, token, "DELETE", item, null, 204);

  return yield* Console.log(
    `payload self-check: ${resource.name} ${id} created, read, listed, ${resource.patch === null ? "" : "patched, "}deleted`
  );
});

const ctk = Effect.gen(function* runCtk() {
  const server = yield* startHelpdeskServer(ADMIN);

  yield* Effect.gen(function* runWithServer() {
    const token = yield* signIn(server.url);
    const base = `${server.url}${API_PATH}`;

    for (const resource of RESOURCES) {
      yield* selfCheck(base, token, resource);
    }

    if (process.env.GITHUB_ACTIONS === undefined) {
      return yield* Console.log(
        "ctk:ci: the kit runs only in GitHub Actions; payload self-check passed"
      );
    }

    const { payloads, tokenFile } = yield* kitFiles(token);

    mkdirSync(REPORTS, { recursive: true });

    return yield* run(
      "pnpm ctk tmf621",
      "pnpm",
      ctkArguments({ base, payloads, reports: REPORTS, tokenFile }),
      process.env,
      REPOSITORY_ROOT
    );
  }).pipe(
    Effect.tapError(() => Console.error(`\n### std serve log\n${server.log()}`))
  );

  return yield* Console.log("\nctk:ci: done");
});

NodeRuntime.runMain(
  ctk.pipe(Effect.scoped, Effect.provide(testDatabaseService({ empty: true }))),
  { disableErrorReporting: false }
);
