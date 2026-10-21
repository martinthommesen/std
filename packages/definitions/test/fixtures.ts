import type { FieldType } from "@std/values/field-type";

/**
 * Small builders for definition tests.
 */
import type {
  ClassDefinition,
  Definition,
  FieldDefinition,
  NamespaceDefinition,
  OverrideDefinition,
} from "../src/definition.ts";
import type { SetFile } from "../src/set-file.ts";
import { ConfigSnapshot } from "../src/snapshot.ts";

let counter = 0;

const TEXT: FieldType = { kind: "text" };

const ASSET_TABLE = "acme.asset";

/**
 * A deterministic fresh ID.
 * @returns A lowercase UUID.
 */
export const freshId = (): string => {
  counter += 1;

  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
};

/** The key of test snapshots. */
export const KEY = {
  changeSetId: "00000000-0000-4000-8000-ffffffffffff",
  revision: 1,
};

/**
 * @param name - The namespace name.
 * @returns A namespace definition.
 */
export const namespace = (name: string): NamespaceDefinition => ({
  extensible: false,
  helpText: null,
  id: freshId(),
  kind: "namespace",
  label: name,
  name,
  owner: { layer: "local" },
  protected: false,
  state: "active",
  storage: "standard",
  version: 1,
});

/**
 * @param ns - Its namespace.
 * @param name - The table name.
 * @param parent - The parent class, if any.
 * @returns A class definition.
 */
export const table = (
  ns: NamespaceDefinition,
  name: string,
  parent?: ClassDefinition
): ClassDefinition => ({
  displayFieldId: null,
  enforcement: "enforced",
  enforcementNote: null,
  extensible: false,
  helpText: null,
  id: freshId(),
  kind: "class",
  label: name,
  name,
  namespaceId: ns.id,
  owner: { layer: "local" },
  parentId: parent?.id ?? null,
  protected: false,
  state: "active",
  storage: "standard",
  version: 1,
});

/**
 * @param owner - Its class.
 * @param name - The field name.
 * @param type - Its type.
 * @param extra - Other properties.
 * @returns A field definition.
 */
export const field = (
  owner: ClassDefinition,
  name: string,
  type?: FieldType,
  extra: Partial<FieldDefinition> = {}
): FieldDefinition => ({
  classId: owner.id,
  default: null,
  enforcement: "enforced",
  enforcementNote: null,
  helpText: null,
  id: freshId(),
  kind: "field",
  label: name,
  name,
  owner: { layer: "local" },
  protected: false,
  readOnly: false,
  required: false,
  state: "active",
  type: type ?? TEXT,
  version: 1,
  ...extra,
});

/**
 * @param owner - The child class.
 * @param target - The inherited field.
 * @param extra - Overridden properties.
 * @returns An override definition.
 */
export const override = (
  owner: ClassDefinition,
  target: FieldDefinition,
  extra: Partial<OverrideDefinition>
): OverrideDefinition => ({
  classId: owner.id,
  default: null,
  enforcement: "enforced",
  enforcementNote: null,
  fieldId: target.id,
  helpText: null,
  id: freshId(),
  kind: "override",
  label: null,
  max: null,
  maxLength: null,
  min: null,
  owner: { layer: "local" },
  protected: false,
  readOnly: null,
  required: null,
  state: "active",
  version: 1,
  ...extra,
});

/**
 * @param definitions - The definitions.
 * @returns A snapshot at revision 1.
 */
export const snapshotOf = (
  definitions: readonly Definition[]
): ConfigSnapshot => ConfigSnapshot.make(KEY, definitions);

/** IDs of the acme-like test set. */
export const ACME = {
  asset: "10000000-0000-4000-8000-000000000002",
  assetName: "10000000-0000-4000-8000-000000000003",
  assetOwner: "10000000-0000-4000-8000-000000000006",
  dockedTo: "10000000-0000-4000-8000-000000000007",
  laptop: "10000000-0000-4000-8000-000000000004",
  laptopSerial: "10000000-0000-4000-8000-000000000005",
  monitor: "10000000-0000-4000-8000-000000000008",
  monitorSize: "10000000-0000-4000-8000-000000000009",
  namespace: "10000000-0000-4000-8000-000000000001",
  overridePurchased: "10000000-0000-4000-8000-00000000000b",
  purchasedOn: "10000000-0000-4000-8000-00000000000a",
  role: "10000000-0000-4000-8000-00000000000c",
  rule: "10000000-0000-4000-8000-00000000000d",
  serialIndex: "10000000-0000-4000-8000-00000000000e",
  set: "10000000-0000-4000-8000-0000000000ff",
} as const;

/**
 * Files of a small set: the child is listed before its parent, and the
 * asset's `docked_to` and the laptop's `serial` index exercise phases.
 * @returns The files, in a fixed order.
 */
export const acmeFiles = (): readonly { path: string; content: SetFile }[] => [
  {
    content: {
      tables: [
        {
          extends: ASSET_TABLE,
          fields: [
            {
              id: ACME.laptopSerial,
              name: "serial",
              required: true,
              type: "text",
            },
          ],
          id: ACME.laptop,
          indexes: [{ fields: ["serial"], id: ACME.serialIndex, unique: true }],
          name: "acme.laptop",
          overrides: [
            {
              field: "purchased_on",
              id: ACME.overridePurchased,
              required: true,
            },
          ],
        },
        {
          extends: ASSET_TABLE,
          fields: [
            { id: ACME.monitorSize, name: "size_inches", type: "integer" },
          ],
          id: ACME.monitor,
          name: "acme.monitor",
        },
      ],
    },
    path: "children.yaml",
  },
  {
    content: {
      namespaces: [{ id: ACME.namespace, name: "acme" }],
      set: { id: ACME.set, layer: "app", name: "acme", version: 1 },
      tables: [
        {
          displayField: "name",
          fields: [
            { id: ACME.assetName, name: "name", required: true, type: "text" },
            {
              id: ACME.dockedTo,
              name: "docked_to",
              type: { kind: "reference", target: ASSET_TABLE },
            },
            { id: ACME.purchasedOn, name: "purchased_on", type: "date" },
          ],
          id: ACME.asset,
          name: ASSET_TABLE,
        },
      ],
    },
    path: "asset.yaml",
  },
  {
    content: {
      accessRules: [
        {
          actions: ["read"],
          condition: { arg: { path: [ACME.purchasedOn] }, op: "empty" },
          effect: "allow",
          fields: ["serial", "name"],
          id: ACME.rule,
          roles: ["asset_manager"],
          table: "acme.laptop",
          target: "fields",
        },
      ],
      roles: [{ id: ACME.role, name: "asset_manager" }],
    },
    path: "access.yaml",
  },
];
