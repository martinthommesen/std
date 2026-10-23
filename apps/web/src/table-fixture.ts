/**
 * Table metadata for the story, scene and unit tests: an asset table with
 * a field of every type the builder handles, a reference to users and one
 * to assets, and the user table, in the shape of the metadata endpoint
 * (Contracts 6.3).
 */
import { apiAttributeNameOf } from "@std/definitions/names";
import type { MetaFieldType } from "@std/definitions/table-metadata";

import type {
  MetaField,
  MetaTable,
  MetaTableSummary,
} from "./domain/metadata.ts";
import { parseSchemaRevision } from "./domain/schema-revision.ts";
import type { SchemaRevision } from "./domain/schema-revision.ts";
import { collectionOf, typeOf } from "./domain/wire.ts";

/** The asset table's name. */
export const ASSET_TABLE_NAME = "acme.asset";

/** The user table's name. */
export const USER_TABLE_NAME = "core.user";

/** The origin the fixtures' `href`s name. */
export const FIXTURE_ORIGIN = "http://std.test";

/**
 * What the API adds to a table's description (Contracts 10.5): its
 * collection as `id`, its definition ID as `classId`, its resource type,
 * its `href` and the revision.
 *
 * @param classId - The table's definition ID.
 * @param name - The qualified name.
 * @returns The members.
 */
export const servedAs = (classId: string, name: string) =>
  ({
    "@type": "TableMetadata",
    classId,
    href: `${FIXTURE_ORIGIN}/api/v2/tableMetadata/${collectionOf(name)}`,
    id: collectionOf(name),
    resourceType: typeOf(name),
    schemaRevision: 3,
  }) as const;

/**
 * A table as the table list shows it.
 *
 * @param name - The qualified name.
 * @param label - Its label.
 * @param creatable - Whether the caller may create its records.
 * @returns The entry.
 */
export const summaryOf = (
  name: string,
  label: string,
  creatable: boolean
): MetaTableSummary => ({
  "@type": "TableMetadata",
  creatable,
  href: `${FIXTURE_ORIGIN}/api/v2/tableMetadata/${collectionOf(name)}`,
  id: collectionOf(name),
  label,
  name,
  resourceType: typeOf(name),
});

const field = (
  id: string,
  name: string,
  label: string,
  type: MetaFieldType,
  overrides: Partial<MetaField> = {}
): MetaField => ({
  apiName: apiAttributeNameOf(overrides.name ?? name),
  autoNumber: null,
  choices: null,
  default: null,
  helpText: null,
  id,
  inheritedFrom: null,
  label,
  name,
  nullable: type.kind !== "boolean",
  read: "yes",
  readOnly: false,
  required: false,
  state: "active",
  type,
  write: { create: "yes", update: "yes" },
  ...overrides,
});

/** Field IDs of the asset table. */
export const ASSET_FIELDS = {
  active: "00000000-0000-4000-8000-00000000a00b",
  checkedAt: "00000000-0000-4000-8000-00000000a00a",
  cost: "00000000-0000-4000-8000-00000000a004",
  dockedTo: "00000000-0000-4000-8000-00000000a006",
  name: "00000000-0000-4000-8000-00000000a001",
  notes: "00000000-0000-4000-8000-00000000a00c",
  number: "00000000-0000-4000-8000-00000000a00f",
  owner: "00000000-0000-4000-8000-00000000a002",
  pin: "00000000-0000-4000-8000-00000000a00e",
  purchasedOn: "00000000-0000-4000-8000-00000000a005",
  serial: "00000000-0000-4000-8000-00000000a008",
  sizeInches: "00000000-0000-4000-8000-00000000a007",
  specs: "00000000-0000-4000-8000-00000000a00d",
  status: "00000000-0000-4000-8000-00000000a003",
  tag: "00000000-0000-4000-8000-00000000a009",
} as const;

/** Field IDs of the user table. */
export const USER_FIELDS = {
  active: "00000000-0000-4000-8000-00000000b003",
  login: "00000000-0000-4000-8000-00000000b002",
  name: "00000000-0000-4000-8000-00000000b001",
} as const;

/** The asset table, as an administrator's metadata shows it. */
export const assetTable: MetaTable = {
  ancestors: [],
  creatable: true,
  displayField: "name",
  fields: [
    field(ASSET_FIELDS.name, "name", "Name", { kind: "text", maxLength: 120 }),
    field(
      ASSET_FIELDS.number,
      "number",
      "Number",
      { kind: "text" },
      {
        autoNumber: { prefix: "AST" },
        readOnly: true,
      }
    ),
    field(ASSET_FIELDS.owner, "owner", "Owner", {
      kind: "reference",
      target: USER_TABLE_NAME,
    }),
    field(
      ASSET_FIELDS.status,
      "status",
      "Status",
      { kind: "choice" },
      {
        choices: [
          { key: "in_use", label: "In use", order: 1, retired: false },
          { key: "lost", label: "Lost", order: 2, retired: false },
          { key: "scrapped", label: "Scrapped", order: 3, retired: true },
        ],
      }
    ),
    field(ASSET_FIELDS.cost, "cost", "Cost", {
      kind: "decimal",
      precision: 12,
      scale: 2,
    }),
    field(ASSET_FIELDS.purchasedOn, "purchased_on", "Purchased on", {
      kind: "date",
    }),
    field(ASSET_FIELDS.dockedTo, "docked_to", "Docked to", {
      kind: "reference",
      target: ASSET_TABLE_NAME,
    }),
    field(ASSET_FIELDS.sizeInches, "size_inches", "Size (inches)", {
      kind: "integer",
    }),
    field(ASSET_FIELDS.serial, "serial_number", "Serial number", {
      kind: "bigInteger",
    }),
    field(ASSET_FIELDS.tag, "tag", "Tag", { kind: "uuid" }),
    field(ASSET_FIELDS.checkedAt, "checked_at", "Checked at", {
      kind: "dateTime",
    }),
    field(ASSET_FIELDS.active, "active", "Active", { kind: "boolean" }),
    field(ASSET_FIELDS.notes, "notes", "Notes", { kind: "longText" }),
    field(ASSET_FIELDS.specs, "specs", "Specs", { kind: "json" }),
    field(ASSET_FIELDS.pin, "pin", "PIN", { kind: "password" }),
  ],
  formRules: [],
  helpText: null,
  ...servedAs("00000000-0000-4000-8000-0000000000a0", ASSET_TABLE_NAME),
  label: "Asset",
  layouts: { form: null, list: null },
  name: ASSET_TABLE_NAME,
  relatedLists: [],
};

/** The user table. */
export const userTable: MetaTable = {
  ancestors: [],
  creatable: false,
  displayField: "name",
  fields: [
    field(USER_FIELDS.name, "name", "Name", { kind: "text" }),
    field(USER_FIELDS.login, "login", "Login", {
      caseSensitive: true,
      kind: "text",
    }),
    field(USER_FIELDS.active, "active", "Active", { kind: "boolean" }),
  ],
  formRules: [],
  helpText: null,
  ...servedAs("00000000-0000-4000-8000-0000000000b0", USER_TABLE_NAME),
  label: "User",
  layouts: { form: null, list: null },
  name: USER_TABLE_NAME,
  relatedLists: [],
};

/** Both tables, by name. */
export const fixtureTables: ReadonlyMap<string, MetaTable> = new Map([
  [assetTable.name, assetTable],
  [userTable.name, userTable],
]);

/**
 * A revision as the header carries it.
 *
 * @param text - Such as `3.019a...`.
 * @returns The revision.
 */
export const revision = (text: string): SchemaRevision => {
  const parsed = parseSchemaRevision(text);

  if (parsed._tag === "None") {
    throw new RangeError(`not a revision: ${text}`);
  }

  return parsed.value;
};

/** Revision 3. */
export const REVISION_3 = revision("3.00000000-0000-4000-8000-000000000c03");

/** Revision 4. */
export const REVISION_4 = revision("4.00000000-0000-4000-8000-000000000c04");

/** The tables Ada can open. */
export const adaTables = {
  schemaRevision: 3,
  tables: [
    summaryOf(ASSET_TABLE_NAME, "Asset", true),
    summaryOf(USER_TABLE_NAME, "User", false),
  ],
} as const;
