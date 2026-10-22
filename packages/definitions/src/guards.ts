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
 *   retired, purged or deleted, and never extended.
 * - New definitions belong to the origin's layer. Local additions may go
 *   onto app tables and `extensible` core tables (fields, indexes, child
 *   classes, overrides); the `core` namespace and app namespaces are
 *   reserved for their sets.
 */
import type { ClassDefinition, Definition, Owner } from "./definition.ts";
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
 * Whether the origin may attach a new definition to a class it does not
 * own: app classes and extensible core classes, never platform tables.
 *
 * @param work - The application.
 * @param host - The class.
 * @returns Why not, or undefined when it may.
 */
const attachProblem = (
  work: Work,
  host: ClassDefinition | undefined
): ProtectionReason | undefined => {
  if (host === undefined || originOwns(work.context.origin, host.owner)) {
    return undefined;
  }

  if (host.storage === "platform") {
    return "platform";
  }

  return host.owner.layer === "core" && !host.extensible
    ? "notExtensible"
    : undefined;
};

const hostOf = (
  work: Work,
  operation: CreateOperation
): ClassDefinition | undefined => {
  const { definition } = operation;

  if (definition.kind === "class") {
    return classOf(work, definition.parentId);
  }

  return definition.kind === "field" || definition.kind === "index"
    ? classOf(work, definition.classId)
    : undefined;
};

const namespaceProblem = (
  work: Work,
  operation: CreateOperation
): ProtectionReason | undefined => {
  const { definition } = operation;

  if (definition.kind !== "class") {
    return undefined;
  }

  const namespace = currentOf(work, definition.namespaceId);

  return namespace !== undefined &&
    !originOwns(work.context.origin, namespace.owner)
    ? "reserved"
    : undefined;
};

/**
 * Checks a create operation: the new definition belongs to the origin's
 * layer, a new table lives in a namespace the origin owns, and fields,
 * indexes and child classes go only onto classes the origin owns, app
 * classes or extensible core classes.
 *
 * @param work - The application; a refusal is recorded there.
 * @param operation - The create operation.
 * @returns True when the create may proceed.
 */
export const guardCreate = (
  work: Work,
  operation: CreateOperation
): boolean => {
  const { definition } = operation;

  const reason = sameOwner(definition.owner, ownerOfOrigin(work.context.origin))
    ? (namespaceProblem(work, operation) ??
      attachProblem(work, hostOf(work, operation)))
    : "owner";

  if (reason !== undefined) {
    refused(work, definition.id, operation.op, reason);

    return false;
  }

  return true;
};

/**
 * Checks a new override: it goes onto a class the origin owns, an app
 * class or an extensible core class.
 *
 * @param work - The application; a refusal is recorded there.
 * @param id - The override's ID.
 * @param owner - The override's owner.
 * @param classId - The class it is attached to.
 * @returns True when the override may be created.
 */
export const guardNewOverride = (
  work: Work,
  id: DefinitionId,
  owner: Owner,
  classId: DefinitionId
): boolean => {
  const reason = sameOwner(owner, ownerOfOrigin(work.context.origin))
    ? attachProblem(work, classOf(work, classId))
    : "owner";

  if (reason !== undefined) {
    refused(work, id, "setOverride", reason);

    return false;
  }

  return true;
};
