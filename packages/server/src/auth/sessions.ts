/**
 * Password sign-in and sessions (Contracts 3.1, 3.10).
 *
 * - Sign-in finds the user by login, compared without regard to case (the
 *   same `casefold(... COLLATE pg_unicode_fast)` key as the login's unique
 *   index), and checks the password. An unknown login, a wrong password and
 *   a deactivated user give the same `InvalidCredentials`, after the same
 *   amount of hashing work.
 * - A session is 32 random bytes, sent to the client once as unpadded
 *   base64url. Only its SHA-256 hash is stored, in `core.session`
 *   (migration 0003), with an expiry. [judgment: 12 hours]
 * - Every request presents the token as `Authorization: Bearer <token>`;
 *   `authenticate` turns it into the actor inside the request's own
 *   transaction. Deactivating a user deletes their sessions in the same
 *   transaction (a trigger, `session-revocation.ts`), and a session whose
 *   user is inactive never authenticates.
 */
import { createHash, randomBytes } from "node:crypto";

import { InvalidCredentials } from "@std/api/errors/invalid-credentials";
import { Unauthenticated } from "@std/api/errors/unauthenticated";
import { rawSql, sql, textParameter } from "@std/conditions/sql-fragment";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { formatDateTime } from "@std/values/date-time";
import { textKey } from "@std/values/fold";
import type { Plaintext } from "@std/values/write-only";
import { Clock, Duration, Effect, Redacted } from "effect";

import { readRows, writeRows } from "../records/sql-run.ts";
import { quoteIdent } from "../schema/sql-text.ts";
import { effectiveRoles } from "./actor.ts";
import type { ActingUser } from "./actor.ts";
import { verifyPassword } from "./password.ts";
import { userTables } from "./user-table.ts";

/** How long a session lasts. [judgment] */
export const SESSION_LIFETIME = Duration.hours(12);

const TOKEN_BYTES = 32;

/** A token as issued: 43 characters of unpadded base64url. */
const TOKEN_FORMAT = /^[\w-]{43}$/u;

/** A new session. */
export interface Session {
  /** The bearer token; shown once, never stored. */
  readonly token: Redacted.Redacted;
  readonly userId: DefinitionId;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

/**
 * The stored form of a token: its SHA-256, as a `bytea` parameter.
 *
 * @param token - The token text.
 * @returns The `\x...` hex text, cast to `bytea`.
 */
const tokenHashParameter = (token: string) =>
  textParameter(
    `\\x${createHash("sha256").update(token, "utf-8").digest("hex")}`,
    "bytea"
  );

/**
 * Signs a user in.
 *
 * @param snapshot - The configuration (where users are stored).
 * @param login - The login as typed.
 * @param password - The password.
 * @returns The new session, or `InvalidCredentials`.
 */
export const signIn = Effect.fn("Sessions.signIn")(function* signIn(
  snapshot: ConfigSnapshot,
  login: string,
  password: Plaintext
) {
  const tables = userTables(snapshot);
  const key = textKey(login.normalize("NFC").trim(), false);

  // FOR SHARE conflicts with the UPDATE that deactivates the user: a
  // concurrent deactivation either commits first (the row is re-read and
  // `active` is false) or waits for this sign-in to commit (its trigger then
  // deletes the new session). No session survives a deactivation.
  const [user] = yield* readRows(
    sql`SELECT "u"."id"::text AS "id", "u".${rawSql(quoteIdent(tables.password))} AS "password",
  "u".${rawSql(quoteIdent(tables.active))}::text AS "active"
FROM ${tables.user} AS "u"
WHERE casefold(("u".${rawSql(quoteIdent(tables.login))}) COLLATE pg_unicode_fast) = ${textParameter(key, "text")}
FOR SHARE OF "u"`
  );

  const verified = yield* verifyPassword(password, user?.password ?? null);

  if (
    user?.id === undefined ||
    user.id === null ||
    user.active !== "true" ||
    !verified
  ) {
    return yield* new InvalidCredentials();
  }

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const now = yield* Clock.currentTimeMillis;
  const expiresAt = now + Duration.toMillis(SESSION_LIFETIME);

  yield* writeRows(
    sql`INSERT INTO "core"."session" ("token_hash", "user_id", "created_at", "expires_at")
VALUES (${tokenHashParameter(token)}, ${textParameter(user.id, "uuid")},
  ${textParameter(formatDateTime(now), "timestamptz")}, ${textParameter(formatDateTime(expiresAt), "timestamptz")})`
  );

  return {
    expiresAt,
    token: Redacted.make(token),
    userId: user.id,
  } satisfies Session;
});

/**
 * Checks a bearer token and returns the actor (Contracts 3.1). Runs inside
 * the request transaction, so the session and the roles are read at the
 * request's revision.
 *
 * @param snapshot - The configuration.
 * @param token - The presented token.
 * @returns The actor, or `Unauthenticated` for a missing, unknown or
 *   expired token, or an inactive user.
 */
export const authenticate = Effect.fn("Sessions.authenticate")(
  function* authenticate(snapshot: ConfigSnapshot, token: Redacted.Redacted) {
    const text = Redacted.value(token);

    if (!TOKEN_FORMAT.test(text)) {
      return yield* new Unauthenticated();
    }

    const tables = userTables(snapshot);

    const rows = yield* readRows(
      sql`SELECT "s"."user_id"::text AS "user_id", "ur".${rawSql(quoteIdent(tables.userRoleRole))}::text AS "role_id"
FROM "core"."session" AS "s"
JOIN ${tables.user} AS "u" ON "u"."id" = "s"."user_id" AND "u".${rawSql(quoteIdent(tables.active))}
LEFT JOIN ${tables.userRole} AS "ur" ON "ur".${rawSql(quoteIdent(tables.userRoleUser))} = "u"."id"
WHERE "s"."token_hash" = ${tokenHashParameter(text)} AND "s"."expires_at" > now()`
    );

    const userId = rows[0]?.user_id;

    if (userId === undefined || userId === null) {
      return yield* new Unauthenticated();
    }

    const assigned = rows.flatMap((row) =>
      row.role_id === null || row.role_id === undefined ? [] : [row.role_id]
    );

    return {
      roleIds: effectiveRoles(snapshot, true, assigned),
      userId,
    } satisfies ActingUser;
  }
);

/**
 * Ends the presented session. An unknown token ends nothing.
 *
 * @param token - The presented token.
 * @returns Nothing.
 */
export const signOut = Effect.fn("Sessions.signOut")(function* signOut(
  token: Redacted.Redacted
) {
  yield* writeRows(
    sql`DELETE FROM "core"."session" WHERE "token_hash" = ${tokenHashParameter(Redacted.value(token))}`
  );
});
