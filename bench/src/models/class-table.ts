/**
 * Class-table inheritance exactly as Contracts 2.1 lays it out: one table per
 * class holding the fields it adds, the root row holding `id`, `class_id`,
 * `version` and the audit fields, level foreign keys `(id, class_id)` with
 * `ON DELETE CASCADE`, subtree checks and the class-change trigger.
 *
 * Keys, foreign keys and indexes are added after the bulk load (faster); the
 * resulting schema is the same as creating them up front.
 *
 * Mitigations (Contracts 2.6 allows indexes led by `class_id`): indexes on
 * `(class_id, <field>)` for the parent-level fields that child endpoints
 * filter or sort by, and the endpoint's class restriction repeated on every
 * joined level row (`class_id IN subtree(E)`), so those indexes apply.
 */
import type { ClassDef, ClassName, FieldDef } from "../hierarchy.ts";
import {
  classDef,
  classes,
  fieldDef,
  isAncestorOrSelf,
  lineage,
  subtree,
} from "../hierarchy.ts";
import type { Params } from "../sql-text.ts";
import { classIn, makeParams, q, qn, table } from "../sql-text.ts";
import type {
  FieldValues,
  ModelContext,
  Relation,
  StorageModel,
  WriteModel,
  WriteState,
  WriteStep,
} from "../storage-model.ts";
import { systemColumns } from "../storage-model.ts";
import { castOf } from "../values.ts";
import {
  auditFks,
  auxSchema,
  classChangeTrigger,
  fieldDdl,
  idKeys,
  loadValue,
  referenceFk,
  rootSystemDdl,
  stateValue,
  subtreeCheck,
  ticketCreate,
  ticketFinish,
  ticketForeignKeys,
  ticketIndexes,
  ticketKeys,
  ticketLoad,
  ticketTable,
  userTable,
} from "./common.ts";

const root = "item";

const levelSystem = ["id", "class_id"];

const tableOf = (ctx: ModelContext, cls: ClassName): string =>
  table(ctx.schema, cls);

const ids = (members: readonly ClassDef[]): readonly string[] =>
  members.map((member) => member.id);

const createTable = (ctx: ModelContext, cls: ClassDef): string => {
  const system =
    cls.parent === null
      ? rootSystemDdl
      : ["id uuid NOT NULL", "class_id uuid NOT NULL"];

  const columns = [
    ...system,
    ...cls.fields.map((def) => fieldDdl(def, def.name, false)),
    subtreeCheck(`${cls.name}_class_subtree`, subtree(cls.name)),
  ];

  return `CREATE TABLE ${tableOf(ctx, cls.name)} (${columns.join(", ")})`;
};

const createTables = (ctx: ModelContext): readonly string[] => [
  `CREATE SCHEMA ${q(ctx.schema)}`,
  ...classes.map((cls) => createTable(ctx, cls)),
  ticketCreate(ctx, "fk"),
];

const levelLoad = (
  ctx: ModelContext,
  cls: ClassDef,
  [low, high]: readonly [number, number]
): string => {
  const system = cls.parent === null ? systemColumns : levelSystem;
  const columns = [...system, ...cls.fields.map((def) => q(def.name))];

  const values = [
    ...system.map((column) => `s.${column}`),
    ...cls.fields.map((def) => loadValue(def, "s")),
  ];

  const classFilter =
    cls.parent === null
      ? ""
      : ` AND ${classIn("s.class_id", ids(subtree(cls.name)))}`;

  return (
    `INSERT INTO ${tableOf(ctx, cls.name)} (${columns.join(", ")}) SELECT ${values.join(", ")} ` +
    `FROM ${auxSchema}.stage s WHERE s.n BETWEEN ${low} AND ${high}${classFilter}`
  );
};

const loadJobs: StorageModel["loadJobs"] = (ctx, chunks) => [
  ...classes.flatMap((cls) =>
    chunks.records.map((chunk) => ({
      table: tableOf(ctx, cls.name),
      text: levelLoad(ctx, cls, chunk),
    }))
  ),
  ...ticketLoad(ctx, chunks, "fk"),
];

const keys = (ctx: ModelContext): readonly (readonly string[])[] => [
  ...classes.map((cls) => idKeys(tableOf(ctx, cls.name), cls.name)),
  ticketKeys(ctx),
];

const levelFk = (ctx: ModelContext, cls: ClassDef, parent: ClassName): string =>
  `ALTER TABLE ${tableOf(ctx, cls.name)} ADD CONSTRAINT ${qn(cls.name, "level")} FOREIGN KEY (id, class_id) ` +
  `REFERENCES ${tableOf(ctx, parent)} (id, class_id) ON DELETE CASCADE`;

const foreignKeys = (ctx: ModelContext): readonly string[] => [
  ...classes.flatMap((cls) =>
    cls.parent === null ? [] : [levelFk(ctx, cls, cls.parent)]
  ),
  referenceFk(tableOf(ctx, root), "item_owner_fk", "owner", userTable),
  ...auditFks(tableOf(ctx, root), root),
  ...ticketForeignKeys(ctx, "fk", tableOf(ctx, root)),
];

const index = (
  ctx: ModelContext,
  cls: ClassName,
  columns: readonly string[]
): string =>
  `CREATE INDEX ${qn(cls, ...columns, "idx")} ON ${tableOf(ctx, cls)} (${columns.join(", ")})`;

// Indexes of Contracts 2.6, plus the class_id-led mitigation indexes when enabled.
const indexes = (ctx: ModelContext): readonly string[] => {
  const base = [
    index(ctx, root, ["status", "updated_at"]),
    index(ctx, root, ["owner"]),
    index(ctx, root, ["updated_at"]),
    index(ctx, "computer", ["os"]),
    index(ctx, "laptop", ["cpu_model"]),
    ...ticketIndexes(ctx),
  ];

  const mitigations = [
    index(ctx, root, ["class_id", "updated_at"]),
    index(ctx, root, ["class_id", "status", "updated_at"]),
    index(ctx, root, ["class_id", "cost"]),
    index(ctx, "device", ["class_id", "warranty_until"]),
    index(ctx, "computer", ["class_id", "os"]),
  ];

  return ctx.mitigations ? [...base, ...mitigations] : base;
};

const finish = (ctx: ModelContext): readonly string[] => [
  ...classes.map((cls) => classChangeTrigger(tableOf(ctx, cls.name), cls.name)),
  ...ticketFinish(ctx),
];

const levelAlias = (alias: string, cls: ClassName): string =>
  cls === root ? alias : `${alias}_${cls}`;

const relation = (
  ctx: ModelContext,
  endpoint: ClassName,
  alias: string
): Relation => {
  const chain = lineage(endpoint).map((cls) => cls.name);
  const optional: ClassName[] = [];
  const members = ids(subtree(endpoint));

  const column = (cls: ClassName, field: string): string => {
    if (!chain.includes(cls)) {
      if (!isAncestorOrSelf(endpoint, cls)) {
        throw new Error(`${cls}.${field} is not reachable from ${endpoint}`);
      }

      if (!optional.includes(cls)) {
        optional.push(cls);
      }
    }

    return `${levelAlias(alias, cls)}.${q(field)}`;
  };

  // With mitigations, every joined level row repeats the endpoint's class restriction.
  const endpointFilter = (): string | null =>
    ctx.mitigations && endpoint !== root
      ? chain
          .map((cls) => classIn(`${levelAlias(alias, cls)}.class_id`, members))
          .join(" AND ")
      : null;

  const join = (cls: ClassName, kind: "JOIN" | "LEFT JOIN"): string => {
    const level = levelAlias(alias, cls);

    return `${kind} ${tableOf(ctx, cls)} ${level} ON ${level}.id = ${alias}.id`;
  };

  const from = (): string => {
    const parts = [
      `${tableOf(ctx, root)} ${alias}`,
      ...chain.slice(1).map((cls) => join(cls, "JOIN")),
      ...optional.map((cls) => join(cls, "LEFT JOIN")),
    ];

    return parts.length === 1 ? (parts[0] ?? "") : `(${parts.join(" ")})`;
  };

  return { column, endpointFilter, from, system: (name) => `${alias}.${name}` };
};

const fieldValue = (
  values: FieldValues,
  level: ClassName,
  field: FieldDef
): string | null => values.get(`${level}.${field.name}`) ?? null;

interface BoundFields {
  readonly columns: string;
  readonly values: string;
}

const boundFields = (
  level: ClassDef,
  values: FieldValues,
  params: Params
): BoundFields => {
  const bound = level.fields.map((def) => ({
    column: q(def.name),
    value: params.bind(fieldValue(values, level.name, def), castOf(def)),
  }));

  return {
    columns: bound.map((entry) => entry.column).join(", "),
    values: bound.map((entry) => entry.value).join(", "),
  };
};

const insertRoot = (
  ctx: ModelContext,
  cls: ClassName,
  values: FieldValues,
  actor: string
): WriteStep => ({
  build: () => {
    const params = makeParams();
    const fields = boundFields(classDef(root), values, params);
    const classParam = params.bind(classDef(cls).id, "uuid");
    const actorParam = params.bind(actor, "uuid");

    const text =
      `INSERT INTO ${tableOf(ctx, root)} (${systemColumns.join(", ")}, ${fields.columns}) ` +
      `VALUES (uuidv7(), ${classParam}, 1, now(), ${actorParam}, now(), ${actorParam}, ${fields.values}) ` +
      "RETURNING id::text AS id";

    return { params: params.values(), text };
  },
  expectRow: true,
});

const insertLevel = (
  ctx: ModelContext,
  cls: ClassName,
  level: ClassDef,
  values: FieldValues
): WriteStep => ({
  build: (state: WriteState) => {
    const params = makeParams();
    const fields = boundFields(level, values, params);
    const idParam = params.bind(stateValue(state, "id"), "uuid");
    const classParam = params.bind(classDef(cls).id, "uuid");

    const text =
      `INSERT INTO ${tableOf(ctx, level.name)} (id, class_id, ${fields.columns}) ` +
      `VALUES (${idParam}, ${classParam}, ${fields.values})`;

    return { params: params.values(), text };
  },
  expectRow: false,
});

const lockRoot = (
  ctx: ModelContext,
  mode: "no key update" | "update"
): WriteStep => ({
  build: (state) => {
    const params = makeParams();
    const id = params.bind(stateValue(state, "id"), "uuid");

    const text =
      `SELECT version::text AS version, class_id::text AS class_id FROM ${tableOf(ctx, root)} ` +
      `WHERE id = ${id} FOR ${mode.toUpperCase()}`;

    return { params: params.values(), text };
  },
  expectRow: true,
});

const updateLevel = (
  ctx: ModelContext,
  field: { readonly cls: ClassName; readonly name: string },
  value: string | null
): WriteStep => ({
  build: (state) => {
    const params = makeParams();

    const def = fieldDef(field.cls, field.name);

    const id = params.bind(stateValue(state, "id"), "uuid");
    const assigned = params.bind(value, castOf(def));
    const text = `UPDATE ${tableOf(ctx, field.cls)} SET ${q(field.name)} = ${assigned} WHERE id = ${id} RETURNING id::text AS id`;

    return { params: params.values(), text };
  },
  expectRow: true,
});

const bumpVersion = (ctx: ModelContext, actor: string): WriteStep => ({
  build: (state) => {
    const params = makeParams();
    const id = params.bind(stateValue(state, "id"), "uuid");
    const actorParam = params.bind(actor, "uuid");
    const version = params.bind(stateValue(state, "version"), "bigint");

    const text =
      `UPDATE ${tableOf(ctx, root)} SET version = version + 1, updated_at = now(), updated_by = ${actorParam} ` +
      `WHERE id = ${id} AND version = ${version} RETURNING version::text AS version`;

    return { params: params.values(), text };
  },
  expectRow: true,
});

const deleteRoot = (ctx: ModelContext): WriteStep => ({
  build: (state) => {
    const params = makeParams();
    const id = params.bind(stateValue(state, "id"), "uuid");
    const version = params.bind(stateValue(state, "version"), "bigint");
    const text = `DELETE FROM ${tableOf(ctx, root)} WHERE id = ${id} AND version = ${version} RETURNING id::text AS id`;

    return { params: params.values(), text };
  },
  expectRow: true,
});

const writes = (ctx: ModelContext): WriteModel => ({
  insert: (cls, values, actor) => [
    insertRoot(ctx, cls, values, actor),
    ...lineage(cls)
      .slice(1)
      .map((level) => insertLevel(ctx, cls, level, values)),
  ],
  lock: (_endpoint, mode) => [lockRoot(ctx, mode)],
  remove: () => [deleteRoot(ctx)],
  update: (_cls, field, value, actor) => [
    updateLevel(ctx, field, value),
    bumpVersion(ctx, actor),
  ],
});

/** Class-table storage (the model STD uses). */
export const classTableModel: StorageModel = {
  createTables,
  finish,
  foreignKeys,
  id: "class-table",
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
  title: "class-table",
  writes,
};
