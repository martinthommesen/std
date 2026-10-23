import type { DefinitionId } from "@std/definitions/ids";

import type { ChangeCause } from "./change-entry.ts";
import type { SaveMode } from "./save-hooks.ts";

/**
 * What every save names. The acting user is the `Actor` in the
 * environment (Contracts 3.1); the fields a body may name come from
 * `WriteAccess.nameable`.
 */
export interface SaveInput {
  /** The class whose endpoint the request came through. */
  readonly endpointClassId: DefinitionId;
  /** What produced the save; `{ kind: "api" }` by default. */
  readonly cause?: ChangeCause;
  /**
   * Which `before` rules run (4.10): `user` by default; `settled` for the
   * saves that settling persists (4.9), where only invariants run.
   */
  readonly mode?: SaveMode;
  /**
   * `aggregate`: a save finalization makes as the system effect (4.9,
   * 4.10): it needs no write right of the acting user (read-only fields
   * included, owner references excepted), but is validated as usual.
   */
  readonly system?: "aggregate";
}
