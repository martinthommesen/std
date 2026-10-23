/**
 * Development and test tool: set a user's password directly, as table
 * owner, without the record service (no access check, no version bump, no
 * change entry). Used by the acme fixture and the demo. Production code
 * sets passwords through the save pipeline.
 */
import { sql, textParameter } from "@std/conditions/sql-fragment";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { Plaintext } from "@std/values/write-only";
import { Effect } from "effect";

import { writeRows } from "../records/sql-run.ts";
import { hashPassword } from "./password.ts";
import { userTables } from "./user-table.ts";

/**
 * Stores the hash of a password for a user.
 *
 * @param snapshot - The configuration (where users are stored).
 * @param userId - The user.
 * @param password - The new password.
 * @returns Nothing.
 */
export const setPasswordForDevelopment = Effect.fn("DevPassword.set")(
  function* setPasswordForDevelopment(
    snapshot: ConfigSnapshot,
    userId: DefinitionId,
    password: string
  ) {
    const tables = userTables(snapshot);
    const hash = yield* hashPassword(new Plaintext(password));

    yield* writeRows(
      sql`UPDATE ${tables.user} SET ${tables.password} = ${textParameter(hash, "text")}
WHERE "id" = ${textParameter(userId, "uuid")}`
    );
  }
);
