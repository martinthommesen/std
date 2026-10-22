/**
 * `std bootstrap-admin`: the first administrator of a new install
 * (decision 0016).
 *
 * A fresh database has the core set but no user who can sign in: the
 * system user never signs in (Contracts 3.1), and every other user is
 * created through the record service by someone who already can. This
 * creates one active user with a password and the built-in `admin` role,
 * as the system user, through the save pipeline, in one request
 * transaction: the user and the role assignment get their change entries
 * and delivery rows like any other save. It is bootstrap, the one task
 * besides definition loading that the system user acts for.
 *
 * It is idempotent by login: when a user with that login (compared without
 * regard to case, like sign-in) exists, nothing changes, the password and
 * the roles included. So a deployment can run it after every
 * `std upgrade`, and it can never take over or reset an existing account.
 * Like `std upgrade`, it runs with the database owner's credentials,
 * outside the HTTP API: whoever can run it can already change every table.
 */
import { rawSql, sql, textParameter } from "@std/conditions/sql-fragment";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import {
  BUILT_IN_ROLE_IDS,
  SYSTEM_USER_ID,
  USER_CLASS_ID,
  USER_ROLE_CLASS_ID,
} from "@std/definitions/well-known";
import { textKey } from "@std/values/fold";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Layer, Redacted, Schema } from "effect";

import { Catalog } from "../catalog/catalog.ts";
import { OutboxSaveHooks } from "../records/outbox-producer.ts";
import { createRecord } from "../records/save-pipeline.ts";
import { readRows } from "../records/sql-run.ts";
import { WriteAccess } from "../records/write-access.ts";
import { WriteOnlyValues } from "../records/write-only-values.ts";
import { quoteIdent } from "../schema/sql-text.ts";
import { Transactions } from "../sql/transactions.ts";
import { Actor } from "./actor.ts";
import { userTables } from "./user-table.ts";

/** The administrator to create. */
export interface AdminAccount {
  readonly login: string;
  readonly name: string;
  readonly password: Redacted.Redacted;
}

/** What `bootstrapAdmin` did. */
export interface BootstrapOutcome {
  /** `created`, or `exists` when a user with the login was already there. */
  readonly outcome: "created" | "exists";
  readonly userId: DefinitionId;
}

/** The first administrator cannot be created yet. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class AdminBootstrapRefused extends Schema.TaggedError<
  AdminBootstrapRefused,
  { readonly brand: unique symbol }
>()("AdminBootstrapRefused", {
  reason: Schema.Literals(["coreSetNotLoaded"]),
}) {
  /**
   * Says what to do.
   * @returns The message.
   */
  override get message(): string {
    return `cannot create the administrator (${this.reason}): the core definition set is not loaded; run std upgrade first`;
  }
}

/**
 * The saves run as the system user with every record allowed (no access
 * rules apply to bootstrap), the production hook points (delivery rows for
 * matching subscriptions) and scrypt password hashing, as the HTTP write
 * routes use.
 */
const BootstrapSaveServices = Layer.mergeAll(
  WriteAccess.allowAll,
  OutboxSaveHooks,
  WriteOnlyValues.scrypt
).pipe(
  Layer.merge(
    Layer.succeed(Actor, Actor.of({ roleIds: [], userId: SYSTEM_USER_ID }))
  )
);

const userWithLogin = Effect.fn("BootstrapAdmin.userWithLogin")(
  function* userWithLogin(snapshot: ConfigSnapshot, login: string) {
    const tables = userTables(snapshot);
    const key = textKey(login.normalize("NFC").trim(), false);

    const [user] = yield* readRows(
      sql`SELECT "u"."id"::text AS "id"
FROM ${tables.user} AS "u"
WHERE casefold(("u".${rawSql(quoteIdent(tables.login))}) COLLATE pg_unicode_fast) = ${textParameter(key, "text")}`
    );

    return user?.id ?? undefined;
  }
);

const create = (
  classId: DefinitionId,
  body: Readonly<Record<string, JsonValue>>
) =>
  createRecord({ body, endpointClassId: classId }).pipe(
    Effect.map((saved) => saved.id)
  );

/**
 * Creates the administrator unless a user with its login exists.
 *
 * @param account - Login, display name and password.
 * @returns Whether the user was created, and its ID.
 */
export const bootstrapAdmin = Effect.fn("BootstrapAdmin.run")(
  function* bootstrapAdmin(account: AdminAccount) {
    const { request } = yield* Transactions;
    const catalog = yield* Catalog;

    return yield* request(
      Effect.gen(function* createAdmin() {
        const snapshot = yield* catalog.current;

        if (snapshot.class(USER_CLASS_ID) === undefined) {
          return yield* new AdminBootstrapRefused({
            reason: "coreSetNotLoaded",
          });
        }

        const existing = yield* userWithLogin(snapshot, account.login);

        if (existing !== undefined && existing !== null) {
          return {
            outcome: "exists",
            userId: existing,
          } satisfies BootstrapOutcome;
        }

        const userId = yield* create(USER_CLASS_ID, {
          active: true,
          login: account.login,
          name: account.name,
          password: Redacted.value(account.password),
        });

        yield* create(USER_ROLE_CLASS_ID, {
          role: BUILT_IN_ROLE_IDS.admin,
          user: userId,
        });

        return { outcome: "created", userId } satisfies BootstrapOutcome;
      })
    ).pipe(Effect.provide(BootstrapSaveServices));
  }
);
