/**
 * Text output of `std upgrade` and `std doctor`.
 */
import type { SetReport } from "@std/definitions/upgrade-report";
import { stringifyJson } from "@std/values/json";
import type { JsonValue } from "@std/values/json-value";

import type {
  PlannedMigration,
  UpgradePlan,
  UpgradeReport,
} from "../config/upgrade.ts";
import type { DoctorReport } from "../doctor/doctor.ts";

const value = (input: JsonValue): string => stringifyJson(input);

const listed = (properties: readonly string[]): string =>
  properties.length > 0 ? ` (${properties.join(", ")})` : "";

const dependents = (
  entries: SetReport["removed"][number]["localDependents"]
): string =>
  entries.length > 0
    ? `; local dependents: ${entries.map((entry) => [entry.kind, entry.name].join(" ")).join(", ")}`
    : "";

const versionText = (report: SetReport): string =>
  report.fromVersion === null
    ? `install v${report.toVersion}`
    : `v${report.fromVersion} -> v${report.toVersion}`;

const migrationStateText = (state: PlannedMigration["state"]): string => {
  if (state === "running") {
    return "incomplete, resumed";
  }

  return "pending";
};

/**
 * The record changes of a set: each one, or counts per kind for a first
 * install (the JSON form always lists each one).
 *
 * @param report - The set's report.
 * @returns Lines to print.
 */
const changeLines = (report: SetReport): readonly string[] => {
  if (report.fromVersion !== null) {
    return report.changes.map(
      (change) =>
        `  ${change.action} ${change.kind} ${change.name}${listed(change.properties)}`
    );
  }

  const counts = new Map<string, number>();

  for (const change of report.changes) {
    counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1);
  }

  return [...counts].map(([kind, count]) => `  created ${count} ${kind}`);
};

const setLines = (report: SetReport): readonly string[] => [
  `Set ${report.name} (${report.layer}): ${versionText(report)}, ${report.operations} operations`,
  ...changeLines(report),
  ...report.removed.map(
    (removal) =>
      `  removed upstream: ${removal.kind} ${removal.name} ${removal.action}${dependents(removal.localDependents)}`
  ),
  ...report.conflicts.map(
    (conflict) =>
      `  conflict: ${conflict.kind} ${conflict.name} ${conflict.property}: shipped ${value(conflict.oldShipped)} -> ${value(conflict.newShipped)}, local ${value(conflict.local)} stays`
  ),
  ...report.converged.map(
    (entry) =>
      `  converged: ${entry.kind} ${entry.name} ${entry.property} = ${value(entry.value)} (override dropped)`
  ),
  ...report.kept.map(
    (entry) =>
      `  kept: override of ${entry.property} on ${entry.recordId} (${value(entry.local)})`
  ),
  ...report.refusals.map(
    (refusal) => `  REFUSED (${refusal.code}): ${refusal.message}`
  ),
];

/**
 * The text form of a plan.
 *
 * @param plan - The plan.
 * @returns Lines to print.
 */
export const planLines = (plan: UpgradePlan): readonly string[] => [
  `Plan ${plan.hash} (STD ${plan.stdVersion}, from revision ${plan.basis.revision ?? "none"})`,
  ...(plan.migrations.length === 0
    ? ["Platform migrations: up to date"]
    : plan.migrations.map(
        (migration) =>
          `Platform migration ${String(migration.id).padStart(4, "0")} ${migration.name} (${migration.kind}): ${migrationStateText(migration.state)}`
      )),
  ...plan.resume.map(
    (changeSet) =>
      `Change set ${changeSet.id}: ${changeSet.state === "applying" ? "resumed" : "needs attention (std schema resume or abandon)"}`
  ),
  ...plan.sets.flatMap(setLines),
  "Security changes:",
  ...(plan.security.length === 0
    ? ["  none"]
    : plan.security.map(
        (change) =>
          `  ${change.set}: ${change.change} ${change.kind} ${change.name}${listed(change.properties)}`
      )),
  ...plan.warnings.map((warning) => `Warning: ${warning}`),
  plan.refusals.length === 0
    ? "Result: the upgrade can run"
    : `Result: refused (${plan.refusals.length} refusals); nothing will be applied`,
];

/**
 * The text form of a finished upgrade.
 *
 * @param report - What the upgrade did.
 * @returns Lines to print.
 */
export const reportLines = (report: UpgradeReport): readonly string[] => [
  ...planLines(report.plan).slice(0, -1),
  ...report.migrations.map(
    (outcome) =>
      `Platform migration ${String(outcome.id).padStart(4, "0")} ${outcome.name}: ${outcome.outcome}`
  ),
  ...report.resumed.map(
    (entry) => `Change set ${entry.id}: ${entry.outcome.state}`
  ),
  ...report.sets.map((set) => {
    const revision = set.result.completeRevision ?? set.result.revision;

    return revision === null
      ? `Set ${set.name} v${set.version}: ${set.result.state}`
      : `Set ${set.name} v${set.version}: ${set.result.state} at revision ${revision}`;
  }),
  ...report.dataMigrations.map(
    (outcome) =>
      `Data migration ${String(outcome.id).padStart(4, "0")} ${outcome.name}: ${outcome.outcome}, ${outcome.changed} records changed in ${outcome.batches} batches`
  ),
];

/**
 * The text form of a `doctor` report.
 *
 * @param report - The report.
 * @returns Lines to print.
 */
export const doctorLines = (report: DoctorReport): readonly string[] => [
  ...report.findings.map(
    (entry) =>
      `[${entry.check}] ${entry.severity} ${entry.code}: ${entry.message}`
  ),
  report.exitCode === 0
    ? "doctor: clean"
    : `doctor: ${report.findings.filter((entry) => entry.severity === "error").length} errors, ${report.findings.filter((entry) => entry.severity === "warning").length} warnings`,
];
