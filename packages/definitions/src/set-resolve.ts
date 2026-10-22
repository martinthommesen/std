/**
 * Resolving a definition set's files into drafts (Contracts 8.1, 8.3 steps
 * 1 and 2): decode every file, check IDs, and resolve every name to an ID
 * within the set and the sets it requires. Any problem refuses the whole
 * set; nothing is applied.
 */
import type { FieldType } from "@std/values/field-type";
import type { JsonValue } from "@std/values/json-value";
import { fail, isFailure, succeed } from "effect/Result";
import type { Result } from "effect/Result";
import { decodeUnknownResult } from "effect/Schema";

import type {
  AccessRuleDraft,
  AccessTarget,
  ChoiceDraft,
  ClassDraft,
  Definition,
  FieldDraft,
  GrantDraft,
  IndexDraft,
  LayoutDraft,
  LayoutElement,
  NamespaceDraft,
  OverrideDraft,
  Owner,
  PermissionDraft,
  RoleDraft,
  SubscriptionDraft,
} from "./definition.ts";
import type { DefinitionId } from "./ids.ts";
import { splitQualifiedName } from "./names.ts";
import { DefinitionInvalid, problem } from "./problems.ts";
import type { DefinitionProblem } from "./problems.ts";
import { SetFileSchema } from "./set-file.ts";
import type {
  ConditionEntrySchema,
  ReferenceEntrySchema,
  SimpleKindSchema,
  AccessRuleEntry,
  FieldEntry,
  NamedSetFile,
  OverrideEntry,
  SetFile,
  SetHeader,
  SubscriptionEntry,
  TableEntry,
  TypeEntry,
} from "./set-file.ts";
import type { ConfigSnapshot } from "./snapshot.ts";

/** Any draft. */
export type Draft =
  | NamespaceDraft
  | ClassDraft
  | FieldDraft
  | OverrideDraft
  | IndexDraft
  | RoleDraft
  | PermissionDraft
  | GrantDraft
  | AccessRuleDraft
  | SubscriptionDraft
  | ChoiceDraft
  | LayoutDraft;

/** A set with every name resolved. */
export interface ResolvedSet {
  readonly header: SetHeader;
  readonly owner: Owner;
  readonly drafts: readonly Draft[];
}

const decodeFile = decodeUnknownResult(SetFileSchema, {
  onExcessProperty: "error",
});

/**
 * Decodes one parsed file of a set; unknown keys are refused, so a typo
 * cannot be ignored silently.
 *
 * @param path - The file's path, for messages.
 * @param content - The parsed YAML document, as JSON.
 * @returns The file, or a problem naming the path.
 */
export const decodeSetFile = (
  path: string,
  content: JsonValue
): Result<NamedSetFile, DefinitionInvalid> => {
  const decoded = decodeFile(content ?? {});

  if (isFailure(decoded)) {
    return fail(
      new DefinitionInvalid({
        problems: [
          problem(
            "invalidName",
            null,
            `${path} is not a valid set file: ${decoded.failure.message}`
          ),
        ],
      })
    );
  }

  return succeed({ content: decoded.success, path });
};

const WORD_SEPARATOR = /[_.]+/gu;

/**
 * The default label for a name: `purchased_on` becomes `Purchased on`.
 *
 * @param name - A name.
 * @returns A sentence-case label.
 */
export const labelFor = (name: string): string => {
  const words = name.replaceAll(WORD_SEPARATOR, " ").trim();

  return words.length === 0
    ? name
    : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

const ownerOf = (header: SetHeader): Owner =>
  header.layer === "core"
    ? { layer: "core" }
    : { layer: "app", setId: header.id };

const sameOwner = (left: Owner, right: Owner): boolean => {
  if (left.layer === "app" && right.layer === "app") {
    return left.setId === right.setId;
  }

  return left.layer === right.layer;
};

/** State of one resolution. */
interface Resolution {
  readonly header: SetHeader;
  readonly owner: Owner;
  readonly visible: readonly Owner[];
  readonly base: ConfigSnapshot;
  readonly problems: DefinitionProblem[];
  readonly drafts: Draft[];
  readonly namespaces: ReadonlyMap<string, DefinitionId>;
  readonly tables: ReadonlyMap<string, TableEntry>;
  readonly roles: ReadonlyMap<string, DefinitionId>;
  readonly permissions: ReadonlyMap<string, DefinitionId>;
}

const visibleBase = (
  resolution: Resolution,
  definition: Definition | undefined
): Definition | undefined =>
  definition !== undefined &&
  resolution.visible.some((owner) => sameOwner(owner, definition.owner))
    ? definition
    : undefined;

const reportUnknown = (
  resolution: Resolution,
  from: DefinitionId,
  what: string,
  name: string
): void => {
  resolution.problems.push(
    problem("unknownReference", from, `The ${what} "${name}" is not defined.`)
  );
};

/**
 * Looks a name up in the set, then among visible installed definitions.
 *
 * @param resolution - The resolution.
 * @param from - The definition that refers to the name.
 * @param what - What kind of name it is, for the message.
 * @param name - The name.
 * @param local - The ID the set defines for the name, if any.
 * @param installed - The installed definition of that name, if any.
 * @returns The ID, or undefined after recording a problem.
 */
const lookup = (
  resolution: Resolution,
  from: DefinitionId,
  what: string,
  name: string,
  local: DefinitionId | undefined,
  installed: Definition | undefined
): DefinitionId | undefined => {
  const found = local ?? visibleBase(resolution, installed)?.id;

  if (found === undefined) {
    reportUnknown(resolution, from, what, name);
  }

  return found;
};

const tableId = (
  resolution: Resolution,
  from: DefinitionId,
  name: string
): DefinitionId | undefined =>
  lookup(
    resolution,
    from,
    "table",
    name,
    resolution.tables.get(name)?.id,
    resolution.base.classByName(name)
  );

/** One level of a lineage: a set entry, or an installed class by ID. */
type Level =
  | { readonly entry: TableEntry }
  | { readonly installed: DefinitionId };

/**
 * The levels of a table's lineage, root first. Stops at a cycle, which the
 * planner reports.
 *
 * @param resolution - The resolution.
 * @param entry - The table.
 * @returns The levels.
 */
const lineageOf = (
  resolution: Resolution,
  entry: TableEntry
): readonly Level[] => {
  const chain: Level[] = [{ entry }];
  const seen = new Set<string>([entry.name]);
  let parent = entry.extends ?? null;

  while (parent !== null && !seen.has(parent)) {
    seen.add(parent);
    const local = resolution.tables.get(parent);

    if (local === undefined) {
      const installed = resolution.base.classByName(parent);

      chain.push(
        ...(installed === undefined
          ? []
          : resolution.base.lineage(installed.id)
        )
          .map((definition) => ({ installed: definition.id }))
          .toReversed()
      );
      parent = null;
    } else {
      chain.push({ entry: local });
      parent = local.extends ?? null;
    }
  }

  return chain.toReversed();
};

const fieldOnLevel = (
  resolution: Resolution,
  level: Level,
  name: string
): DefinitionId | undefined =>
  "entry" in level
    ? level.entry.fields?.find((field) => field.name === name)?.id
    : resolution.base.ownFields(level.installed).find((f) => f.name === name)
        ?.id;

/**
 * Finds a field by name on a table's lineage.
 *
 * @param resolution - The resolution.
 * @param entry - The table.
 * @param name - The field name.
 * @param inheritedOnly - Skip the table's own fields (for overrides).
 * @returns The field ID, or undefined.
 */
const fieldIdOnLineage = (
  resolution: Resolution,
  entry: TableEntry,
  name: string,
  inheritedOnly: boolean
): DefinitionId | undefined => {
  const lineage = lineageOf(resolution, entry);
  const levels = inheritedOnly ? lineage.slice(0, -1) : lineage;

  for (const level of levels) {
    const found = fieldOnLevel(resolution, level, name);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
};

/** The flags every draft shares. */
interface DraftFlags {
  readonly id: DefinitionId;
  readonly owner: Owner;
  readonly protected: boolean;
}

const flagsOf = (
  resolution: Resolution,
  entry: { readonly id: DefinitionId; readonly protected?: boolean }
): DraftFlags => ({
  id: entry.id,
  owner: resolution.owner,
  protected: entry.protected ?? resolution.header.protected ?? false,
});

type SimpleKind = typeof SimpleKindSchema.Type;

type ReferenceEntry = typeof ReferenceEntrySchema.Type;

type ConditionEntry = typeof ConditionEntrySchema.Type;

/**
 * Whether a type entry is a bare kind name.
 *
 * @param type - A type entry.
 * @returns True for a kind name.
 */
const isSimpleKind = (type: TypeEntry): type is SimpleKind =>
  typeof type === "string";

/**
 * Whether a type entry is a reference naming its target table.
 *
 * @param type - A type entry.
 * @returns True for a reference entry.
 */
const isReferenceEntry = (type: TypeEntry): type is ReferenceEntry =>
  !isSimpleKind(type) && "target" in type;

/**
 * Whether a type entry is a condition naming its table.
 *
 * @param type - A type entry.
 * @returns True for a condition entry.
 */
const isConditionEntry = (type: TypeEntry): type is ConditionEntry =>
  !isSimpleKind(type) && "class" in type;

/** The field type of each bare kind name. */
const SIMPLE_TYPES: Readonly<Record<SimpleKind, FieldType>> = {
  bigInteger: { kind: "bigInteger" },
  boolean: { kind: "boolean" },
  choice: { kind: "choice" },
  date: { kind: "date" },
  dateTime: { kind: "dateTime" },
  integer: { kind: "integer" },
  json: { kind: "json" },
  longText: { kind: "longText" },
  password: { kind: "password" },
  text: { kind: "text" },
  uuid: { kind: "uuid" },
};

const resolveType = (
  resolution: Resolution,
  field: FieldEntry,
  type: TypeEntry
): FieldType | undefined => {
  if (isSimpleKind(type)) {
    return SIMPLE_TYPES[type];
  }

  if (isReferenceEntry(type)) {
    const targetClassId = tableId(resolution, field.id, type.target);

    if (targetClassId === undefined) {
      return undefined;
    }

    return type.allowedRecords === undefined
      ? { kind: "reference", targetClassId }
      : {
          allowedRecords: type.allowedRecords,
          kind: "reference",
          targetClassId,
        };
  }

  if (isConditionEntry(type)) {
    const classId = tableId(resolution, field.id, type.class);

    return classId === undefined
      ? undefined
      : { classId, kind: "condition", profile: type.profile };
  }

  return type;
};

const resolveField = (
  resolution: Resolution,
  table: TableEntry,
  field: FieldEntry
): void => {
  const type = resolveType(resolution, field, field.type);

  if (type !== undefined) {
    resolution.drafts.push({
      ...flagsOf(resolution, field),
      classId: table.id,
      default: field.default ?? null,
      helpText: field.helpText ?? null,
      kind: "field",
      label: field.label ?? labelFor(field.name),
      name: field.name,
      numberPrefix: field.numberPrefix ?? null,
      readOnly: field.readOnly ?? false,
      required: field.required ?? false,
      type,
    });
  }

  for (const [position, choice] of (field.choices ?? []).entries()) {
    resolution.drafts.push({
      ...flagsOf(resolution, choice),
      fieldId: field.id,
      hidden: choice.hidden ?? false,
      key: choice.key,
      kind: "choice",
      label: choice.label,
      order: choice.order ?? position + 1,
    });
  }
};

const resolveOverride = (
  resolution: Resolution,
  table: TableEntry,
  override: OverrideEntry
): void => {
  const fieldId = fieldIdOnLineage(resolution, table, override.field, true);

  if (fieldId === undefined) {
    reportUnknown(resolution, override.id, "inherited field", override.field);

    return;
  }

  resolution.drafts.push({
    ...flagsOf(resolution, override),
    choices: override.choices ?? null,
    classId: table.id,
    default: override.default ?? null,
    fieldId,
    helpText: override.helpText ?? null,
    kind: "override",
    label: override.label ?? null,
    max: override.max ?? null,
    maxLength: override.maxLength ?? null,
    min: override.min ?? null,
    numberPrefix: override.numberPrefix ?? null,
    readOnly: override.readOnly ?? null,
    required: override.required ?? null,
  });
};

const resolveIndexes = (resolution: Resolution, table: TableEntry): void => {
  for (const index of table.indexes ?? []) {
    const fieldIds = index.fields.flatMap((name) => {
      const id = table.fields?.find((field) => field.name === name)?.id;

      if (id === undefined) {
        reportUnknown(resolution, index.id, "field of the index's table", name);

        return [];
      }

      return [id];
    });

    if (fieldIds.length === index.fields.length) {
      resolution.drafts.push({
        ...flagsOf(resolution, index),
        classId: table.id,
        fieldIds,
        kind: "index",
        name: index.name ?? null,
        unique: index.unique ?? false,
      });
    }
  }
};

const resolveLayouts = (resolution: Resolution, table: TableEntry): void => {
  for (const layout of table.layouts ?? []) {
    const elements = layout.elements.flatMap((element): LayoutElement[] => {
      if ("section" in element) {
        return [{ kind: "section", label: element.section }];
      }

      const fieldId = fieldIdOnLineage(resolution, table, element.field, false);

      if (fieldId === undefined) {
        reportUnknown(
          resolution,
          layout.id,
          "field of the layout's table",
          element.field
        );

        return [];
      }

      return [{ fieldId, kind: "field" }];
    });

    if (elements.length === layout.elements.length) {
      resolution.drafts.push({
        ...flagsOf(resolution, layout),
        classId: table.id,
        elements,
        kind: "layout",
        type: layout.type,
      });
    }
  }
};

const optionalId = (
  resolution: Resolution,
  from: DefinitionId,
  what: string,
  name: string | undefined,
  find: (name: string) => DefinitionId | undefined
): DefinitionId | null | undefined => {
  if (name === undefined) {
    return null;
  }

  const found = find(name);

  if (found === undefined) {
    reportUnknown(resolution, from, what, name);
  }

  return found;
};

const resolveTable = (resolution: Resolution, table: TableEntry): void => {
  const parts = splitQualifiedName(table.name);

  if (parts === undefined) {
    resolution.problems.push(
      problem(
        "invalidName",
        table.id,
        `The table name "${table.name}" must be namespace.table.`
      )
    );

    return;
  }

  const namespaceId = lookup(
    resolution,
    table.id,
    "namespace",
    parts.namespace,
    resolution.namespaces.get(parts.namespace),
    resolution.base.namespaceByName(parts.namespace)
  );

  const parentId =
    table.extends === undefined
      ? null
      : tableId(resolution, table.id, table.extends);

  const displayFieldId = optionalId(
    resolution,
    table.id,
    "display field",
    table.displayField,
    (name) => fieldIdOnLineage(resolution, table, name, false)
  );

  if (
    namespaceId !== undefined &&
    parentId !== undefined &&
    displayFieldId !== undefined
  ) {
    resolution.drafts.push({
      ...flagsOf(resolution, table),
      displayFieldId,
      extensible: table.extensible ?? false,
      helpText: table.helpText ?? null,
      kind: "class",
      label: table.label ?? labelFor(parts.table),
      name: parts.table,
      namespaceId,
      parentId,
      storage: table.storage ?? "standard",
    });
  }

  for (const field of table.fields ?? []) {
    resolveField(resolution, table, field);
  }

  for (const override of table.overrides ?? []) {
    resolveOverride(resolution, table, override);
  }

  resolveIndexes(resolution, table);
  resolveLayouts(resolution, table);
};

const roleId = (
  resolution: Resolution,
  from: DefinitionId,
  name: string
): DefinitionId | undefined =>
  lookup(
    resolution,
    from,
    "role",
    name,
    resolution.roles.get(name),
    resolution.base.roleByName(name)
  );

const ruleField = (
  resolution: Resolution,
  rule: AccessRuleEntry,
  name: string
): readonly DefinitionId[] => {
  const table = resolution.tables.get(rule.table);
  const installed = resolution.base.classByName(rule.table);

  const found =
    (table === undefined
      ? undefined
      : fieldIdOnLineage(resolution, table, name, false)) ??
    (installed === undefined
      ? undefined
      : resolution.base.fieldByName(installed.id, name)?.id);

  if (found === undefined) {
    reportUnknown(resolution, rule.id, `field of ${rule.table}`, name);

    return [];
  }

  return [found];
};

const ruleTarget = (
  resolution: Resolution,
  rule: AccessRuleEntry
): AccessTarget | undefined => {
  if (rule.target === "records") {
    return { kind: "records" };
  }

  const { fields } = rule;

  if (fields === undefined || fields === "*") {
    return { fields: "*", kind: "fields" };
  }

  const ids = fields.flatMap((name) => ruleField(resolution, rule, name));

  return ids.length === fields.length
    ? { fields: ids, kind: "fields" }
    : undefined;
};

const resolveAccessRule = (
  resolution: Resolution,
  rule: AccessRuleEntry
): void => {
  const classId =
    rule.table === "*" ? null : tableId(resolution, rule.id, rule.table);

  const roleIds = rule.roles.flatMap((name) => {
    const id = roleId(resolution, rule.id, name);

    return id === undefined ? [] : [id];
  });

  const target = ruleTarget(resolution, rule);

  if (
    classId !== undefined &&
    target !== undefined &&
    roleIds.length === rule.roles.length
  ) {
    resolution.drafts.push({
      ...flagsOf(resolution, rule),
      actions: rule.actions,
      active: rule.active ?? true,
      classId,
      condition: rule.condition ?? null,
      description: rule.description ?? null,
      effect: rule.effect,
      kind: "accessRule",
      name: rule.name ?? null,
      roleIds,
      target,
    });
  }
};

const resolveSubscription = (
  resolution: Resolution,
  subscription: SubscriptionEntry
): void => {
  const classId = tableId(resolution, subscription.id, subscription.table);

  if (classId !== undefined) {
    resolution.drafts.push({
      ...flagsOf(resolution, subscription),
      classId,
      condition: subscription.condition ?? null,
      deadLetter: subscription.deadLetter ?? "block",
      enabled: subscription.enabled ?? true,
      identityId: subscription.identity,
      kind: "subscription",
      maxAttempts: subscription.maxAttempts ?? 10,
      name: subscription.name,
      operations: subscription.operations,
    });
  }
};

const resolveAccess = (resolution: Resolution, file: SetFile): void => {
  for (const entry of file.roles ?? []) {
    resolution.drafts.push({
      ...flagsOf(resolution, entry),
      helpText: entry.helpText ?? null,
      kind: "role",
      label: entry.label ?? labelFor(entry.name),
      name: entry.name,
    });
  }

  for (const entry of file.permissions ?? []) {
    resolution.drafts.push({
      ...flagsOf(resolution, entry),
      helpText: entry.helpText ?? null,
      kind: "permission",
      label: entry.label ?? labelFor(entry.name),
      name: entry.name,
    });
  }

  for (const entry of file.grants ?? []) {
    const permissionId = lookup(
      resolution,
      entry.id,
      "permission",
      entry.permission,
      resolution.permissions.get(entry.permission),
      resolution.base.permissionByName(entry.permission)
    );

    const role = roleId(resolution, entry.id, entry.role);

    if (permissionId !== undefined && role !== undefined) {
      resolution.drafts.push({
        ...flagsOf(resolution, entry),
        kind: "grant",
        permissionId,
        roleId: role,
      });
    }
  }

  for (const entry of file.accessRules ?? []) {
    resolveAccessRule(resolution, entry);
  }

  for (const entry of file.subscriptions ?? []) {
    resolveSubscription(resolution, entry);
  }
};

const resolveFile = (resolution: Resolution, file: SetFile): void => {
  for (const entry of file.namespaces ?? []) {
    resolution.drafts.push({
      ...flagsOf(resolution, entry),
      extensible: entry.extensible ?? false,
      helpText: entry.helpText ?? null,
      kind: "namespace",
      label: entry.label ?? labelFor(entry.name),
      name: entry.name,
      storage: entry.storage ?? "standard",
    });
  }

  for (const table of file.tables ?? []) {
    resolveTable(resolution, table);
  }

  resolveAccess(resolution, file);
};

const tableIds = (table: TableEntry): readonly DefinitionId[] => [
  table.id,
  ...(table.fields ?? []).map((entry) => entry.id),
  ...(table.fields ?? []).flatMap((entry) =>
    (entry.choices ?? []).map((choice) => choice.id)
  ),
  ...(table.layouts ?? []).map((entry) => entry.id),
  ...(table.overrides ?? []).map((entry) => entry.id),
  ...(table.indexes ?? []).map((entry) => entry.id),
];

const allIds = (file: SetFile): readonly DefinitionId[] => [
  ...(file.namespaces ?? []).map((entry) => entry.id),
  ...(file.tables ?? []).flatMap(tableIds),
  ...(file.roles ?? []).map((entry) => entry.id),
  ...(file.permissions ?? []).map((entry) => entry.id),
  ...(file.grants ?? []).map((entry) => entry.id),
  ...(file.accessRules ?? []).map((entry) => entry.id),
  ...(file.subscriptions ?? []).map((entry) => entry.id),
];

const checkIds = (resolution: Resolution, files: readonly SetFile[]): void => {
  const seen = new Set<DefinitionId>();

  for (const id of files.flatMap(allIds)) {
    if (seen.has(id)) {
      resolution.problems.push(
        problem("duplicateId", id, `The ID ${id} is used twice in the set.`)
      );
    }

    seen.add(id);
    const stored = resolution.base.get(id);

    if (stored !== undefined && !sameOwner(stored.owner, resolution.owner)) {
      resolution.problems.push(
        problem(
          "duplicateId",
          id,
          `The ID ${id} belongs to a definition of another owner.`
        )
      );
    }
  }
};

const headerOf = (
  files: readonly SetFile[],
  problems: DefinitionProblem[]
): SetHeader | undefined => {
  const headers = files.flatMap((file) =>
    file.set === undefined ? [] : [file.set]
  );

  if (headers.length !== 1) {
    problems.push(
      problem(
        "invalidName",
        null,
        `A set has exactly one set header; found ${headers.length}.`
      )
    );
  }

  return headers[0];
};

const visibleOwners = (
  header: SetHeader,
  required: ReadonlyMap<string, Owner>,
  problems: DefinitionProblem[]
): readonly Owner[] =>
  (header.requires ?? []).flatMap((name): Owner[] => {
    if (name === "core") {
      return [{ layer: "core" }];
    }

    const found = required.get(name);

    if (found === undefined) {
      problems.push(
        problem(
          "unknownReference",
          header.id,
          `The required set "${name}" is not installed.`
        )
      );

      return [];
    }

    return [found];
  });

const namesOf = (
  files: readonly SetFile[],
  pick: (
    file: SetFile
  ) => readonly { readonly id: DefinitionId; readonly name: string }[]
): ReadonlyMap<string, DefinitionId> =>
  new Map(
    files.flatMap((file) =>
      pick(file).map((entry) => [entry.name, entry.id] as const)
    )
  );

/**
 * Resolves a set's files into drafts.
 *
 * @param files - Every decoded file of the set, in any order.
 * @param base - The installed configuration; names of required sets resolve against it.
 * @param required - Owners of the sets this set requires, by set name; `core` is always the core layer.
 * @returns The resolved set, or every problem found.
 */
export const resolveSet = (
  files: readonly NamedSetFile[],
  base: ConfigSnapshot,
  required: ReadonlyMap<string, Owner> = new Map()
): Result<ResolvedSet, DefinitionInvalid> => {
  const problems: DefinitionProblem[] = [];

  const contents = files
    .toSorted((left, right) => (left.path < right.path ? -1 : 1))
    .map((file) => file.content);

  const header = headerOf(contents, problems);

  if (header === undefined) {
    return fail(new DefinitionInvalid({ problems }));
  }

  const owner = ownerOf(header);

  const resolution: Resolution = {
    base,
    drafts: [],
    header,
    namespaces: namesOf(contents, (file) => file.namespaces ?? []),
    owner,
    permissions: namesOf(contents, (file) => file.permissions ?? []),
    problems,
    roles: namesOf(contents, (file) => file.roles ?? []),
    tables: new Map(
      contents.flatMap((file) =>
        (file.tables ?? []).map((entry) => [entry.name, entry] as const)
      )
    ),
    visible: [owner, ...visibleOwners(header, required, problems)],
  };

  checkIds(resolution, contents);

  for (const file of contents) {
    resolveFile(resolution, file);
  }

  return problems.length > 0
    ? fail(new DefinitionInvalid({ problems }))
    : succeed({ drafts: resolution.drafts, header, owner });
};
