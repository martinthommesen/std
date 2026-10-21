/**
 * The platform migration list, in order. Append only: a new migration gets
 * the next id and its own file in `migrations/` (`0002-<name>.ts`); applied
 * migrations are never edited, reordered or removed.
 */
import { validateMigrations } from "./migration.ts";
import type { PlatformMigration } from "./migration.ts";
import { migration0001 } from "./migrations/0001-core.ts";
import { migration0002 } from "./migrations/0002-definitions.ts";
import { migration0005 } from "./migrations/0005-config-layers.ts";

/**
 * Ids taken by branches merged later: 0003 (sessions, ws/0c-reads) and
 * 0004 (history, ws/0c-writes). Remove each when its migration joins the
 * list below.
 */
const RESERVED_IDS: readonly number[] = [3, 4];

/** Every platform migration this version of STD knows. */
export const PLATFORM_MIGRATIONS: readonly PlatformMigration[] =
  validateMigrations(
    [migration0001, migration0002, migration0005],
    RESERVED_IDS
  );
