/**
 * The platform migration list, in order. Append only: a new migration gets
 * the next id and its own file in `migrations/` (`0002-<name>.ts`); applied
 * migrations are never edited, reordered or removed.
 */
import { validateMigrations } from "./migration.ts";
import type { PlatformMigration } from "./migration.ts";
import { migration0001 } from "./migrations/0001-core.ts";
import { migration0002 } from "./migrations/0002-definitions.ts";
import { migration0003 } from "./migrations/0003-sessions.ts";
import { migration0004 } from "./migrations/0004-history.ts";
import { migration0005 } from "./migrations/0005-config-layers.ts";
import { migration0007 } from "./migrations/0007-outbox.ts";

/**
 * Ids taken by branches merged later: 0006 (schema lifecycle,
 * ws/1a-schema-lifecycle). Remove it when its migration joins the list
 * below.
 */
const RESERVED_IDS: readonly number[] = [6];

/** Every platform migration this version of STD knows. */
export const PLATFORM_MIGRATIONS: readonly PlatformMigration[] =
  validateMigrations(
    [
      migration0001,
      migration0002,
      migration0003,
      migration0004,
      migration0005,
      migration0007,
    ],
    RESERVED_IDS
  );
