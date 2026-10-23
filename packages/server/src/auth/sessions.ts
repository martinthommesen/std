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
 * - Reserved service identities never authenticate. The system user acts
 *   only for bootstrap and definition loading
 *   (Contracts 3.1): it never signs in and no session authenticates as it,
 *   even if someone activates it and gives it a password. Its refusals are
 *   the same `InvalidCredentials` and `Unauthenticated` as anyone's.
 */
import { createHash, randomBytes } from "node:crypto";

import { InvalidCredentials } from "@std/api/errors/invalid-credentials";
import { Unauthenticated } from "@std/api/errors/unauthenticated";
import { rawSql, sql, textParameter } from "@std/conditions/sql-fragment";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { SERVICE_USER_IDS } from "@std/definitions/well-known";
import { formatDateTime } from "@std/values/date-time";
import { textKey } from "@std/values/fold";
import type { Plaintext } from "@std/values/write-only";
import { Clock, Duration, Effect, Redacted } from "effect";

import { readRows, writeRows } from "../records/sql-run.ts";
import { quoteIdent } from "../schema/sql-text.ts";
import { effectiveRoles } from "./actor.ts";
import type { ActingUser } from "./actor.ts";
import { verifyPassword } from "./password.ts";
import {
  ACTIVE_SESSION_LIMIT,
  deleteExpiredSessions,
} from "./session-retention.ts";
import { admitSignIn, failSignIn, resetSignIn } from "./sign-in-limits.ts";
import { userTables } from "./user-table.ts";

/** How long a session lasts. [judgment] */
export const SESSION_LIFETIME = Duration.hours(12);

/** Random bytes in a session token. */
export const SESSION_TOKEN_BYTES = 32;

/**
 * The length of a token as issued: unpadded base64url of
 * `SESSION_TOKEN_BYTES` bytes, 6 bits per character (43).
 */
export const SESSION_TOKEN_LENGTH = Math.ceil((SESSION_TOKEN_BYTES * 8) / 6);

/** A token as issued: `SESSION_TOKEN_LENGTH` characters of base64url. */
const TOKEN_FORMAT = new RegExp(`^[\\w-]{${SESSION_TOKEN_LENGTH}}$`, "u");

/**
 * A token-shaped run inside a longer text: exactly `SESSION_TOKEN_LENGTH`
 * base64url characters, with none right before or after.
 */
const TOKEN_IN_TEXT = new RegExp(
  `(?<![\\w-])[\\w-]{${SESSION_TOKEN_LENGTH}}(?![\\w-])`,
  "gu"
);

/**
 * A new session token: `SESSION_TOKEN_BYTES` random bytes as unpadded
 * base64url. Sign-in issues these; tests and tools that look for tokens
 * use `sessionTokensIn`, derived from the same constants.
 * @returns The token text.
 */
export const newSessionToken = (): string =>
  randomBytes(SESSION_TOKEN_BYTES).toString("base64url");

/**
 * The token-shaped runs in a text, for tools that must not leak tokens
 * (the quickstart's execve trace).
 * @param text - Any text.
 * @returns Each run of exactly `SESSION_TOKEN_LENGTH` base64url characters.
 */
export const sessionTokensIn = (text: string): readonly string[] =>
  text.match(TOKEN_IN_TEXT) ?? [];

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
 * Signs a user in, inside a request transaction. Commit credential/throttle
 * refusals as results so their counters persist; other failures must roll back.
 * HTTP admission owns native-work completion across caller interruption.
 *
 * @param snapshot - The configuration (where users are stored).
 * @param login - The login as typed.
 * @param password - The password.
 * @param source - Socket remote address (or the internal caller identity).
 * @returns The new session, or `InvalidCredentials`.
 */
export const signIn = Effect.fn("Sessions.signIn")(function* signIn(
  snapshot: ConfigSnapshot,
  login: string,
  password: Plaintext,
  source: string
) {
  yield* deleteExpiredSessions();
  const failures = yield* admitSignIn(login, source);
  const tables = userTables(snapshot);
  const key = textKey(login.normalize("NFC").trim(), false);

  // FOR UPDATE serializes issuance and conflicts with the UPDATE that deactivates the user: a
  // concurrent deactivation either commits first (the row is re-read and
  // `active` is false) or waits for this sign-in to commit (its trigger then
  // deletes the new session). No session survives a deactivation.
  const [user] = yield* readRows(
    sql`SELECT "u"."id"::text AS "id", "u".${rawSql(quoteIdent(tables.password))} AS "password",
  "u".${rawSql(quoteIdent(tables.active))}::text AS "active"
FROM ${tables.user} AS "u"
WHERE casefold(("u".${rawSql(quoteIdent(tables.login))}) COLLATE pg_unicode_fast) = ${textParameter(key, "text")}
FOR UPDATE OF "u"`
  );

  const verified = yield* verifyPassword(password, user?.password ?? null);

  const userId = user?.id ?? null;
  const mayActOverHttp = userId !== null && !SERVICE_USER_IDS.has(userId);

  if (!(mayActOverHttp && user?.active === "true" && verified)) {
    yield* failSignIn(login, failures);

    return yield* new InvalidCredentials();
  }

  yield* resetSignIn(login);
  // The user row is locked until insertion commits, so concurrent sign-ins
  // cannot exceed the cap. Equal creation times are ordered by token hash.
  yield* writeRows(sql`DELETE FROM core.session WHERE token_hash IN (
    SELECT token_hash FROM core.session WHERE user_id = ${textParameter(userId, "uuid")} AND expires_at > now()
    ORDER BY created_at DESC, token_hash DESC OFFSET ${textParameter(String(ACTIVE_SESSION_LIMIT - 1), "integer")})`);

  const token = newSessionToken();
  const now = yield* Clock.currentTimeMillis;
  const expiresAt = now + Duration.toMillis(SESSION_LIFETIME);

  yield* writeRows(
    sql`INSERT INTO "core"."session" ("token_hash", "user_id", "created_at", "expires_at")
VALUES (${tokenHashParameter(token)}, ${textParameter(userId, "uuid")},
  ${textParameter(formatDateTime(now), "timestamptz")}, ${textParameter(formatDateTime(expiresAt), "timestamptz")})`
  );

  return {
    expiresAt,
    token: Redacted.make(token),
    userId,
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

    if (
      userId === undefined ||
      userId === null ||
      SERVICE_USER_IDS.has(userId)
    ) {
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
 * The display name of a user (`core.user.name`), for `auth/me`. Every
 * active user may read every user's name (a built-in rule), so this
 * reveals nothing the user could not list.
 *
 * @param snapshot - The configuration.
 * @param userId - The user.
 * @returns The name, or the login when the name is empty.
 */
export const displayName = Effect.fn("Sessions.displayName")(
  function* displayName(snapshot: ConfigSnapshot, userId: DefinitionId) {
    const tables = userTables(snapshot);

    const [user] = yield* readRows(
      sql`SELECT coalesce("u".${rawSql(quoteIdent(tables.name))}, "u".${rawSql(quoteIdent(tables.login))}) AS "name"
FROM ${tables.user} AS "u"
WHERE "u"."id" = ${textParameter(userId, "uuid")}`
    );

    return user?.name ?? "";
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
