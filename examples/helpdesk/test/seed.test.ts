/**
 * The helpdesk demo seed (`pnpm helpdesk:seed`, which `docker compose up`
 * runs): a rerun changes nothing. Users are matched by login and never
 * changed, passwords included; records are added only to an empty
 * helpdesk. The demo users sign in with their demo passwords.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import {
  defaultHelpdeskAccounts,
  HELPDESK_DEMO_ACCOUNTS,
  HelpdeskFixture,
  helpdeskTestLayer,
  seedHelpdeskDemo,
} from "@std/testing/helpdesk-fixture";
import { TestHttpClient } from "@std/testing/http-client";
import { Effect, Layer, Redacted } from "effect";

/**
 * An account with the demo login but another name and password.
 *
 * @param login - The login.
 * @param name - The name.
 * @returns The account.
 */
const other = (login: string, name: string) => ({
  login,
  name,
  password: Redacted.make(`${login}-other-password`),
});

const SeedLayer = TestHttpClient.layer.pipe(
  Layer.provideMerge(helpdeskTestLayer())
);

describe("helpdesk-seed", () => {
  it("defaults to the demo logins `admin`, `agent` and `agent2`", () => {
    const accounts = defaultHelpdeskAccounts();

    assert.deepStrictEqual(
      [accounts.admin.login, accounts.agent.login, accounts.agent2.login],
      ["admin", "agent", "agent2"]
    );
    assert.strictEqual(
      Redacted.value(accounts.agent.password),
      HELPDESK_DEMO_ACCOUNTS.agent.password
    );
  });

  layer(SeedLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect("a rerun adds and changes nothing", () =>
      Effect.gen(function* rerun() {
        const fixture = yield* HelpdeskFixture;
        const http = yield* TestHttpClient;

        const again = yield* seedHelpdeskDemo({
          admin: other(fixture.admin.login, "Someone else"),
          agent: other(fixture.agent.login, "Someone else"),
          agent2: other(fixture.agent2.login, "Someone else"),
        });

        assert.isNull(again.records);
        assert.deepStrictEqual(again.users, {
          admin: fixture.admin.id,
          agent: fixture.agent.id,
          agent2: fixture.agent2.id,
        });

        for (const user of [fixture.admin, fixture.agent, fixture.agent2]) {
          const token = yield* http.signIn(user.login, user.password);
          const me = yield* http.get("/api/v1/auth/me", { token });

          assert.strictEqual(me.status, 200, me.text);
          assert.include(me.text, user.name);
        }
      })
    );
  });
});
