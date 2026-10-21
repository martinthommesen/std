/**
 * Advisory lock keys used by STD (Contracts 1.4).
 *
 * Both keys are 64-bit advisory lock keys. The high 32 bits are `0x53544400`
 * (ASCII "STD" followed by a zero byte) and the low 32 bits name the lock, so
 * the keys are easy to spot in `pg_locks`, where a bigint advisory key shows
 * as `classid = 1398031360`, `objid = <low 32 bits>`, `objsubid = 1`.
 *
 * Lock order is always `SCHEMA_KEY`, then `CONFIG_KEY`, then table locks.
 */

/** 2^32: divides a 64-bit key into its high and low 32 bits. */
const HIGH_WORD = 0x1_00_00_00_00n;

/** The `classid` that `pg_locks` shows for every STD advisory lock key. */
export const STD_LOCK_CLASS_ID = 0x53_54_44_00;

/**
 * Transaction-level advisory lock taken shared by every request (inside
 * `core.begin_request()`) and exclusive by every config commit, so no request
 * overlaps a config commit. Value `6004498969982402561` (`0x5354440000000001`).
 */
export const CONFIG_KEY = 0x53_54_44_00_00_00_00_01n;

/**
 * Session-level advisory lock held exclusively by the schema-change
 * coordinator (from start through `complete`) and by `std upgrade`. Always
 * taken with `pg_try_advisory_lock`, never with a blocking call. Value
 * `6004498969982402562` (`0x5354440000000002`).
 */
export const SCHEMA_KEY = 0x53_54_44_00_00_00_00_02n;

/**
 * The `objid` that `pg_locks` shows for a bigint advisory key: its low 32 bits.
 * @param key - The 64-bit advisory lock key.
 * @returns The low 32 bits as an unsigned number.
 */
export const advisoryObjectId = (key: bigint): number =>
  Number(BigInt.asUintN(32, key));

/**
 * The `classid` that `pg_locks` shows for a bigint advisory key: its high 32 bits.
 * @param key - The 64-bit advisory lock key.
 * @returns The high 32 bits as an unsigned number.
 */
export const advisoryClassId = (key: bigint): number =>
  Number(BigInt.asUintN(32, key / HIGH_WORD));
