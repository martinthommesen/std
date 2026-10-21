/**
 * Helpers for the config layer, upgrade and doctor tests: the upgrade
 * fixture set, set variants written to temporary directories, and queries
 * of the layer tables.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  FieldEntry,
  NamedSetFile,
  SetFile,
  TableEntry,
  TypeEntry,
} from "@std/definitions/set-file";
import { SYSTEM_USER_ID, USER_CLASS_ID } from "@std/definitions/well-known";
import { Effect } from "effect";
import { stringify } from "yaml";

import { values } from "./schema-support.ts";

/** The upgrade fixture's directories (`examples/upgrade-fixture`). */
export const FIXTURE = {
  v1: new URL("../../../examples/upgrade-fixture/v1", import.meta.url).pathname,
  v2: new URL("../../../examples/upgrade-fixture/v2", import.meta.url).pathname,
  v3: new URL("../../../examples/upgrade-fixture/v3", import.meta.url).pathname,
} as const;

/** Stable IDs of the upgrade fixture. */
export const FX = {
  approver: "46a4d035-778a-4921-9e4a-d42b76fe35ae",
  foo: "56a30fc6-43d8-4353-a244-1f9fd7cce7d7",
  item: "89a1d501-ec59-41be-aefc-b4dfa2b43ecc",
  namespace: "e93f72f4-d801-4e89-a262-3113bca8ef73",
  reviewer: "1cd6855e-fcfb-440b-a801-4aa41dab99ff",
  ruleFields: "2b97bff9-a239-4199-8703-06013c70c775",
  ruleRecords: "7c00d9a7-db1b-4726-bf62-aca982ae2612",
  set: "01d6f657-c4f6-47de-9d47-78a7281d98d2",
  w: "db1cec97-896f-4071-af4a-2a0bb2cb7c75",
  x: "8bd6796c-93a5-4fe8-a0b2-ba630a27722f",
  z: "4fe2275c-f07c-47db-a9a1-88e3d1479fdb",
} as const;

/** The admin of the tests, a `core.user` row `withAdmin` inserts. */
export const ADMIN = "0d4f4bde-1c7a-4a4e-9d3e-0a5b8c6f7e21";

/**
 * Inserts the tests' admin into `core.user` (as table owner, until the
 * record service exists), so audit IDs written by admin edits name a user.
 *
 * @returns The effect.
 */
export const insertAdmin = values(
  `INSERT INTO core."user" (id, class_id, version, created_at, created_by, updated_at, updated_by, name, login, active)
   VALUES ($1::uuid, $2::uuid, 1, now(), $3::uuid, now(), $3::uuid, 'Admin', 'admin', true)
   ON CONFLICT (id) DO NOTHING`,
  [ADMIN, USER_CLASS_ID, SYSTEM_USER_ID]
);

/** A set file whose lists can be replaced. */
type MutableSetFile = { -readonly [K in keyof SetFile]: SetFile[K] };

/** Changes to a set's single file. */
export interface SetVariant {
  readonly version: number;
  /** Replaces field labels, by field name. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Replaces field types, by field name. */
  readonly types?: Readonly<Record<string, TypeEntry>>;
  /** Fields appended to every table. */
  readonly addFields?: readonly FieldEntry[];
  /** Access rules to leave out, by ID. */
  readonly dropRules?: readonly string[];
  /** Roles to leave out, by name. */
  readonly dropRoles?: readonly string[];
  /** Replaces the file's content (header, namespaces, tables...). */
  readonly replace?: Partial<MutableSetFile>;
}

const changeField = (field: FieldEntry, variant: SetVariant): FieldEntry => {
  const label = variant.labels?.[field.name] ?? field.label;
  const type = variant.types?.[field.name] ?? field.type;

  return label === undefined ? { ...field, type } : { ...field, label, type };
};

const changeTable = (table: TableEntry, variant: SetVariant): TableEntry => ({
  ...table,
  fields: [
    ...(table.fields ?? []).map((field) => changeField(field, variant)),
    ...(variant.addFields ?? []),
  ],
});

const changeFile = (content: SetFile, variant: SetVariant): SetFile => {
  const next: MutableSetFile = { ...content };
  const dropRules = new Set(variant.dropRules);
  const dropRoles = new Set(variant.dropRoles);

  if (content.set !== undefined) {
    next.set = { ...content.set, version: variant.version };
  }

  if (content.tables !== undefined) {
    next.tables = content.tables.map((table) => changeTable(table, variant));
  }

  if (content.accessRules !== undefined) {
    next.accessRules = content.accessRules.filter(
      (rule) => !dropRules.has(rule.id)
    );
  }

  if (content.roles !== undefined) {
    next.roles = content.roles.filter((role) => !dropRoles.has(role.name));
  }

  return { ...next, ...variant.replace };
};

/**
 * A variant of a one-file set.
 *
 * @param files - The set's files (one file with the header).
 * @param variant - The new version and changes.
 * @returns The changed files.
 */
export const variantOf = (
  files: readonly NamedSetFile[],
  variant: SetVariant
): readonly NamedSetFile[] =>
  files.map((file) => ({
    content: changeFile(file.content, variant),
    path: file.path,
  }));

/**
 * Writes set files to a fresh temporary directory, removed with the scope.
 *
 * @param files - The files.
 * @returns The directory.
 */
export const writeSetDirectory = (files: readonly NamedSetFile[]) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "std-set-"));

      await Promise.all(
        files.map(async (file) => {
          await writeFile(
            path.join(directory, path.basename(file.path)),
            stringify(file.content),
            "utf-8"
          );
        })
      );

      return directory;
    }),
    (directory) =>
      Effect.promise(async () => {
        await rm(directory, { force: true, recursive: true });
      })
  );

/**
 * A field's effective label.
 *
 * @param id - The field.
 * @returns The label.
 */
export const fieldLabel = (id: string) =>
  values("SELECT label AS value FROM core.field WHERE id = $1::uuid", [
    id,
  ]).pipe(Effect.map(([label]) => label));

/**
 * The label in a field's latest definition revision, with its revision.
 *
 * @param id - The field.
 * @returns `revision label`.
 */
export const latestRevisionLabel = (id: string) =>
  values(
    `SELECT revision::text || ' ' || (effective ->> 'label') AS value FROM core.definition_revision
     WHERE definition_id = $1::uuid ORDER BY revision DESC LIMIT 1`,
    [id]
  ).pipe(Effect.map(([value]) => value));

/**
 * The overrides of a record, as `property=value@base_when_set`.
 *
 * @param id - The record.
 * @returns The rows, sorted.
 */
export const overridesOf = (id: string) =>
  values(
    `SELECT concat(property, '=', coalesce(value #>> '{}', 'null'), '@', coalesce(base_when_set #>> '{}', 'null')) AS value
     FROM core."config_override" WHERE record_id = $1::uuid ORDER BY property`,
    [id]
  );

/**
 * The conflicts of a record, as `state resolution property old>new local`.
 *
 * @param id - The record.
 * @returns The rows, oldest first.
 */
export const conflictsOf = (id: string) =>
  values(
    `SELECT concat_ws(' ', state, coalesce(resolution, '-'), property,
       (old_shipped #>> '{}') || '>' || (new_shipped #>> '{}'), local_value #>> '{}') AS value
     FROM core."config_conflict" WHERE record_id = $1::uuid ORDER BY created_at, id`,
    [id]
  );

/**
 * The open conflict of a record's property.
 *
 * @param id - The record.
 * @returns The conflict's ID, or an empty string.
 */
export const openConflictOf = (id: string) =>
  values(
    `SELECT id::text AS value FROM core."config_conflict" WHERE record_id = $1::uuid AND state = 'open'`,
    [id]
  ).pipe(Effect.map(([conflict]) => conflict ?? ""));

/** The open conflicts' IDs, oldest first. */
export const openConflictIds = values(
  `SELECT id::text AS value FROM core."config_conflict" WHERE state = 'open' ORDER BY created_at, id`
);

/**
 * A fingerprint of the catalog outside the system schemas: every relation
 * with its columns, and every constraint with its validation state (what a
 * schema-only dump would show).
 */
export const catalogFingerprint = values(
  `SELECT md5(coalesce(string_agg(x, ',' ORDER BY x), '')) AS value FROM (
     SELECT c.oid::regclass::text || ':' || c.relkind::text || ':' || coalesce((
       SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull::text, ';' ORDER BY a.attnum)
       FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '') AS x
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
     UNION ALL
     SELECT con.conrelid::regclass::text || ':' || con.conname || ':' || con.convalidated::text
     FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
   ) AS s`
).pipe(Effect.map(([value]) => value));

const CONFIG_TABLES = [
  "config_state",
  "config_set",
  "config_base",
  "config_override",
  "config_conflict",
  "namespace",
  "class",
  "field",
  "field_override",
  "index",
  "role",
  "permission",
  "role_permission",
  "access_rule",
  "subscription",
  "schema_change",
  "schema_change_step",
  "config_dependency",
  "definition_revision",
] as const;

/** A fingerprint of every config table's rows. */
export const configFingerprint = values(
  `SELECT ${CONFIG_TABLES.map(
    (table) =>
      `(SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) FROM core."${table}" AS t)`
  ).join(" || ")} AS value`
).pipe(Effect.map(([value]) => value));
