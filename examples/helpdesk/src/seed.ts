/**
 * `pnpm helpdesk:seed`: the helpdesk's demo users and records, for
 * `docker compose up` (plan Step 2, "Runnable result"). Run it after
 * `std upgrade --set examples/helpdesk/v3`, against `STD_DATABASE_URL`.
 *
 * It creates the users `admin` (built-in `admin` role), `agent` and
 * `agent2` (helpdesk `agent` role) unless their logins exist, and, when the
 * helpdesk has no records yet, five incidents and a ticket. Rerunning it
 * changes nothing; an existing user's password is never changed.
 *
 * Passwords come from `HELPDESK_ADMIN_PASSWORD`, `HELPDESK_AGENT_PASSWORD`
 * and `HELPDESK_AGENT2_PASSWORD`. Unset, they are the DISPOSABLE DEMO
 * CREDENTIALS in `@std/testing/helpdesk-fixture` (public in this
 * repository): set your own for anything but a local demo.
 */
import { NodeRuntime } from "@effect/platform-node";
import { Catalog } from "@std/server/catalog/catalog";
import { InstanceSettings } from "@std/server/config/instance-settings";
import { recoverySettingsFromEnv } from "@std/server/schema/recovery-settings";
import {
  CLI_APPLICATION_NAME,
  DatabaseConfig,
} from "@std/server/sql/database-config";
import { SqlLayer } from "@std/server/sql/layer";
import {
  HELPDESK_DEMO_ACCOUNTS,
  seedHelpdeskDemo,
} from "@std/testing/helpdesk-fixture";
import { Config, Console, Effect, Layer, Redacted } from "effect";

/**
 * A demo account, its password from the environment or the demo default.
 *
 * @param account - The demo account.
 * @param variable - The environment variable with its password.
 * @returns The account's config.
 */
const accountConfig = (
  account: (typeof HELPDESK_DEMO_ACCOUNTS)[keyof typeof HELPDESK_DEMO_ACCOUNTS],
  variable: string
) =>
  Config.Redacted(variable).pipe(
    Config.withDefault(Redacted.make(account.password)),
    Config.map((password) => ({
      login: account.login,
      name: account.name,
      password,
    }))
  );

const accountsConfig = Config.all({
  admin: accountConfig(HELPDESK_DEMO_ACCOUNTS.admin, "HELPDESK_ADMIN_PASSWORD"),
  agent: accountConfig(HELPDESK_DEMO_ACCOUNTS.agent, "HELPDESK_AGENT_PASSWORD"),
  agent2: accountConfig(
    HELPDESK_DEMO_ACCOUNTS.agent2,
    "HELPDESK_AGENT2_PASSWORD"
  ),
});

const services = Layer.merge(Catalog.layer, InstanceSettings.layer).pipe(
  Layer.provideMerge(SqlLayer),
  Layer.provideMerge(DatabaseConfig.fromEnv(CLI_APPLICATION_NAME)),
  Layer.provideMerge(recoverySettingsFromEnv)
);

const seed = accountsConfig.pipe(
  Effect.flatMap(seedHelpdeskDemo),
  Effect.flatMap((demo) =>
    Console.log(
      [
        `Helpdesk users: admin ${demo.users.admin}, agent ${demo.users.agent}, agent2 ${demo.users.agent2}.`,
        demo.records === null
          ? "The helpdesk already has records; none added."
          : `Added ${Object.keys(demo.records).length} demo tickets and incidents.`,
      ].join("\n")
    )
  ),
  Effect.provide(services),
  Effect.tapError((failure) =>
    Console.error(`helpdesk seed: ${String(failure)}`)
  )
);

NodeRuntime.runMain(seed);
