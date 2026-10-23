import {
  Array as SchemaArray,
  NullOr,
  optionalKey,
  String as SchemaString,
  Struct,
} from "effect/Schema";

import { ConditionSchema } from "./condition.ts";

/** The durable callback configuration of an outbox subscription. */
export const HubConfigurationSchema = Struct({
  api: SchemaString,
  attributeCondition: optionalKey(NullOr(ConditionSchema)),
  callback: SchemaString,
  eventTypes: SchemaArray(SchemaString),
  origin: SchemaString,
  query: NullOr(SchemaString),
  queryFieldIds: SchemaArray(SchemaString),
  resource: SchemaString,
  standardCondition: optionalKey(NullOr(ConditionSchema)),
  topicId: NullOr(SchemaString),
});

/** A hub is owned by its subscription's identity. */
export type HubConfiguration = typeof HubConfigurationSchema.Type;
