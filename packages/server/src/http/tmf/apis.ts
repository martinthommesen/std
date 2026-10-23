/**
 * The TMF Open APIs STD serves (Contracts 11.1). Each is a mapping in
 * `@std/tmf` over a shipped set's classes; the server builds its routes
 * from this list (`routes.ts`). A mapping whose set is not installed
 * answers `404` (`routes.ts`, `served`). TMF621 joined in workstream 3I
 * (decision 0035); the Step 4 APIs join in 4D, 4C and 4O.
 */
import { TMF621_API } from "@std/tmf/tmf621";

import type { TmfRegistry } from "./context.ts";

/** The shipped TMF API mappings. */
export const SHIPPED_TMF_APIS: TmfRegistry = [TMF621_API];
