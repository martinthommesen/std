/**
 * A logical record as the write side reads it: the root row's system
 * columns and the stored value of every field of its concrete class.
 */
import type { DefinitionId } from "@std/definitions/ids";
import type { StoredValue } from "@std/values/field-value";

/** One logical record, all levels joined. */
export interface StoredRecord {
  readonly id: string;
  /** The concrete class. */
  readonly classId: DefinitionId;
  readonly version: number;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  readonly createdBy: string;
  /** Epoch milliseconds. */
  readonly updatedAt: number;
  readonly updatedBy: string;
  /**
   * The stored value of every live field of the concrete class, by field
   * ID. Password and secret fields hold `{ set }`.
   */
  readonly values: ReadonlyMap<DefinitionId, StoredValue | null>;
}
