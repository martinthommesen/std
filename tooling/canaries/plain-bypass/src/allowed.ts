import { Schema } from "effect";
import { forbiddenEncoding } from "effect/SchemaGetter";

import { label } from "./inner/label.ts";

/** Property names that look like globals are not references. */
const names = { module: "m", process: "p" };

/** Schema, a Schema module by subpath and a file inside src/ are allowed. */
export const allowed = [
  Schema.String,
  forbiddenEncoding,
  label,
  names.process,
  names.module,
];
