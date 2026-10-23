/**
 * The TMF Open APIs STD serves (Contracts 11.1). Each is a mapping in
 * `@std/tmf` over a shipped set's classes; the server builds its routes
 * from this list (`routes.ts`). TMF621 joins in workstream 3I, the Step 4
 * APIs in 4D, 4C and 4O.
 */
import type { TmfRegistry } from "./context.ts";

/** The shipped TMF API mappings. */
export const SHIPPED_TMF_APIS: TmfRegistry = [];
