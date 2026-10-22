/**
 * The shape of follow-up steps (Contracts 1.5): a step as stored, and what
 * each step kind defines (probe, action, abandon action). The kinds
 * themselves are in `steps.ts` and `backfill.ts`.
 */
import { isJsonString } from "@std/values/json-value";
import type { JsonObject } from "@std/values/json-value";
import type { Effect } from "effect";

import type { DedicatedConnection } from "../sql/dedicated.ts";
import type { DatabaseError } from "../sql/errors.ts";
import type { StepKind } from "./plan.ts";

/** The state of a step (Contracts 1.5). */
export type StepState = "pending" | "running" | "done" | "failed";

/** A step as stored in `core.schema_change_step`. */
export interface StepRow {
  readonly id: string;
  readonly ordinal: number;
  readonly kind: StepKind;
  readonly targetId: string | null;
  readonly sql: string | null;
  readonly details: JsonObject;
  readonly state: StepState;
  readonly attempts: number;
}

/** What a probe finds. */
export type ProbeResult = "done" | "not_started" | "partial";

/** The behaviour of one step kind. */
export interface StepSpec {
  /** Reads the catalog to find out how far the step got. */
  readonly probe: (
    connection: DedicatedConnection,
    step: StepRow
  ) => Effect.Effect<ProbeResult, DatabaseError>;
  /** Runs the step; returns details to merge into the step's row. */
  readonly action: (
    connection: DedicatedConnection,
    step: StepRow
  ) => Effect.Effect<JsonObject, DatabaseError>;
  /** Undoes a step that will not finish (workstream 1A runs it). */
  readonly abandon: (
    connection: DedicatedConnection,
    step: StepRow
  ) => Effect.Effect<void, DatabaseError>;
}

/**
 * A text detail of a step.
 *
 * @param step - The step.
 * @param key - The detail's key.
 * @returns The text, or an empty string.
 */
export const detailText = (step: StepRow, key: string): string => {
  const value = step.details[key];

  return value !== undefined && isJsonString(value) ? value : "";
};
