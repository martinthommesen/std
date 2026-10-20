/**
 * DDL and load SQL shared by every storage model: `core.user`, the staging
 * tables in `bench_aux`, and `bench.ticket` (a separate root class, stored the
 * same way in every model apart from its item reference).
 *
 * The staging tables hold each record's UUIDv7 ID (from `uuidv7()`), class,
 * version, audit fields and owner, so every model loaded into the same
 * database gets identical records. They are not part of any model and are
 * excluded from the reported sizes.
 */
import type { ClassDef, FieldDef } from "../hierarchy.ts";
import { classSlots, ticketClass, userClassId } from "../hierarchy.ts";
import { q, qn, table, uuidLiteral } from "../sql-text.ts";
import type {
  LoadChunks,
  LoadJob,
  ModelContext,
  WriteState,
} from "../storage-model.ts";
import { hashMod, sqlValue } from "../values.ts";

/** Schema of the staging tables. */
export const auxSchema = "bench_aux";

/** The user table, as Contracts 2.1 names it. */
export const userTable = `${q("core")}.${q("user")}`;

const userMap = `${auxSchema}.user_map`;
const millisecondsPerDay = 86_400_000;
const createdSpanDays = 1095;
const updatedSpanDays = 300;
const versionSpread = 5;
const percent = 100;
const ownerNullSalt = 7919;
const recordEpoch = "timestamptz '2023-01-01 00:00:00+00'";
const ticketEpoch = "timestamptz '2024-01-01 00:00:00+00'";

/** Salts used by the staging tables (fields use salts above 100). */
const salt = {
  classSlot: 11,
  createdAt: 17,
  createdBy: 14,
  opener: 23,
  ticketCreatedAt: 24,
  ticketCreatedBy: 25,
  ticketItem: 21,
  ticketUpdatedAt: 26,
  ticketUpdatedBy: 27,
  ticketVersion: 28,
  updatedAt: 18,
  updatedBy: 15,
  version: 16,
} as const;

/** Column definitions of the root system fields (Contracts 2.1). */
export const rootSystemDdl: readonly string[] = [
  "id uuid NOT NULL",
  "class_id uuid NOT NULL",
  "version bigint NOT NULL",
  "created_at timestamptz(3) NOT NULL",
  "created_by uuid NOT NULL",
  "updated_at timestamptz(3) NOT NULL",
  "updated_by uuid NOT NULL",
];

/**
 * A value produced by an earlier write step.
 *
 * @param state - The write state.
 * @param key - `id`, `version` or `class_id`.
 * @returns The value.
 */
export const stateValue = (state: WriteState, key: string): string => {
  const value = state.get(key);

  if (value === undefined) {
    throw new Error(`write state has no ${key}`);
  }

  return value;
};

/**
 * Column definition for a field.
 *
 * @param def - The field.
 * @param column - The column name.
 * @param nullable - Drop NOT NULL (fields of child classes in the single-table models).
 * @returns The column definition.
 */
export const fieldDdl = (
  def: FieldDef,
  column: string,
  nullable: boolean
): string => {
  const notNull = def.required && !nullable ? " NOT NULL" : "";

  return `${q(column)} ${def.sqlType}${notNull}`;
};

/**
 * The load expression for a field over a staging row.
 *
 * @param def - The field.
 * @param stage - The staging row's alias.
 * @returns The SQL expression.
 */
export const loadValue = (def: FieldDef, stage: string): string =>
  def.gen.kind === "owner" ? `${stage}.owner` : sqlValue(def, `${stage}.n`);

/**
 * `CHECK (class_id IN (...))` over a list of classes.
 *
 * @param name - The constraint name.
 * @param members - The classes of the subtree.
 * @returns The table constraint.
 */
export const subtreeCheck = (
  name: string,
  members: readonly { readonly id: string }[]
): string => {
  const list = members.map((member) => uuidLiteral(member.id)).join(", ");

  return `CONSTRAINT ${q(name)} CHECK (class_id IN (${list}))`;
};

/**
 * The class-change trigger of Contracts 2.1 on one table.
 *
 * @param qualified - The table.
 * @param name - The class name, for the trigger name.
 * @returns The CREATE TRIGGER statement.
 */
export const classChangeTrigger = (qualified: string, name: string): string =>
  `CREATE TRIGGER ${qn(name, "class_fixed")} BEFORE UPDATE ON ${qualified} FOR EACH ROW ` +
  "WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id) EXECUTE FUNCTION core.refuse_class_change()";

/**
 * A reference foreign key (`ON DELETE NO ACTION`, Contracts 3.10).
 *
 * @param qualified - The referencing table.
 * @param name - The constraint name.
 * @param column - The reference column.
 * @param target - The referenced table.
 * @returns The ALTER TABLE statement.
 */
export const referenceFk = (
  qualified: string,
  name: string,
  column: string,
  target: string
): string =>
  `ALTER TABLE ${qualified} ADD CONSTRAINT ${q(name)} FOREIGN KEY (${q(column)}) REFERENCES ${target} (id) ON DELETE NO ACTION`;

/**
 * The audit foreign keys of a root table.
 *
 * @param qualified - The table.
 * @param name - The class name, for constraint names.
 * @returns Two ALTER TABLE statements.
 */
export const auditFks = (
  qualified: string,
  name: string
): readonly string[] => [
  referenceFk(qualified, `${name}_created_by_fk`, "created_by", userTable),
  referenceFk(qualified, `${name}_updated_by_fk`, "updated_by", userTable),
];

/**
 * `PRIMARY KEY (id)` and `UNIQUE (id, class_id)` for one table.
 *
 * @param qualified - The table.
 * @param name - The class name, for constraint names.
 * @returns Two ALTER TABLE statements.
 */
export const idKeys = (qualified: string, name: string): readonly string[] => [
  `ALTER TABLE ${qualified} ADD CONSTRAINT ${qn(name, "pkey")} PRIMARY KEY (id)`,
  `ALTER TABLE ${qualified} ADD CONSTRAINT ${qn(name, "id_class")} UNIQUE (id, class_id)`,
];

const msInterval = (expression: string): string =>
  `${expression} * interval '1 millisecond'`;

const userJoin = (alias: string, saltValue: number, users: number): string =>
  `JOIN ${userMap} ${alias} ON ${alias}.k = 1 + ${hashMod("g.n", saltValue, users)}`;

const series = ([low, high]: readonly [number, number]): string =>
  `generate_series(${low}::bigint, ${high}::bigint) AS g(n)`;

const epochPlus = (epoch: string, saltValue: number): string => {
  const offset = msInterval(
    hashMod("g.n", saltValue, createdSpanDays * millisecondsPerDay)
  );

  return `CROSS JOIN LATERAL (SELECT ${epoch} + ${offset} AS at) c`;
};

const userDdl = (): string => {
  const columns = [
    ...rootSystemDdl,
    "name text NOT NULL",
    "login text NOT NULL",
    "active boolean NOT NULL",
    `CONSTRAINT ${q("user_class_subtree")} CHECK (class_id = ${uuidLiteral(userClassId)})`,
  ];

  return `CREATE TABLE ${userTable} (${columns.join(", ")})`;
};

const userLoad = (): string =>
  `INSERT INTO ${userTable} (id, class_id, version, created_at, created_by, updated_at, updated_by, name, login, active) ` +
  `SELECT um.id, ${uuidLiteral(userClassId)}, 1, ${recordEpoch}, first.id, ${recordEpoch}, first.id, ` +
  `'User ' || um.k, 'user' || um.k, true FROM ${userMap} um CROSS JOIN (SELECT id FROM ${userMap} WHERE k = 1) first`;

/**
 * Statements that create `core`, `bench_aux`, the users and the function the
 * class-change triggers call.
 *
 * @param users - How many users to create.
 * @returns The statements, in order.
 */
export const baseSetup = (users: number): readonly string[] => [
  "CREATE SCHEMA core",
  `CREATE SCHEMA ${auxSchema}`,
  "CREATE FUNCTION core.refuse_class_change() RETURNS trigger LANGUAGE plpgsql AS $$ " +
    "BEGIN RAISE EXCEPTION 'the class of a record cannot change' USING ERRCODE = '23514'; END $$",
  `CREATE UNLOGGED TABLE ${userMap} (k integer PRIMARY KEY, id uuid NOT NULL)`,
  `INSERT INTO ${userMap} (k, id) SELECT k, uuidv7() FROM generate_series(1, ${users}) AS k`,
  userDdl(),
  userLoad(),
  ...idKeys(userTable, "user"),
  `ALTER TABLE ${userTable} ADD CONSTRAINT ${q("user_login_key")} UNIQUE (login)`,
  ...auditFks(userTable, "user"),
  classChangeTrigger(userTable, "user"),
  `CREATE UNLOGGED TABLE ${auxSchema}.stage (n bigint NOT NULL, id uuid NOT NULL, class_id uuid NOT NULL, ` +
    "version bigint NOT NULL, created_at timestamptz(3) NOT NULL, created_by uuid NOT NULL, " +
    "updated_at timestamptz(3) NOT NULL, updated_by uuid NOT NULL, owner uuid)",
  `CREATE UNLOGGED TABLE ${auxSchema}.ticket_stage (n bigint NOT NULL, id uuid NOT NULL, ` +
    "version bigint NOT NULL, created_at timestamptz(3) NOT NULL, created_by uuid NOT NULL, " +
    "updated_at timestamptz(3) NOT NULL, updated_by uuid NOT NULL, item uuid NOT NULL, " +
    "item_class uuid NOT NULL, opened_by uuid NOT NULL)",
];

const stageStatement = (
  ctx: ModelContext,
  chunk: readonly [number, number],
  owner: FieldDef
): string => {
  const slotList = classSlots.map((cls) => uuidLiteral(cls.id)).join(",");
  const slotIds = `ARRAY[${slotList}]`;
  const classId = `(${slotIds})[1 + ${hashMod("g.n", salt.classSlot, classSlots.length)}]`;
  const updatedAt = `c.at + ${msInterval(hashMod("g.n", salt.updatedAt, updatedSpanDays * millisecondsPerDay))}`;
  const ownerId = `CASE WHEN ${hashMod("g.n", owner.salt + ownerNullSalt, percent)} < ${owner.nullPercent} THEN NULL ELSE ow.id END`;
  const version = `1 + ${hashMod("g.n", salt.version, versionSpread)}`;

  return (
    `INSERT INTO ${auxSchema}.stage (n, id, class_id, version, created_at, created_by, updated_at, updated_by, owner) ` +
    `SELECT g.n, uuidv7(), ${classId}, ${version}, c.at, cb.id, ${updatedAt}, ub.id, ${ownerId} ` +
    `FROM ${series(chunk)} ${epochPlus(recordEpoch, salt.createdAt)} ${userJoin("cb", salt.createdBy, ctx.users)} ${userJoin("ub", salt.updatedBy, ctx.users)} ${userJoin("ow", owner.salt, ctx.users)}`
  );
};

/**
 * Fills the record staging table, one statement per chunk.
 *
 * @param ctx - Sizes.
 * @param chunks - Record-number ranges.
 * @param owner - The `item.owner` field (its salt and null share).
 * @returns The load statements.
 */
export const stageJobs = (
  ctx: ModelContext,
  chunks: LoadChunks,
  owner: FieldDef
): readonly LoadJob[] =>
  chunks.records.map((chunk) => ({
    table: `${auxSchema}.stage`,
    text: stageStatement(ctx, chunk, owner),
  }));

const ticketStageStatement = (
  ctx: ModelContext,
  chunk: readonly [number, number]
): string => {
  const updatedAt = `c.at + ${msInterval(hashMod("g.n", salt.ticketUpdatedAt, updatedSpanDays * millisecondsPerDay))}`;
  const version = `1 + ${hashMod("g.n", salt.ticketVersion, versionSpread)}`;

  return (
    `INSERT INTO ${auxSchema}.ticket_stage (n, id, version, created_at, created_by, updated_at, updated_by, item, item_class, opened_by) ` +
    `SELECT g.n, uuidv7(), ${version}, c.at, cb.id, ${updatedAt}, ub.id, si.id, si.class_id, op.id ` +
    `FROM ${series(chunk)} ${epochPlus(ticketEpoch, salt.ticketCreatedAt)} ` +
    `JOIN ${auxSchema}.stage si ON si.n = 1 + ${hashMod("g.n", salt.ticketItem, ctx.records)} ${userJoin("cb", salt.ticketCreatedBy, ctx.users)} ${userJoin("ub", salt.ticketUpdatedBy, ctx.users)} ${userJoin("op", salt.opener, ctx.users)}`
  );
};

/**
 * Fills the ticket staging table, one statement per chunk.
 *
 * @param ctx - Sizes.
 * @param chunks - Ticket-number ranges.
 * @returns The load statements.
 */
export const ticketStageJobs = (
  ctx: ModelContext,
  chunks: LoadChunks
): readonly LoadJob[] =>
  chunks.tickets.map((chunk) => ({
    table: `${auxSchema}.ticket_stage`,
    text: ticketStageStatement(ctx, chunk),
  }));

/** Keys of the staging tables, added after their load. */
export const stageKeys: readonly string[] = [
  `ALTER TABLE ${auxSchema}.stage ADD PRIMARY KEY (n)`,
  `CREATE INDEX ON ${auxSchema}.stage (class_id)`,
];

/** Keys of the ticket staging table. */
export const ticketStageKeys: readonly string[] = [
  `ALTER TABLE ${auxSchema}.ticket_stage ADD PRIMARY KEY (n)`,
];

/** How a model stores the ticket's item reference. */
export type TicketItemStorage = "fk" | "fk-with-class" | "no-fk";

/**
 * The qualified ticket table of a model.
 *
 * @param ctx - The model's schema.
 * @returns The table name.
 */
export const ticketTable = (ctx: ModelContext): string =>
  table(ctx.schema, "ticket");

/**
 * Looks up a ticket field definition.
 *
 * @param name - The field name.
 * @returns The field.
 */
export const ticketFieldDef = (name: string): FieldDef => {
  const found = ticketClass.fields.find((candidate) => candidate.name === name);

  if (found === undefined) {
    throw new Error(`unknown ticket field ${name}`);
  }

  return found;
};

/**
 * The ticket table.
 *
 * @param ctx - The model's schema.
 * @param storage - How the item reference is stored.
 * @returns The CREATE TABLE statement.
 */
export const ticketCreate = (
  ctx: ModelContext,
  storage: TicketItemStorage
): string => {
  const columns = [
    ...rootSystemDdl,
    ...ticketClass.fields.map((def) => fieldDdl(def, def.name, false)),
    ...(storage === "fk-with-class" ? ["item_class uuid NOT NULL"] : []),
    `CONSTRAINT ${q("ticket_class_subtree")} CHECK (class_id = ${uuidLiteral(ticketClass.id)})`,
  ];

  return `CREATE TABLE ${ticketTable(ctx)} (${columns.join(", ")})`;
};

const ticketValue = (def: FieldDef): string => {
  if (def.gen.kind === "item") {
    return "ts.item";
  }

  return def.gen.kind === "user" ? "ts.opened_by" : sqlValue(def, "ts.n");
};

/**
 * Loads tickets from the ticket staging table.
 *
 * @param ctx - The model's schema.
 * @param chunks - Ticket-number ranges.
 * @param storage - How the item reference is stored.
 * @returns The load statements.
 */
export const ticketLoad = (
  ctx: ModelContext,
  chunks: LoadChunks,
  storage: TicketItemStorage
): readonly LoadJob[] => {
  const withClass = storage === "fk-with-class";

  const system = [
    "id",
    "class_id",
    "version",
    "created_at",
    "created_by",
    "updated_at",
    "updated_by",
  ];

  const columns = [
    ...system,
    ...ticketClass.fields.map((def) => q(def.name)),
    ...(withClass ? ["item_class"] : []),
  ];

  const values = [
    ...system.map((column) =>
      column === "class_id" ? uuidLiteral(ticketClass.id) : `ts.${column}`
    ),
    ...ticketClass.fields.map((def) => ticketValue(def)),
    ...(withClass ? ["ts.item_class"] : []),
  ];

  return chunks.tickets.map(([low, high]) => ({
    table: ticketTable(ctx),
    text:
      `INSERT INTO ${ticketTable(ctx)} (${columns.join(", ")}) SELECT ${values.join(", ")} ` +
      `FROM ${auxSchema}.ticket_stage ts WHERE ts.n BETWEEN ${low} AND ${high}`,
  }));
};

/**
 * Ticket keys.
 *
 * @param ctx - The model's schema.
 * @returns The ALTER TABLE statements.
 */
export const ticketKeys = (ctx: ModelContext): readonly string[] =>
  idKeys(ticketTable(ctx), "ticket");

const ticketItemFk = (
  qualified: string,
  storage: TicketItemStorage,
  itemTable: string
): readonly string[] => {
  if (storage === "no-fk") {
    return [];
  }

  if (storage === "fk") {
    return [referenceFk(qualified, "ticket_item_fk", "item", itemTable)];
  }

  return [
    `ALTER TABLE ${qualified} ADD CONSTRAINT ${q("ticket_item_fk")} FOREIGN KEY (item, item_class) ` +
      `REFERENCES ${itemTable} (id, class_id) ON DELETE NO ACTION`,
  ];
};

/**
 * Ticket foreign keys.
 *
 * @param ctx - The model's schema.
 * @param storage - How the item reference is stored.
 * @param itemTable - The item table the reference points at.
 * @returns The ALTER TABLE statements.
 */
export const ticketForeignKeys = (
  ctx: ModelContext,
  storage: TicketItemStorage,
  itemTable: string
): readonly string[] => {
  const qualified = ticketTable(ctx);

  return [
    ...auditFks(qualified, "ticket"),
    referenceFk(qualified, "ticket_opened_by_fk", "opened_by", userTable),
    ...ticketItemFk(qualified, storage, itemTable),
  ];
};

/**
 * Ticket indexes: `ticket(item)` from Contracts 2.6 and `ticket(updated_at)`
 * for the default list sort (the same in every model).
 *
 * @param ctx - The model's schema.
 * @returns The CREATE INDEX statements.
 */
export const ticketIndexes = (ctx: ModelContext): readonly string[] => [
  `CREATE INDEX ${q("ticket_item_idx")} ON ${ticketTable(ctx)} (item)`,
  `CREATE INDEX ${q("ticket_updated_at_idx")} ON ${ticketTable(ctx)} (updated_at)`,
];

/**
 * The ticket class-change trigger.
 *
 * @param ctx - The model's schema.
 * @returns The CREATE TRIGGER statement.
 */
export const ticketFinish = (ctx: ModelContext): readonly string[] => [
  classChangeTrigger(ticketTable(ctx), "ticket"),
];

/**
 * The `item.owner` field, which the staging table resolves.
 *
 * @param root - The root class.
 * @returns The owner field.
 */
export const ownerFieldOf = (root: ClassDef): FieldDef => {
  const owner = root.fields.find((def) => def.gen.kind === "owner");

  if (owner === undefined) {
    throw new Error("the root class needs an owner field");
  }

  return owner;
};
