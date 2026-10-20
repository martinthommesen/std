import type { wrap } from "allowed-wrapper";

/** An allow-listed package that reaches effect through an alias, two levels down. */
export type ViaTransitive = typeof wrap;
