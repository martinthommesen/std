/**
 * Migration 0010: the index behind history definitions (Contracts 4.4,
 * decision 0020).
 *
 * - `core.definition_revision_field`: a partial expression index on the
 *   `fieldId` of override and choice revisions, then the revision. A
 *   history read looks up the overrides and choices of the fields an entry
 *   changed, up to the entry's revision, by `effective ->> 'fieldId'`;
 *   without the index that lookup scans every revision row.
 *
 * A `concurrent_index` migration, so `std upgrade` builds it without
 * blocking config changes on a large table.
 *
 * This file is frozen once applied: the ledger records its checksum.
 */
import type { ConcurrentIndexMigration } from "../migration.ts";

/** Migration 0010. Never edit it: the ledger records its checksum. */
export const migration0010: ConcurrentIndexMigration = {
  id: 10,
  index: "definition_revision_field",
  kind: "concurrent_index",
  name: "definition-revision-field",
  phase: "expand",
  schema: "core",
  statement:
    "CREATE INDEX CONCURRENTLY definition_revision_field ON core.definition_revision ((effective ->> 'fieldId'), revision) WHERE kind IN ('override', 'choice')",
};
