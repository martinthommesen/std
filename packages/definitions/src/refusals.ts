/**
 * Refusals of lifecycle operations and protected definitions (Contracts
 * 1.4, 1.6, 1.7, 1.8, 3.1): typed errors a change set fails with before any
 * lock or SQL, each naming definitions by ID, kind and name only.
 *
 * | Error | HTTP | When |
 * | --- | --- | --- |
 * | `DependencyConflict` | 409 | the 1.7 table refuses the operation; lists each blocking dependent |
 * | `UseRetireOrPurge` | 409 | `DELETE` of a field, table or namespace definition |
 * | `DefinitionProtected` | 403 | a protected, reserved, foreign-owned, non-extensible or platform definition (1.8) |
 * | `PermissionRequired` | 403 | the requester lacks a permission (`schema.purge`) |
 * | `PurgeRefused` | 409 | the target is not retired in an earlier committed revision, the confirmation does not name it, or its records also live in tables that stay |
 */
import type { DefinitionProtected } from "./definition-protected.ts";
import type { DependencyConflict } from "./dependency-conflict.ts";
import type { PermissionRequired } from "./permission-required.ts";
import type { PurgeRefused } from "./purge-refused.ts";
import type { UseRetireOrPurge } from "./use-retire-or-purge.ts";

/** Every refusal of a lifecycle or protected-definition check. */
export type ChangeSetRefusal =
  | DependencyConflict
  | UseRetireOrPurge
  | DefinitionProtected
  | PermissionRequired
  | PurgeRefused;
