/**
 * The report of a set upgrade (Contracts 8.4, 8.5): what each set changes,
 * the conflicts it opens, the overrides it drops as converged, what it
 * removes, what it refuses, and every security-relevant change. The plan
 * (`std upgrade --plan`) prints it and the real run reproduces it.
 *
 * Every shape here is plain JSON, so the report can be printed, hashed and
 * compared.
 */
import type { JsonObject, JsonValue } from "@std/values/json-value";

import type { Definition } from "./definition.ts";
import type { DefinitionId } from "./ids.ts";
import type { Draft } from "./set-resolve.ts";
import type { ConfigSnapshot } from "./snapshot.ts";

/** Why a set (and with it the whole upgrade) is refused at plan time. */
export type RefusalCode =
  | "downgrade"
  | "nameClash"
  | "typeChanged"
  | "unsupportedChange"
  | "renameUnsupported"
  | "reactivationUnsupported"
  | "removalUnsupported"
  | "roleInUse"
  | "dataViolation"
  | "invalid"
  | "lifecycleRefused"
  | "setCycle"
  | "unfinishedChangeSet"
  | "unknownSet";

/** One refusal. */
export interface Refusal {
  readonly code: RefusalCode;
  /** The set's name. */
  readonly set: string;
  readonly definitionId: DefinitionId | null;
  readonly message: string;
  /** Code-specific details: the local definition of a clash, counts, rules. */
  readonly details: JsonObject;
}

/** How a record changes. */
export type ChangeAction =
  | "created"
  | "updated"
  | "renamed"
  | "deactivated"
  | "disabled"
  | "hidden"
  | "deleted"
  | "retired";

/** One record the upgrade creates or changes (shipped or effective). */
export interface RecordChange {
  readonly id: DefinitionId;
  readonly kind: string;
  readonly name: string;
  readonly action: ChangeAction;
  /** Shipped properties that changed, sorted. */
  readonly properties: readonly string[];
}

/** A local value that differs from both the old and the new shipped value. */
export interface ConflictReport {
  readonly recordId: DefinitionId;
  readonly kind: string;
  readonly name: string;
  readonly property: string;
  readonly oldShipped: JsonValue;
  readonly newShipped: JsonValue;
  readonly local: JsonValue;
}

/** An override dropped because the new shipped value equals it. */
export interface ConvergedReport {
  readonly recordId: DefinitionId;
  readonly kind: string;
  readonly name: string;
  readonly property: string;
  /** The shipped value before the upgrade. */
  readonly oldShipped: JsonValue;
  /** The new shipped value, equal to the local value. */
  readonly value: JsonValue;
}

/** An override kept because the new shipped value equals `base_when_set`. */
export interface KeptReport {
  readonly recordId: DefinitionId;
  readonly property: string;
  readonly local: JsonValue;
}

/** A local definition that refers to a removed record. */
export interface DependentReport {
  readonly id: DefinitionId;
  readonly kind: string;
  readonly name: string;
  readonly dependency: string;
}

/** A record its set no longer ships (removed upstream). */
export interface RemovalReport {
  readonly id: DefinitionId;
  readonly kind: string;
  readonly name: string;
  readonly action: ChangeAction;
  readonly localDependents: readonly DependentReport[];
}

/** A change to an access rule, role or permission grant. */
export interface SecurityChange {
  readonly id: DefinitionId;
  readonly kind: "accessRule" | "role" | "grant";
  readonly name: string;
  readonly change: ChangeAction | "removed";
  readonly properties: readonly string[];
}

/** Rows that violate a tightening the set makes, counted at plan time. */
export interface DataViolation {
  readonly definitionId: DefinitionId;
  readonly count: number;
  readonly sampleIds: readonly string[];
}

/** What one set's upgrade does. */
export interface SetReport {
  readonly id: DefinitionId;
  readonly name: string;
  readonly layer: "core" | "app";
  /** The installed version, or null for a first install. */
  readonly fromVersion: number | null;
  readonly toVersion: number;
  readonly hash: string;
  /** The same version ships different content (a warning, not a refusal). */
  readonly contentChangedWithoutVersion: boolean;
  /** How many change-set operations the set needs. */
  readonly operations: number;
  readonly changes: readonly RecordChange[];
  readonly conflicts: readonly ConflictReport[];
  readonly converged: readonly ConvergedReport[];
  readonly kept: readonly KeptReport[];
  readonly removed: readonly RemovalReport[];
  readonly security: readonly SecurityChange[];
  readonly refusals: readonly Refusal[];
}

const nameProperty = (definition: Definition | Draft): string | undefined =>
  "name" in definition ? (definition.name ?? undefined) : undefined;

const fieldName = (snapshot: ConfigSnapshot, id: DefinitionId): string => {
  const field = snapshot.field(id);

  return field === undefined
    ? id
    : `${snapshot.qualifiedNameOf(field.classId) ?? field.classId}.${field.name}`;
};

/**
 * How a report names a choice, a layout or a saved filter: by what it
 * belongs to, not by ID.
 *
 * @param snapshot - The configuration that resolves the names.
 * @param definition - A definition or draft.
 * @returns The name, or undefined for other kinds.
 */
const uiConfigName = (
  snapshot: ConfigSnapshot,
  definition: Definition | Draft
): string | undefined => {
  if (definition.kind === "choice") {
    return `choice ${definition.key} of ${fieldName(snapshot, definition.fieldId)}`;
  }

  if (definition.kind === "layout") {
    return `${definition.type} layout of ${snapshot.qualifiedNameOf(definition.classId) ?? definition.classId}`;
  }

  if (definition.kind === "formRule") {
    return `form rule ${definition.name} of ${snapshot.qualifiedNameOf(definition.classId) ?? definition.classId}`;
  }

  if (definition.kind === "recordRule") {
    return `record rule ${definition.name} of ${snapshot.qualifiedNameOf(definition.classId) ?? definition.classId}`;
  }

  return definition.kind === "savedFilter"
    ? `saved filter ${definition.name} of ${snapshot.qualifiedNameOf(definition.classId) ?? definition.classId}`
    : undefined;
};

/**
 * A readable name of a definition for reports.
 *
 * @param snapshot - A snapshot holding the definitions it refers to.
 * @param definition - The definition or draft.
 * @returns For example `acme.asset.name`, `asset_manager` or the rule's
 *   description.
 */
export const displayName = (
  snapshot: ConfigSnapshot,
  definition: Definition | Draft
): string => {
  if (definition.kind === "class") {
    return snapshot.qualifiedNameOf(definition.id) ?? definition.name;
  }

  if (definition.kind === "field") {
    return `${snapshot.qualifiedNameOf(definition.classId) ?? definition.classId}.${definition.name}`;
  }

  if (definition.kind === "override") {
    return `override of ${fieldName(snapshot, definition.fieldId)} on ${snapshot.qualifiedNameOf(definition.classId) ?? definition.classId}`;
  }

  if (definition.kind === "index") {
    return `index on ${snapshot.qualifiedNameOf(definition.classId) ?? definition.classId}`;
  }

  if (definition.kind === "grant") {
    const role = snapshot.role(definition.roleId)?.name ?? definition.roleId;

    const permission =
      snapshot.getKind("permission", definition.permissionId)?.name ??
      definition.permissionId;

    return `${permission} granted to ${role}`;
  }

  if (definition.kind === "accessRule") {
    return definition.description ?? `access rule ${definition.id}`;
  }

  return (
    uiConfigName(snapshot, definition) ??
    nameProperty(definition) ??
    definition.id
  );
};
