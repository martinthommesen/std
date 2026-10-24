/**
 * One table per concrete class holding all inherited fields. A child endpoint
 * with one concrete class reads one table; a parent endpoint reads a
 * `UNION ALL` over the tables of its subtree. The class is implied by the
 * table, so there is no `class_id` column, no class-change trigger, no real
 * foreign key from `ticket.item`, and no ID uniqueness across tables. A delete
 * emulates the `NO ACTION` refusal with `NOT EXISTS` (not race-free).
 */
import type { ClassDef, ClassName, EndpointField } from "../hierarchy.ts";
import {
  classes,
  classById,
  endpointFields,
  fieldDef,
  hierarchyColumn,
  lineage,
  subtree,
} from "../hierarchy.ts";
import { makeParams, q, qn, table, uuidLiteral } from "../sql-text.ts";
import type {
  FieldValues,
  ModelContext,
  Relation,
  StorageModel,
  SystemColumn,
  WriteModel,
  WriteStep,
} from "../storage-model.ts";
import { systemColumns } from "../storage-model.ts";
import { castOf } from "../values.ts";
import {
  auditFks,
  auxSchema,
  fieldDdl,
  loadValue,
  referenceFk,
  stateValue,
  ticketCreate,
  ticketFinish,
  ticketForeignKeys,
  ticketIndexes,
  ticketKeys,
  ticketLoad,
  ticketTable,
  userTable,
} from "./common.ts";

const ownSystemDdl = [
  "id uuid NOT NULL",
  "version bigint NOT NULL",
  "created_at timestamptz(3) NOT NULL",
  "created_by uuid NOT NULL",
  "updated_at timestamptz(3) NOT NULL",
  "updated_by uuid NOT NULL",
];

const ownSystem = systemColumns.filter((column) => column !== "class_id");

const tableOf = (ctx: ModelContext, cls: ClassName): string =>
  table(ctx.schema, cls);

const createTable = (ctx: ModelContext, cls: ClassDef): string => {
  const definitions = [
    ...ownSystemDdl,
    ...endpointFields(cls.name).map((entry) =>
      fieldDdl(entry.field, entry.field.name, false)
    ),
  ];

  return `CREATE TABLE ${tableOf(ctx, cls.name)} (${definitions.join(", ")})`;
};

const createTables = (ctx: ModelContext): readonly string[] => [
  `CREATE SCHEMA ${q(ctx.schema)}`,
  ...classes.map((cls) => createTable(ctx, cls)),
  ticketCreate(ctx, "no-fk"),
];

const classLoad = (
  ctx: ModelContext,
  cls: ClassDef,
  [low, high]: readonly [number, number]
): string => {
  const fields = endpointFields(cls.name);
  const names = [...ownSystem, ...fields.map((entry) => q(entry.field.name))];

  const values = [
    ...ownSystem.map((column) => `s.${column}`),
    ...fields.map((entry) => loadValue(entry.field, "s")),
  ];

  return (
    `INSERT INTO ${tableOf(ctx, cls.name)} (${names.join(", ")}) SELECT ${values.join(", ")} ` +
    `FROM ${auxSchema}.stage s WHERE s.n BETWEEN ${low} AND ${high} AND s.class_id = ${uuidLiteral(cls.id)}`
  );
};

const loadJobs: StorageModel["loadJobs"] = (ctx, chunks) => [
  ...classes.flatMap((cls) =>
    chunks.records.map((chunk) => ({
      table: tableOf(ctx, cls.name),
      text: classLoad(ctx, cls, chunk),
    }))
  ),
  ...ticketLoad(ctx, chunks, "no-fk"),
];

const keys = (ctx: ModelContext): readonly (readonly string[])[] => [
  ...classes.map((cls) => [
    `ALTER TABLE ${tableOf(ctx, cls.name)} ADD CONSTRAINT ${qn(cls.name, "pkey")} PRIMARY KEY (id)`,
  ]),
  ticketKeys(ctx),
];

const foreignKeys = (ctx: ModelContext): readonly string[] => [
  ...classes.flatMap((cls) => [
    referenceFk(
      tableOf(ctx, cls.name),
      `${cls.name}_owner_fk`,
      "owner",
      userTable
    ),
    ...auditFks(tableOf(ctx, cls.name), cls.name),
  ]),
  ...ticketForeignKeys(ctx, "no-fk", ""),
];

const classIndexes = (ctx: ModelContext, cls: ClassDef): readonly string[] => {
  const target = tableOf(ctx, cls.name);
  const chain = new Set(lineage(cls.name).map((level) => level.name));

  const os = chain.has("computer")
    ? [`CREATE INDEX ${qn(cls.name, "os_idx")} ON ${target} (os)`]
    : [];

  const cpu = chain.has("laptop")
    ? [`CREATE INDEX ${qn(cls.name, "cpu_model_idx")} ON ${target} (cpu_model)`]
    : [];

  return [
    `CREATE INDEX ${qn(cls.name, "status_updated_at_idx")} ON ${target} (status, updated_at)`,
    `CREATE INDEX ${qn(cls.name, "owner_idx")} ON ${target} (owner)`,
    `CREATE INDEX ${qn(cls.name, "updated_at_idx")} ON ${target} (updated_at)`,
    ...os,
    ...cpu,
  ];
};

const indexes = (ctx: ModelContext): readonly string[] => [
  ...classes.flatMap((cls) => classIndexes(ctx, cls)),
  ...ticketIndexes(ctx),
];

const projection = (
  member: ClassDef,
  needed: readonly EndpointField[]
): readonly string[] => {
  const chain = new Set(lineage(member.name).map((level) => level.name));

  return [
    ...systemColumns.map((name) =>
      name === "class_id" ? `${uuidLiteral(member.id)} AS class_id` : name
    ),
    ...needed.map((entry) => {
      const output = q(hierarchyColumn(entry.cls, entry.field.name));

      return chain.has(entry.cls)
        ? `${q(entry.field.name)} AS ${output}`
        : `NULL::${entry.field.sqlType} AS ${output}`;
    }),
  ];
};

const relation = (
  ctx: ModelContext,
  endpoint: ClassName,
  alias: string
): Relation => {
  const members = subtree(endpoint);
  const needed: EndpointField[] = [];
  const [only] = members;
  const single = members.length === 1 ? only : undefined;

  const system = (name: SystemColumn): string =>
    name === "class_id" && single !== undefined
      ? uuidLiteral(single.id)
      : `${alias}.${name}`;

  const column = (cls: ClassName, field: string): string => {
    const def = fieldDef(cls, field);

    if (
      !needed.some((entry) => entry.cls === cls && entry.field.name === field)
    ) {
      needed.push({ cls, field: def });
    }

    return single === undefined
      ? `${alias}.${q(hierarchyColumn(cls, field))}`
      : `${alias}.${q(field)}`;
  };

  const branch = (member: ClassDef): string =>
    `SELECT ${projection(member, needed).join(", ")} FROM ${tableOf(ctx, member.name)}`;

  const from = (): string =>
    single === undefined
      ? `(${members.map(branch).join(" UNION ALL ")}) ${alias}`
      : `${tableOf(ctx, single.name)} ${alias}`;

  return { column, endpointFilter: () => null, from, system };
};

const insertStep = (
  ctx: ModelContext,
  cls: ClassName,
  values: FieldValues,
  actor: string
): WriteStep => ({
  build: () => {
    const params = makeParams();

    const bound = endpointFields(cls).map((entry) => ({
      column: q(entry.field.name),
      value: params.bind(
        values.get(`${entry.cls}.${entry.field.name}`) ?? null,
        castOf(entry.field)
      ),
    }));

    const actorParam = params.bind(actor, "uuid");
    const fieldColumns = bound.map((entry) => entry.column).join(", ");
    const fieldValues = bound.map((entry) => entry.value).join(", ");

    const text =
      `INSERT INTO ${tableOf(ctx, cls)} (${ownSystem.join(", ")}, ${fieldColumns}) ` +
      `VALUES (uuidv7(), 1, now(), ${actorParam}, now(), ${actorParam}, ${fieldValues}) RETURNING id::text AS id`;

    return { params: params.values(), text };
  },
  expectRow: true,
});

const lockIn = (
  ctx: ModelContext,
  mode: "no key update" | "update",
  fixed: ClassDef | null
): WriteStep => ({
  build: (state) => {
    const params = makeParams();
    const id = params.bind(stateValue(state, "id"), "uuid");
    const cls = fixed ?? classById(stateValue(state, "class_id"));

    const text =
      `SELECT version::text AS version, '${cls.id}' AS class_id FROM ${tableOf(ctx, cls.name)} ` +
      `WHERE id = ${id} FOR ${mode.toUpperCase()}`;

    return { params: params.values(), text };
  },
  expectRow: true,
});

const findClass = (
  ctx: ModelContext,
  members: readonly ClassDef[]
): WriteStep => ({
  build: (state) => {
    const params = makeParams();
    const id = params.bind(stateValue(state, "id"), "uuid");

    const union = members
      .map(
        (member) =>
          `SELECT id, '${member.id}' AS class_id FROM ${tableOf(ctx, member.name)}`
      )
      .join(" UNION ALL ");

    const text = `SELECT class_id FROM (${union}) x WHERE id = ${id}`;

    return { params: params.values(), text };
  },
  expectRow: true,
});

const lock = (
  ctx: ModelContext,
  endpoint: ClassName,
  mode: "no key update" | "update"
): readonly WriteStep[] => {
  const members = subtree(endpoint);
  const [only] = members;

  return members.length === 1 && only !== undefined
    ? [lockIn(ctx, mode, only)]
    : [findClass(ctx, members), lockIn(ctx, mode, null)];
};

interface UpdateTarget {
  readonly cls: ClassName;
  readonly field: { readonly cls: ClassName; readonly name: string };
  readonly value: string | null;
  readonly actor: string;
}

const updateStep = (ctx: ModelContext, target: UpdateTarget): WriteStep => ({
  build: (state) => {
    const def = fieldDef(target.field.cls, target.field.name);

    const params = makeParams();
    const id = params.bind(stateValue(state, "id"), "uuid");
    const assigned = params.bind(target.value, castOf(def));
    const actorParam = params.bind(target.actor, "uuid");
    const version = params.bind(stateValue(state, "version"), "bigint");

    const text =
      `UPDATE ${tableOf(ctx, target.cls)} SET ${q(target.field.name)} = ${assigned}, version = version + 1, ` +
      `updated_at = now(), updated_by = ${actorParam} WHERE id = ${id} AND version = ${version} RETURNING version::text AS version`;

    return { params: params.values(), text };
  },
  expectRow: true,
});

const deleteStep = (ctx: ModelContext, cls: ClassName): WriteStep => ({
  build: (state) => {
    const params = makeParams();
    const id = params.bind(stateValue(state, "id"), "uuid");
    const version = params.bind(stateValue(state, "version"), "bigint");

    const text =
      `DELETE FROM ${tableOf(ctx, cls)} WHERE id = ${id} AND version = ${version} ` +
      `AND NOT EXISTS (SELECT 1 FROM ${ticketTable(ctx)} WHERE item = ${id}) RETURNING id::text AS id`;

    return { params: params.values(), text };
  },
  expectRow: true,
});

const writes = (ctx: ModelContext): WriteModel => ({
  insert: (cls, values, actor) => [insertStep(ctx, cls, values, actor)],
  lock: (endpoint, mode) => lock(ctx, endpoint, mode),
  remove: (cls) => [deleteStep(ctx, cls)],
  update: (cls, field, value, actor) => [
    updateStep(ctx, { actor, cls, field, value }),
  ],
});

/** One table per concrete class with all inherited fields. */
export const concreteTableModel: StorageModel = {
  createTables,
  finish: ticketFinish,
  foreignKeys,
  id: "concrete-table",
  indexes,
  keys,
  loadJobs,
  relation,
  tables: (ctx) => [
    ...classes.map((cls) => tableOf(ctx, cls.name)),
    ticketTable(ctx),
  ],
  ticketItemJoin: (ticketAlias, item) =>
    `${item.system("id")} = ${ticketAlias}.item`,
  title: "one table per concrete class",
  writes,
};
