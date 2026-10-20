import { Schema } from "effect";
import { forbiddenEncoding } from "effect/SchemaGetter";

import { label } from "./inner/label.ts";

/** Schema, a Schema module by subpath and a file inside src/ are allowed. */
export const allowed = [Schema.String, forbiddenEncoding, label];
