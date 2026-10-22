/**
 * Child process for probe 2: plays the schema-change coordinator. It opens
 * a dedicated connection as `application_name = 'std-probe-index-build'`,
 * takes `SCHEMA_KEY` with `pg_try_advisory_lock` (a session lock, as the
 * coordinator holds it), then runs one `CREATE INDEX CONCURRENTLY` statement
 * in autocommit mode. The probe kills this process mid-build.
 *
 * Usage: `node index-build-child.ts '<CREATE INDEX CONCURRENTLY ...>'`, with
 * `STD_DATABASE_URL` naming the database.
 */
import { NodeRuntime } from "@effect/platform-node";
import { makeDedicatedConnection } from "@std/server/sql/dedicated";
import { SqlLayer } from "@std/server/sql/layer";
import { SCHEMA_KEY } from "@std/server/sql/locks";
import { Effect, Layer } from "effect";

import { childDatabaseConfig } from "./index-build-config.ts";
import { INDEX_BUILD_APPLICATION_NAME } from "./index-build-names.ts";

const [statement] = process.argv.slice(2);

const services = SqlLayer.pipe(Layer.provideMerge(childDatabaseConfig));

const build = Effect.scoped(
  Effect.gen(function* buildAsCoordinator() {
    if (statement === undefined) {
      return yield* Effect.die(new Error("usage: index-build-child.ts <sql>"));
    }

    const connection = yield* makeDedicatedConnection({
      applicationName: INDEX_BUILD_APPLICATION_NAME,
    });

    if (!(yield* connection.tryAdvisoryLock(SCHEMA_KEY))) {
      return yield* Effect.die(new Error("SCHEMA_KEY is held elsewhere"));
    }

    yield* connection.execute(statement);

    return yield* Effect.void;
  })
);

NodeRuntime.runMain(build.pipe(Effect.provide(services)));
