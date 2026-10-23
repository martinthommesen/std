import { reduce } from "effect/Array";

import type { Message } from "./message.ts";
import type { Model } from "./model.ts";
import { update } from "./update.ts";

/**
 * Applies form Messages in order, retaining the final Model.
 * @param start - The starting Model.
 * @param messages - The protocol to replay.
 * @returns The resulting Model.
 */
export const formAfter = (
  start: Model,
  ...messages: readonly Message[]
): Model =>
  reduce(messages, start, (current, next) => update(current, next).model);
