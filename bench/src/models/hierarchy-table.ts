/**
 * One table per hierarchy (the baseline), and the same table LIST-partitioned
 * by class. All fields of the hierarchy are columns of `bench.item`, mapped by
 * the field-to-column map (`hierarchyColumn`); class-specific required fields
 * and sibling exclusion become class-conditional CHECKs, and indexes on child
 * fields are partial per class (or per partition).
 */
import type { ClassDef, ClassName, FieldDef } from "../hierarchy.ts";
import {
  classDef,
  classes,
  fieldDef,
  hierarchyColumn,
  endpointFields,
  lineage,
  subtree,
} from "../hierarchy.ts";
import type { Params } from "../sql-text.ts";
import { classIn, makeParams, q, qn, table, uuidLiteral } from "../sql-text.ts";
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
import type { TicketItemStorage } from "./common.ts";

const root = "item";

interface Column {
  readonly cls: ClassDef;
  readonly def: FieldDef;
  readonly name: string;
}

const columns: readonly Column[] = classes.flatMap((cls) =>
  cls.fields.map((def) => ({
    cls,
    def,
    name: hierarchyColumn(cls.name, def.name),
  }))
);

const all = (parts: readonly string[]): string => parts.join(" AND ");

const isNull = (column: Column): string => `${q(column.name)} IS NULL`;

const isNotNull = (column: Column): string => `${q(column.name)} IS NOT NULL`;

const ids = (members: readonly ClassDef[]): readonly string[] =>
  members.map((member) => member.id);

const ticketStorage = (partitioned: boolean): TicketItemStorage =>
  partitioned ? "fk-with-class" : "fk";

const itemTable = (ctx: ModelContext): string => table(ctx.schema, root);

const partitionTable = (ctx: ModelContext, cls: ClassName): string =>
  table(ctx.schema, `item_${cls}`);

const check = (name: string, condition: string): string =>
  `CONSTRAINT ${q(name)} CHECK (${condition})`;

// Class-conditional checks: required child fields present, other classes' fields absent.
const conditionalChecks = (cls: ClassDef): readonly string[] => {
  if (cls.parent === null) {
    return [];
  }

  const own = columns.filter((column) => column.cls.name === cls.name);
  const members = classIn("class_id", ids(subtree(cls.name)));
  const required = own.filter((column) => column.def.required);

  const absent = check(
    `${cls.name}_absent`,
    `(${members}) OR (${all(own.map(isNull))})`
  );

  return required.length === 0
    ? [absent]
    : [
        check(
          `${cls.name}_required`,
          `NOT (${members}) OR (${all(required.map(isNotNull))})`
        ),
        absent,
      ];
};

// Per-partition checks: the same rules, specialised to the partition's one class.
const partitionChecks = (cls: ClassDef): readonly string[] => {
  const chain = new Set(lineage(cls.name).map((member) => member.name));

  const required = columns.filter(
    (column) =>
      column.cls.parent !== null &&
      chain.has(column.cls.name) &&
      column.def.required
  );

  const absent = columns.filter((column) => !chain.has(column.cls.name));

  return [
    ...(required.length === 0
      ? []
      : [check(`item_${cls.name}_required`, all(required.map(isNotNull)))]),
    ...(absent.length === 0
      ? []
      : [check(`item_${cls.name}_absent`, all(absent.map(isNull)))]),
  ];
};

const partitionDdl = (ctx: ModelContext, cls: ClassDef): string => {
  const checks = partitionChecks(cls).join(", ") || "CHECK (true)";

  return `CREATE TABLE ${partitionTable(ctx, cls.name)} PARTITION OF ${itemTable(ctx)} (${checks}) FOR VALUES IN (${uuidLiteral(cls.id)})`;
};

const createTables = (
  ctx: ModelContext,
  partitioned: boolean
): readonly string[] => {
  const definitions = [
    ...rootSystemDdl,
    ...columns.map((column) =>
      fieldDdl(column.def, column.name, column.cls.parent !== null)
    ),
    subtreeCheck("item_class_subtree", classes),
    ...(partitioned ? [] : classes.flatMap(conditionalChecks)),
  ];

  const partitionClause = partitioned ? " PARTITION BY LIST (class_id)" : "";

  return [
    `CREATE SCHEMA ${q(ctx.schema)}`,
    `CREATE TABLE ${itemTable(ctx)} (${definitions.join(", ")})${partitionClause}`,
    ...(partitioned ? classes.map((cls) => partitionDdl(ctx, cls)) : []),
    ticketCreate(ctx, ticketStorage(partitioned)),
  ];
};

const columnLoad = (column: Column): string => {
  const value = loadValue(column.def, "s");

  return column.cls.parent === null
    ? value
    : `CASE WHEN ${classIn("s.class_id", ids(subtree(column.cls.name)))} THEN ${value} END`;
};

const loadJobs =
  (partitioned: boolean): StorageModel["loadJobs"] =>
  (ctx, chunks) => {
    const names = [
      ...systemColumns,
      ...columns.map((column) => q(column.name)),
    ];

    const values = [
      ...systemColumns.map((column) => `s.${column}`),
      ...columns.map(columnLoad),
    ];

    const insert = `INSERT INTO ${itemTable(ctx)} (${names.join(", ")}) SELECT ${values.join(", ")} FROM ${auxSchema}.stage s`;

    return [
      ...chunks.records.map(([low, high]) => ({
        table: itemTable(ctx),
        text: `${insert} WHERE s.n BETWEEN ${low} AND ${high}`,
      })),
      ...ticketLoad(ctx, chunks, ticketStorage(partitioned)),
    ];
  };

const keys = (
  ctx: ModelContext,
  partitioned: boolean
): readonly (readonly string[])[] => {
  const item = itemTable(ctx);

  const itemKeys = partitioned
    ? [
        `ALTER TABLE ${item} ADD CONSTRAINT ${q("item_pkey")} PRIMARY KEY (id, class_id)`,
      ]
    : idKeys(item, root);

  return [itemKeys, ticketKeys(ctx)];
};

const foreignKeys = (
  ctx: ModelContext,
  partitioned: boolean
): readonly string[] => [
  referenceFk(itemTable(ctx), "item_owner_fk", "owner", userTable),
  ...auditFks(itemTable(ctx), root),
  ...ticketForeignKeys(ctx, ticketStorage(partitioned), itemTable(ctx)),
];

const indexes = (
  ctx: ModelContext,
  partitioned: boolean
): readonly string[] => {
  const item = itemTable(ctx);
  const os = q(hierarchyColumn("computer", "os"));
  const cpu = q(hierarchyColumn("laptop", "cpu_model"));

  const shared = [
    `CREATE INDEX ${q("item_status_updated_at_idx")} ON ${item} (status, updated_at)`,
    `CREATE INDEX ${q("item_owner_idx")} ON ${item} (owner)`,
    `CREATE INDEX ${q("item_updated_at_idx")} ON ${item} (updated_at)`,
  ];

  const perPartition = [
    ...subtree("computer").map(
      (cls) =>
        `CREATE INDEX ${qn("item", cls.name, "os_idx")} ON ${partitionTable(ctx, cls.name)} (${os})`
    ),
    `CREATE INDEX ${q("item_laptop_cpu_model_idx")} ON ${partitionTable(ctx, "laptop")} (${cpu})`,
  ];

  const partial = [
    `CREATE INDEX ${q("item_os_idx")} ON ${item} (${os}) WHERE ${classIn("class_id", ids(subtree("computer")))}`,
    `CREATE INDEX ${q("item_cpu_model_idx")} ON ${item} (${cpu}) WHERE ${classIn("class_id", ids(subtree("laptop")))}`,
  ];

  return [
    ...shared,
    ...(partitioned ? perPartition : partial),
    ...ticketIndexes(ctx),
  ];
};

const relation = (
  ctx: ModelContext,
  endpoint: ClassName,
  alias: string
): Relation => ({
  column: (cls, field) => `${alias}.${q(hierarchyColumn(cls, field))}`,
  endpointFilter: () =>
    endpoint === root
      ? null
      : classIn(`${alias}.class_id`, ids(subtree(endpoint))),
  from: () => `${itemTable(ctx)} ${alias}`,
  system: (column) => `${alias}.${column}`,
});

// The partitioned model names the partition key, known from the lock.
const classKey = (
  partitioned: boolean,
  params: Params,
  state: WriteState
): string =>
  partitioned
    ? ` AND class_id = ${params.bind(stateValue(state, "class_id"), "uuid")}`
    : "";

const insertStep = (
  ctx: ModelContext,
  cls: ClassName,
  values: FieldValues,
  actor: string
): WriteStep => ({
  build: () => {
    const params = makeParams();

    const bound = endpointFields(cls).map(({ cls: name, field }) => ({
      column: q(hierarchyColumn(name, field.name)),
      value: params.bind(
        values.get(`${name}.${field.name}`) ?? null,
        castOf(field)
      ),
    }));

    const classParam = params.bind(classDef(cls).id, "uuid");
    const actorParam = params.bind(actor, "uuid");
    const fieldColumns = bound.map((entry) => entry.column).join(", ");
    const fieldValues = bound.map((entry) => entry.value).join(", ");

    const text =
      `INSERT INTO ${itemTable(ctx)} (${systemColumns.join(", ")}, ${fieldColumns}) ` +
      `VALUES (uuidv7(), ${classParam}, 1, now(), ${actorParam}, now(), ${actorParam}, ${fieldValues}) RETURNING id::text AS id`;

    return { params: params.values(), text };
  },
  expectRow: true,
});

const lockStep = (
  ctx: ModelContext,
  endpoint: ClassName,
  mode: "no key update" | "update"
): WriteStep => ({
  build: (state) => {
    const params = makeParams();
    const id = params.bind(stateValue(state, "id"), "uuid");

    const filter =
      endpoint === root
        ? ""
        : ` AND ${classIn("class_id", ids(subtree(endpoint)))}`;

    const text =
      `SELECT version::text AS version, class_id::text AS class_id FROM ${itemTable(ctx)} ` +
      `WHERE id = ${id}${filter} FOR ${mode.toUpperCase()}`;

    return { params: params.values(), text };
  },
  expectRow: true,
});

interface UpdateTarget {
  readonly partitioned: boolean;
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
    const key = classKey(target.partitioned, params, state);
    const column = q(hierarchyColumn(target.field.cls, target.field.name));

    const text =
      `UPDATE ${itemTable(ctx)} SET ${column} = ${assigned}, version = version + 1, updated_at = now(), ` +
      `updated_by = ${actorParam} WHERE id = ${id} AND version = ${version}${key} RETURNING version::text AS version`;

    return { params: params.values(), text };
  },
  expectRow: true,
});

const deleteStep = (ctx: ModelContext, partitioned: boolean): WriteStep => ({
  build: (state) => {
    const params = makeParams();
    const id = params.bind(stateValue(state, "id"), "uuid");
    const version = params.bind(stateValue(state, "version"), "bigint");
    const key = classKey(partitioned, params, state);
    const text = `DELETE FROM ${itemTable(ctx)} WHERE id = ${id} AND version = ${version}${key} RETURNING id::text AS id`;

    return { params: params.values(), text };
  },
  expectRow: true,
});

const writes = (ctx: ModelContext, partitioned: boolean): WriteModel => ({
  insert: (cls, values, actor) => [insertStep(ctx, cls, values, actor)],
  lock: (endpoint, mode) => [lockStep(ctx, endpoint, mode)],
  remove: () => [deleteStep(ctx, partitioned)],
  update: (_cls, field, value, actor) => [
    updateStep(ctx, { actor, field, partitioned, value }),
  ],
});

const ticketItemJoin =
  (partitioned: boolean): StorageModel["ticketItemJoin"] =>
  (ticketAlias, item) => {
    const byId = `${item.system("id")} = ${ticketAlias}.item`;

    return partitioned
      ? `${byId} AND ${item.system("class_id")} = ${ticketAlias}.item_class`
      : byId;
  };

const tables = (ctx: ModelContext, partitioned: boolean): readonly string[] => [
  ...(partitioned
    ? classes.map((cls) => partitionTable(ctx, cls.name))
    : [itemTable(ctx)]),
  ticketTable(ctx),
];

const makeModel = (partitioned: boolean): StorageModel => ({
  createTables: (ctx) => createTables(ctx, partitioned),
  finish: (ctx) => [
    classChangeTrigger(itemTable(ctx), root),
    ...ticketFinish(ctx),
  ],
  foreignKeys: (ctx) => foreignKeys(ctx, partitioned),
  id: partitioned ? "partitioned" : "single-table",
  indexes: (ctx) => indexes(ctx, partitioned),
  keys: (ctx) => keys(ctx, partitioned),
  loadJobs: loadJobs(partitioned),
  relation,
  tables: (ctx) => tables(ctx, partitioned),
  ticketItemJoin: ticketItemJoin(partitioned),
  title: partitioned
    ? "one table per hierarchy, LIST-partitioned by class"
    : "one table per hierarchy",
  writes: (ctx) => writes(ctx, partitioned),
});

/** One table per hierarchy: the comparison baseline. */
export const singleTableModel: StorageModel = makeModel(false);

/** One table per hierarchy, LIST-partitioned by `class_id`. */
export const partitionedModel: StorageModel = makeModel(true);
