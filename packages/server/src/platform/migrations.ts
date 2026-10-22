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
import { migration0006 } from "./migrations/0006-definition-names.ts";
import { migration0007 } from "./migrations/0007-outbox.ts";
import { migration0008 } from "./migrations/0008-ui-config.ts";
import { migration0009 } from "./migrations/0009-saved-filters.ts";
import { migration0010 } from "./migrations/0010-definition-revision-field.ts";
import { migration0011 } from "./migrations/0011-record-rules.ts";

/** Every platform migration this version of STD knows. */
export const PLATFORM_MIGRATIONS: readonly PlatformMigration[] =
  validateMigrations([
    migration0001,
    migration0002,
    migration0003,
    migration0004,
    migration0005,
    migration0006,
    migration0007,
    migration0008,
    migration0009,
    migration0010,
    migration0011,
  ]);
