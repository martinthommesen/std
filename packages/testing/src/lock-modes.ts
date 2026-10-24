/** Lock modes as `pg_locks.mode` names them, weakest first. */
const MODES = [
  "AccessShareLock",
  "RowShareLock",
  "RowExclusiveLock",
  "ShareUpdateExclusiveLock",
  "ShareLock",
  "ShareRowExclusiveLock",
  "ExclusiveLock",
  "AccessExclusiveLock",
] as const;

/** Postgres's conflict table (explicit locking, table 13.2), by index in `MODES`. */
const CONFLICT_INDEXES: readonly (readonly number[])[] = [
  [7],
  [6, 7],
  [4, 5, 6, 7],
  [3, 4, 5, 6, 7],
  [2, 3, 5, 6, 7],
  [2, 3, 4, 5, 6, 7],
  [1, 2, 3, 4, 5, 6, 7],
  [0, 1, 2, 3, 4, 5, 6, 7],
];

const CONFLICTS = new Map<string, ReadonlySet<string | undefined>>(
  MODES.map((mode, index) => [
    mode,
    new Set((CONFLICT_INDEXES[index] ?? []).map((other) => MODES[other])),
  ])
);

/**
 * Whether holding `held` already excludes every session that would block
 * `wanted`.
 * @param held - The listed mode.
 * @param wanted - The mode the statement took.
 * @returns True when `held` covers `wanted`.
 */
export const modeCovers = (held: string, wanted: string): boolean => {
  const heldConflicts = CONFLICTS.get(held);
  const wantedConflicts = CONFLICTS.get(wanted);

  return (
    heldConflicts !== undefined &&
    wantedConflicts !== undefined &&
    [...wantedConflicts].every((mode) => heldConflicts.has(mode))
  );
};
