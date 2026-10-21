/**
 * `pnpm spike:demo`: the Stage 0 runnable result. Needs the development
 * Postgres (`pnpm db:up`, or `docker compose up`); it creates a fresh
 * database from the migrated template, loads the core and acme sets and the
 * two-user fixture, runs the demo through the HTTP API in process, and
 * drops the database at the end.
 */
import { NodeRuntime } from "@effect/platform-node";
import { acmeTestLayer } from "@std/testing/acme-fixture";
import { TestHttpClient } from "@std/testing/http-client";
import { Console, Effect, Layer } from "effect";

import { runDemo } from "./demo.ts";

const DemoLayer = TestHttpClient.layer.pipe(
  Layer.provideMerge(acmeTestLayer())
);

NodeRuntime.runMain(
  runDemo((line) => Console.log(line)).pipe(Effect.provide(DemoLayer))
);
