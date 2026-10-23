/** Frozen pre-policy SQL exceptions: migration id AND exact evaluated text. */
const statements = new Map<number, string>([
  [
    1,
    "INSERT INTO core.config_state (revision, change_set_id) VALUES (0, uuidv7())",
  ],
  [
    3,
    `CREATE FUNCTION core.end_user_sessions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM core.session WHERE user_id = NEW.id;
  RETURN NULL;
END
$$`,
  ],
  [
    11,
    `ALTER TABLE core.platform_migration
  ADD COLUMN state text NOT NULL DEFAULT 'applied'
    CONSTRAINT platform_migration_state CHECK (state IN ('running', 'applied')),
  ADD COLUMN progress jsonb`,
  ],
  [
    14,
    "UPDATE core.delivery SET finished_at = now() WHERE status IN ('done', 'dead')",
  ],
]);

/**
 * Matches the four historical exceptions without normalizing SQL or literals.
 * @param id - Migration id.
 * @param sql - Evaluated statement text.
 * @returns Whether this is the frozen statement at its original id.
 */
export const historicalStatement = (id: number, sql: string): boolean =>
  statements.get(id) === sql;
