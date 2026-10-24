/**
 * The benchmark hierarchy of Contracts 2.6: four levels, nine classes, the
 * stated own-field counts with mixed field types, and the record distribution.
 * Everything here is storage-model independent; the models in `models/` map it
 * onto tables.
 */

/** Names of the nine classes of the `bench.item` hierarchy. */
export type ClassName =
  | "item"
  | "device"
  | "furniture"
  | "license"
  | "computer"
  | "network"
  | "peripheral"
  | "laptop"
  | "server";

/** STD field types used by the benchmark (Contracts 6.5). */
export type FieldType =
  | "text"
  | "integer"
  | "bigint"
  | "decimal"
  | "boolean"
  | "date"
  | "datetime"
  | "uuid"
  | "reference";

/**
 * How a field's values are generated. Every generator is a pure function of
 * the record number and the field's salt, so the same record gets the same
 * values in every storage model.
 */
export type Generator =
  | { readonly kind: "choice"; readonly values: readonly string[] }
  | { readonly kind: "int"; readonly min: number; readonly max: number }
  | {
      readonly kind: "decimal";
      readonly min: number;
      readonly max: number;
      readonly scale: number;
    }
  | { readonly kind: "bool"; readonly truePercent: number }
  | { readonly kind: "date"; readonly from: string; readonly days: number }
  | { readonly kind: "datetime"; readonly from: string; readonly days: number }
  | { readonly kind: "serial"; readonly prefix: string }
  | { readonly kind: "words" }
  | { readonly kind: "uuid" }
  | { readonly kind: "owner" }
  | { readonly kind: "user" }
  | { readonly kind: "item" };

/** One field a class adds. */
export interface FieldDef {
  readonly name: string;
  readonly type: FieldType;
  /** The Postgres column type. */
  readonly sqlType: string;
  readonly required: boolean;
  /** Percentage of records where an optional field is null. */
  readonly nullPercent: number;
  readonly gen: Generator;
  /** Distinct per field, so generated values are independent. */
  readonly salt: number;
}

/** One class of the hierarchy. */
export interface ClassDef {
  readonly name: ClassName;
  /** The class's stable ID, stored as `class_id`. */
  readonly id: string;
  readonly parent: ClassName | null;
  /** 1 for the root, 4 for the leaves. */
  readonly level: number;
  /** Records created as exactly this class, in twentieths of all records. */
  readonly slots: number;
  readonly fields: readonly FieldDef[];
}

let nextSalt = 101;

const field = (
  name: string,
  type: FieldType,
  sqlType: string,
  gen: Generator,
  nullPercent: number
): FieldDef => {
  nextSalt += 1;

  return {
    gen,
    name,
    nullPercent,
    required: nullPercent === 0,
    salt: nextSalt,
    sqlType,
    type,
  };
};

const textField = (name: string, gen: Generator, nullPercent = 0): FieldDef =>
  field(name, "text", "text", gen, nullPercent);

const intField = (
  name: string,
  range: readonly [number, number],
  nullPercent = 0
): FieldDef =>
  field(
    name,
    "integer",
    "integer",
    { kind: "int", max: range[1], min: range[0] },
    nullPercent
  );

const bigintField = (
  name: string,
  range: readonly [number, number]
): FieldDef =>
  field(
    name,
    "bigint",
    "bigint",
    { kind: "int", max: range[1], min: range[0] },
    0
  );

const decimalField = (
  name: string,
  sqlType: string,
  range: readonly [number, number],
  scale: number,
  nullPercent = 0
): FieldDef =>
  field(
    name,
    "decimal",
    sqlType,
    { kind: "decimal", max: range[1], min: range[0], scale },
    nullPercent
  );

const boolField = (name: string, truePercent: number): FieldDef =>
  field(name, "boolean", "boolean", { kind: "bool", truePercent }, 0);

const dateField = (
  name: string,
  from: string,
  days: number,
  nullPercent = 0
): FieldDef =>
  field(name, "date", "date", { days, from, kind: "date" }, nullPercent);

const datetimeField = (
  name: string,
  from: string,
  days: number,
  nullPercent = 0
): FieldDef =>
  field(
    name,
    "datetime",
    "timestamptz(3)",
    { days, from, kind: "datetime" },
    nullPercent
  );

const uuidField = (name: string, nullPercent: number): FieldDef =>
  field(name, "uuid", "uuid", { kind: "uuid" }, nullPercent);

const referenceField = (
  name: string,
  gen: Generator,
  nullPercent = 0
): FieldDef => field(name, "reference", "uuid", gen, nullPercent);

const codes = (prefix: string, count: number): readonly string[] =>
  Array.from(
    { length: count },
    (_unused, index) => `${prefix}-${String(index + 1).padStart(3, "0")}`
  );

const choice = (values: readonly string[]): Generator => ({
  kind: "choice",
  values,
});

const serial = (prefix: string): Generator => ({ kind: "serial", prefix });

const words: Generator = { kind: "words" };

const since2015 = "2015-01-01";
const since2024 = "2024-01-01";
const sinceOctober2024 = "2024-10-01";
const sinceOctober2025 = "2025-10-01";
const tenYears = 3650;
const twoYears = 700;
const oneYear = 365;

/** Statuses: `in_use` 30%, the other seven 10% each. */
export const statuses: readonly string[] = [
  "in_use",
  "in_use",
  "in_use",
  "spare",
  "shared",
  "retired",
  "repair",
  "ordered",
  "new",
  "lost",
];

/** The seven statuses that each match 10% of records. */
export const tenPercentStatuses: readonly string[] = [
  "spare",
  "shared",
  "retired",
  "repair",
  "ordered",
  "new",
  "lost",
];

/** Locations: 20 values, 5% each. */
export const locations: readonly string[] = codes("LOC", 20);

/** Laptop CPU models: 100 values, 1% of laptops each. */
export const cpuModels: readonly string[] = codes("CPU", 100);

/** Operating systems: 200 values, 0.5% of the computer subtree each. */
export const operatingSystems: readonly string[] = codes("OS", 200);

/** Laptop classifications; `restricted` is 5% of laptops. */
export const classifications: readonly string[] = [
  ...Array.from({ length: 12 }, () => "internal"),
  ...Array.from({ length: 7 }, () => "public"),
  "restricted",
];

const colors = codes("COLOR", 12);

/** The nine classes, root first, parents before children. */
export const classes: readonly ClassDef[] = [
  {
    fields: [
      textField("name", serial("Item ")),
      textField("number", serial("ITM")),
      textField("status", choice(statuses)),
      referenceField("owner", { kind: "owner" }, 1),
      textField("location", choice(locations)),
      intField("priority", [1, 10]),
      decimalField("cost", "numeric(12,2)", [10, 5000], 2, 5),
      dateField("purchased_on", since2015, tenYears, 10),
      boolField("active", 50),
      textField("description", words, 30),
      datetimeField("last_seen_at", sinceOctober2024, twoYears, 20),
      uuidField("external_ref", 50),
    ],
    id: "0e5b0000-0000-7000-8000-000000000001",
    level: 1,
    name: "item",
    parent: null,
    slots: 2,
  },
  {
    fields: [
      textField("serial_number", serial("SN")),
      textField("manufacturer", choice(codes("MFR", 30))),
      textField("model", choice(codes("MODEL", 300))),
      dateField("acquired_on", since2015, tenYears),
      dateField("warranty_until", since2024, 2000, 20),
      intField("rated_watts", [5, 2000]),
      boolField("managed", 70),
      bigintField("asset_tag", [1_000_000_000, 9_000_000_000]),
    ],
    id: "0e5b0000-0000-7000-8000-000000000002",
    level: 2,
    name: "device",
    parent: "item",
    slots: 1,
  },
  {
    fields: [
      textField("material", choice(codes("MAT", 8))),
      textField("color", choice(colors)),
      intField("width_cm", [20, 300]),
      intField("height_cm", [20, 250]),
      intField("depth_cm", [20, 200]),
      decimalField("weight_kg", "numeric(8,2)", [1, 300], 2),
      boolField("assembled", 80),
      textField("room", choice(codes("ROOM", 500)), 10),
    ],
    id: "0e5b0000-0000-7000-8000-000000000003",
    level: 2,
    name: "furniture",
    parent: "item",
    slots: 2,
  },
  {
    fields: [
      textField("product", choice(codes("PRODUCT", 200))),
      textField("vendor", choice(codes("VENDOR", 40))),
      intField("seats", [1, 500]),
      textField("license_key", words),
      dateField("valid_from", since2015, tenYears),
      dateField("valid_until", since2024, 2500, 30),
      decimalField("cost_per_seat", "numeric(10,2)", [1, 900], 2),
      boolField("perpetual", 20),
    ],
    id: "0e5b0000-0000-7000-8000-000000000004",
    level: 2,
    name: "license",
    parent: "item",
    slots: 2,
  },
  {
    fields: [
      textField("hostname", serial("host-")),
      textField("os", choice(operatingSystems)),
      intField("cpu_cores", [2, 64]),
      intField("ram_gb", [4, 512]),
      intField("disk_gb", [128, 8000]),
      textField("bios_version", choice(codes("BIOS", 50))),
      boolField("domain_joined", 85),
      datetimeField("last_patched_at", sinceOctober2025, oneYear, 10),
    ],
    id: "0e5b0000-0000-7000-8000-000000000005",
    level: 3,
    name: "computer",
    parent: "device",
    slots: 1,
  },
  {
    fields: [
      textField("mac_address", words),
      textField("ip_address", serial("10.0.")),
      intField("port_count", [4, 96]),
      intField("vlan", [1, 4094]),
      textField("firmware", choice(codes("FW", 30))),
      bigintField("throughput_bps", [1_000_000_000, 400_000_000_000]),
      boolField("poe", 40),
      textField("rack", choice(codes("RACK", 200)), 15),
    ],
    id: "0e5b0000-0000-7000-8000-000000000006",
    level: 3,
    name: "network",
    parent: "device",
    slots: 2,
  },
  {
    fields: [
      textField("peripheral_type", choice(codes("PTYPE", 10))),
      textField("interface", choice(codes("IF", 5))),
      // Same field name as furniture.color: exercises the field-to-column map of the single-table models.
      textField("color", choice(colors)),
      intField("dpi", [400, 32_000], 50),
      boolField("wireless", 60),
      intField("battery_pct", [0, 100], 40),
      datetimeField("paired_at", sinceOctober2024, twoYears, 30),
      textField("vendor_sku", serial("SKU")),
    ],
    id: "0e5b0000-0000-7000-8000-000000000007",
    level: 3,
    name: "peripheral",
    parent: "device",
    slots: 3,
  },
  {
    fields: [
      decimalField("screen_inches", "numeric(4,1)", [11, 18], 1),
      intField("battery_cycles", [0, 1500]),
      textField("cpu_model", choice(cpuModels)),
      textField("classification", choice(classifications)),
      boolField("encrypted", 90),
      datetimeField("last_docked_at", sinceOctober2025, oneYear, 30),
    ],
    id: "0e5b0000-0000-7000-8000-000000000008",
    level: 4,
    name: "laptop",
    parent: "computer",
    slots: 5,
  },
  {
    fields: [
      intField("rack_unit", [1, 48]),
      textField("cluster", choice(codes("CLUSTER", 100))),
      boolField("virtualized", 70),
      intField("power_supplies", [1, 4]),
      intField("uptime_days", [0, 2000]),
      dateField("commissioned_on", since2015, tenYears),
    ],
    id: "0e5b0000-0000-7000-8000-000000000009",
    level: 4,
    name: "server",
    parent: "computer",
    slots: 2,
  },
];

/** The `bench.ticket` class: a separate root referencing an item. */
export const ticketClass = {
  fields: [
    textField("number", serial("TKT")),
    textField("short_description", words),
    textField(
      "state",
      choice(["new", "open", "pending", "resolved", "closed"])
    ),
    intField("priority", [1, 5]),
    referenceField("item", { kind: "item" }),
    referenceField("opened_by", { kind: "user" }),
    boolField("confidential", 5),
    datetimeField("opened_at", sinceOctober2024, twoYears),
  ],
  id: "0e5b0000-0000-7000-8000-00000000000a",
};

/** The stable ID of `core.user`. */
export const userClassId = "0e5b0000-0000-7000-8000-00000000000b";

/** Number of users referenced from `item.owner` at the 1M and 10M scales. */
export const userCount = 50_000;

/** Tickets per record: `bench.ticket` has 20% as many rows as the hierarchy. */
export const ticketRatio = 0.2;

const byName = new Map(classes.map((cls) => [cls.name, cls]));

/**
 * Looks up a class by name.
 *
 * @param name - The class name.
 * @returns The class.
 */
export const classDef = (name: ClassName): ClassDef => {
  const found = byName.get(name);

  if (found === undefined) {
    throw new Error(`unknown class ${name}`);
  }

  return found;
};

/**
 * Looks up a class by its stored ID.
 * @param id - The class ID.
 * @returns The class.
 */
export const classById = (id: string): ClassDef => {
  const found = classes.find((cls) => cls.id === id);

  if (found === undefined) {
    throw new Error(`unknown class id ${id}`);
  }

  return found;
};

const buildLineage = (name: ClassName): readonly ClassDef[] => {
  const chain: ClassDef[] = [];
  let current: ClassName | null = name;

  while (current !== null) {
    const cls = classDef(current);

    chain.unshift(cls);
    current = cls.parent;
  }

  return chain;
};

const lineages = new Map(
  classes.map((cls) => [cls.name, buildLineage(cls.name)])
);

/**
 * The class and its ancestors.
 *
 * @param name - The class name.
 * @returns The chain, root first.
 */
export const lineage = (name: ClassName): readonly ClassDef[] => {
  const chain = lineages.get(name);

  if (chain === undefined) {
    throw new Error(`unknown class ${name}`);
  }

  return chain;
};

const subtrees = new Map(
  classes.map((parent) => [
    parent.name,
    classes.filter((cls) =>
      lineage(cls.name).some((ancestor) => ancestor.name === parent.name)
    ),
  ])
);

/**
 * `subtree(T)`: the class and all its descendants.
 *
 * @param name - The class name.
 * @returns The classes, in hierarchy order.
 */
export const subtree = (name: ClassName): readonly ClassDef[] =>
  subtrees.get(name) ?? [];

/**
 * True when `ancestor` is `name` or one of its ancestors.
 *
 * @param ancestor - The possible ancestor.
 * @param name - The class.
 * @returns Whether it is.
 */
export const isAncestorOrSelf = (
  ancestor: ClassName,
  name: ClassName
): boolean => lineage(name).some((cls) => cls.name === ancestor);

/**
 * Looks up a field of a class.
 *
 * @param cls - The class name.
 * @param name - The field name.
 * @returns The field.
 */
export const fieldDef = (cls: ClassName, name: string): FieldDef => {
  const found = classDef(cls).fields.find(
    (candidate) => candidate.name === name
  );

  if (found === undefined) {
    throw new Error(`unknown field ${cls}.${name}`);
  }

  return found;
};

/** A field together with the class that adds it. */
export interface EndpointField {
  readonly cls: ClassName;
  readonly field: FieldDef;
}

const fieldsByEndpoint = new Map(
  classes.map((endpoint) => [
    endpoint.name,
    lineage(endpoint.name).flatMap((cls) =>
      cls.fields.map((own) => ({ cls: cls.name, field: own }))
    ),
  ])
);

/**
 * Fields visible at an endpoint: the endpoint's class and its ancestors.
 *
 * @param endpoint - The endpoint's class.
 * @returns The fields, root first.
 */
export const endpointFields = (
  endpoint: ClassName
): readonly EndpointField[] => {
  const fields = fieldsByEndpoint.get(endpoint);

  if (fields === undefined) {
    throw new Error(`unknown class ${endpoint}`);
  }

  return fields;
};

const fieldNames = classes.flatMap((cls) => cls.fields.map((own) => own.name));

const collisions = new Set(
  fieldNames.filter((name, index) => fieldNames.indexOf(name) !== index)
);

/**
 * The field-to-column map of the single-table models: a field keeps its name
 * unless another class of the hierarchy has a field with the same name.
 *
 * @param cls - The class adding the field.
 * @param name - The field name.
 * @returns The column name.
 */
export const hierarchyColumn = (cls: ClassName, name: string): string =>
  collisions.has(name) ? `${cls}_${name}` : name;

/** The twenty class slots that spread records over classes (5% per slot). */
export const classSlots: readonly ClassDef[] = classes.flatMap((cls) =>
  Array.from({ length: cls.slots }, () => cls)
);
