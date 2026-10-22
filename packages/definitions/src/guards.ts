import { currentOf, refuse } from "./apply-work.ts";
import type { Work } from "./apply-work.ts";
import { DefinitionProtected } from "./definition-protected.ts";
import type { ProtectionReason } from "./definition-protected.ts";
/**
 * Protected definitions, ownership and local additions (Contracts 1.1,
 * 1.8, 8.1): the checks the schema service runs on every operation, for
 * every caller, admins included, before anything else looks at it.
 *
 * - A protected definition accepts no change except label and help text,
 *   unless the change set is the core set itself. Such a change by any
 *   other origin is marked `localOverride`; the config service stores it
 *   as an override of the shipped record.
 * - Rename, retire, reactivate and delete of a definition owned by core or
 *   an app are for its own set only. A retired app definition may be
 *   purged locally (an app removed it upstream, Contracts 8.4).
 * - Platform tables, their fields and their namespace are never renamed,
 *   retired, purged or deleted, and never extended; only the core set
 *   creates a table or namespace with platform storage.
 * - New definitions belong to the origin's layer. Local additions may go
 *   onto app tables and `extensible` core tables (fields, indexes, child
 *   classes, overrides); the `core` namespace and app namespaces are
 *   reserved for their sets. One check (`guardNewDefinition`) covers every
 *   operation that adds a definition.
 */
import type {
  ClassDefinition,
  Definition,
  OverrideDraft,
  Owner,
} from "./definition.ts";
import type { DefinitionId } from "./ids.ts";
import type { CreateOperation } from "./operation.ts";
import { isCoreOrigin, originOwns, ownerOfOrigin } from "./requester.ts";

/** What a guard says about a change it allows. */
export interface Allowed {
  /** The origin does not own the definition (Contracts 8.2 override). */
  readonly localOverride: boolean;
}

/** The properties anyone may change on a protected definition. */
const DESCRIPTIVE: ReadonlySet<string> = new Set(["label", "helpText"]);

/** The operations a guard checks on existing definitions. */
export type GuardedAction =
  | "update"
  | "setOverride"
  | "rename"
  | "retire"
  | "reactivate"
  | "purge"
  | "delete";

const refused = (
  work: Work,
  definitionId: DefinitionId,
  operation: string,
  reason: ProtectionReason
): void => {
  refuse(work, new DefinitionProtected({ definitionId, operation, reason }));
};

const classOf = (
  work: Work,
  id: DefinitionId | null
): ClassDefinition | undefined => {
  const found = id === null ? undefined : currentOf(work, id);

  return found?.kind === "class" ? found : undefined;
};

/**
 * Whether a definition is (part of) a platform table: owned by platform
 * migrations, so the schema engine never changes its storage.
 *
 * @param work - The application.
 * @param target - A definition.
 * @returns True for platform namespaces, classes and their fields.
 */
const isPlatform = (work: Work, target: Definition): boolean => {
  if (target.kind === "namespace" || target.kind === "class") {
    return target.storage === "platform";
  }

  return (
    target.kind === "field" &&
    classOf(work, target.classId)?.storage === "platform"
  );
};

/**
 * Why an origin may not change an existing definition, if it may not.
 *
 * @param work - The application.
 * @param target - The definition.
 * @param action - The operation.
 * @param changedKeys - For `update`, the properties it changes.
 * @returns The reason, or undefined when the change is allowed.
 */
const changeProblem = (
  work: Work,
  target: Definition,
  action: GuardedAction,
  changedKeys: readonly string[]
): ProtectionReason | undefined => {
  const { origin } = work.context;
  const describes = action === "update" || action === "setOverride";

  if (!describes && isPlatform(work, target)) {
    return "platform";
  }

  if (target.protected && !isCoreOrigin(origin)) {
    const descriptive =
      action === "update" && changedKeys.every((key) => DESCRIPTIVE.has(key));

    return descriptive ? undefined : "protected";
  }

  const mayChange =
    describes ||
    originOwns(origin, target.owner) ||
    (action === "purge" && target.owner.layer === "app");

  return mayChange ? undefined : "owner";
};

/**
 * Checks a change to an existing definition.
 *
 * @param work - The application; a refusal is recorded there.
 * @param target - The definition as the change set has left it so far.
 * @param action - The operation.
 * @param changedKeys - For `update`, the properties it changes.
 * @returns How the change is allowed, or undefined when it is refused.
 */
export const guardChange = (
  work: Work,
  target: Definition,
  action: GuardedAction,
  changedKeys: readonly string[] = []
): Allowed | undefined => {
  const reason = changeProblem(work, target, action, changedKeys);

  if (reason !== undefined) {
    refused(work, target.id, action, reason);

    return undefined;
  }

  const describes = action === "update" || action === "setOverride";

  return {
    localOverride: describes && !originOwns(work.context.origin, target.owner),
  };
};

const sameOwner = (left: Owner, right: Owner): boolean => {
  if (left.layer === "app" && right.layer === "app") {
    return left.setId === right.setId;
  }

  return left.layer === right.layer;
};

/**
 * A definition a change set adds: the draft of a create operation, or of
 * an override added by `setOverride` without a version.
 */
export type NewDefinition = CreateOperation["definition"] | OverrideDraft;

/**
 * The class a new definition attaches to, if any: a child class's parent,
 * or the class of a field, an index or an override. Every kind that
 * extends an existing table is listed here, so the attachment rule below
 * covers them all.
 *
 * @param work - The application.
 * @param definition - The new definition.
 * @returns The class, or undefined when it attaches to none.
 */
const hostOf = (
  work: Work,
  definition: NewDefinition
): ClassDefinition | undefined => {
  switch (definition.kind) {
    case "class": {
      return classOf(work, definition.parentId);
    }

    case "field":
    case "index":
    case "override": {
      return classOf(work, definition.classId);
    }

    // These extend no table. A namespace is checked by `storageProblem`;
    // an access rule or subscription on a platform table is refused by
    // validation (`invalidAccessRule`, `invalidSubscription`).
    case "namespace":
    case "role":
    case "permission":
    case "grant":
    case "accessRule":
    case "subscription": {
      return undefined;
    }

    // A new definition kind must be placed above before this compiles.
    default: {
      return definition satisfies never;
    }
  }
};

/**
 * Whether the origin may attach a new definition to a class: a platform
 * table only for the core set, which describes it; otherwise classes the
 * origin owns, app classes and extensible core classes.
 *
 * @param work - The application.
 * @param host - The class.
 * @returns Why not, or undefined when it may.
 */
const attachProblem = (
  work: Work,
  host: ClassDefinition | undefined
): ProtectionReason | undefined => {
  const { origin } = work.context;

  if (host === undefined) {
    return undefined;
  }

  if (host.storage === "platform") {
    return isCoreOrigin(origin) ? undefined : "platform";
  }

  if (originOwns(origin, host.owner)) {
    return undefined;
  }

  return host.owner.layer === "core" && !host.extensible
    ? "notExtensible"
    : undefined;
};

/**
 * Whether the origin may create a table or namespace with platform
 * storage: only the core set, which describes what platform migrations
 * own (Contracts 1.8, 1.9). For anyone else nothing would create the
 * table or schema, so the change set could only fail.
 *
 * @param work - The application.
 * @param definition - The new definition.
 * @returns Why not, or undefined when it may.
 */
const storageProblem = (
  work: Work,
  definition: NewDefinition
): ProtectionReason | undefined => {
  const hasStorage =
    definition.kind === "class" || definition.kind === "namespace";

  if (!hasStorage || definition.storage !== "platform") {
    return undefined;
  }

  return isCoreOrigin(work.context.origin) ? undefined : "platform";
};

/**
 * Whether the origin may create a table in its namespace: one it owns, and
 * a platform namespace only for the core set.
 *
 * @param work - The application.
 * @param definition - The new definition.
 * @returns Why not, or undefined when it may.
 */
const namespaceProblem = (
  work: Work,
  definition: NewDefinition
): ProtectionReason | undefined => {
  if (definition.kind !== "class") {
    return undefined;
  }

  const namespace = currentOf(work, definition.namespaceId);

  if (namespace === undefined) {
    return undefined;
  }

  const { origin } = work.context;

  if (!originOwns(origin, namespace.owner)) {
    return "reserved";
  }

  // An origin's own namespace with platform storage cannot be made by
  // anyone but the core set (`storageProblem`); this keeps a table out of
  // one should it exist.
  return namespace.kind === "namespace" &&
    namespace.storage === "platform" &&
    !isCoreOrigin(origin)
    ? "platform"
    : undefined;
};

/**
 * Checks a new definition, whatever operation adds it (every create and a
 * new override; there is no other way to add one): it belongs to the
 * origin's layer; only the core set adds platform storage or anything to a
 * platform namespace or table; a new table lives in a namespace the origin
 * owns; fields, indexes, overrides and child classes go only onto classes
 * the origin owns, app classes or extensible core classes.
 *
 * @param work - The application; a refusal is recorded there.
 * @param operation - The operation's tag.
 * @param definition - The new definition.
 * @returns True when the definition may be added.
 */
export const guardNewDefinition = (
  work: Work,
  operation: CreateOperation["op"] | "setOverride",
  definition: NewDefinition
): boolean => {
  const reason = sameOwner(definition.owner, ownerOfOrigin(work.context.origin))
    ? (storageProblem(work, definition) ??
      namespaceProblem(work, definition) ??
      attachProblem(work, hostOf(work, definition)))
    : "owner";

  if (reason !== undefined) {
    refused(work, definition.id, operation, reason);

    return false;
  }

  return true;
};
