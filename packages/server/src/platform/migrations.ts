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
import { migration0011 } from "./migrations/0011-ledger-state.ts";
import { migration0012 } from "./migrations/0012-user-individuals.ts";
import { migration0013 } from "./migrations/0013-record-rules.ts";
import { migration0014 } from "./migrations/0014-outbox-worker.ts";
import { migration0015 } from "./migrations/0015-delivery-done.ts";
import { migration0016 } from "./migrations/0016-system-user-history.ts";
import { migration0017 } from "./migrations/0017-rolling-groundwork.ts";
import { migration0018 } from "./migrations/0018-helpdesk-v3.ts";
import { migration0019 } from "./migrations/0019-hubs.ts";
import { migration0020 } from "./migrations/0020-event-lookups.ts";
import { migration0021 } from "./migrations/0021-change-topic-page.ts";
import { migration0022 } from "./migrations/0022-event-lookup-backfill.ts";
import { migration0023 } from "./migrations/0023-event-images-cursors.ts";
import { migration0024 } from "./migrations/0024-record-event-id.ts";
import { migration0025 } from "./migrations/0025-change-event-key.ts";
import { migration0026 } from "./migrations/0026-client-event-key.ts";
import { migration0027 } from "./migrations/0027-client-event-record.ts";
import { migration0028 } from "./migrations/0028-change-image-backfill.ts";
import { migration0029 } from "./migrations/0029-dead-delivery-actions.ts";
import { migration0030 } from "./migrations/0030-form-rules.ts";

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
    migration0012,
    migration0013,
    migration0014,
    migration0015,
    migration0016,
    migration0017,
    migration0018,
    migration0019,
    migration0020,
    migration0021,
    migration0022,
    migration0023,
    migration0024,
    migration0025,
    migration0026,
    migration0027,
    migration0028,
    migration0029,
    migration0030,
  ]);
