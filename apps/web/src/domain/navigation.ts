/**
 * How the navigation groups the tables a user can open: the app tables
 * first, by namespace, then the platform's own tables under
 * "Administration". The platform tables are the shipped `core` definition
 * set's (`docs/architecture.md`, "Repository layout": `core` holds the
 * definition and platform tables), so any namespace but `core` is an
 * app's.
 */
import type { MetaTableSummary } from "./metadata.ts";

/** The namespace of the platform's own tables. */
export const PLATFORM_NAMESPACE = "core";

/** The heading of the group that holds the platform's tables. */
export const ADMINISTRATION_LABEL = "Administration";

/**
 * A table's namespace: the part of its name before the first dot.
 *
 * @param table - The table's name, such as `helpdesk.incident`.
 * @returns The namespace, such as `helpdesk`.
 */
export const namespaceOf = (table: string): string =>
  table.split(".")[0] ?? table;

/** The tables of one app namespace. */
export interface AppGroup {
  readonly namespace: string;
  readonly tables: readonly MetaTableSummary[];
}

/** The tables of the navigation, grouped. */
export interface NavigationGroups {
  readonly apps: readonly AppGroup[];
  readonly administration: readonly MetaTableSummary[];
}

/**
 * Groups the tables for the navigation and the home page, each group
 * keeping the order the table list gave (sorted by name).
 *
 * @param tables - The tables the user can open.
 * @returns The app namespaces in order of their first table, and the
 *   platform's tables.
 */
export const navigationGroupsOf = (
  tables: readonly MetaTableSummary[]
): NavigationGroups => {
  const appTables = tables.filter(
    (table) => namespaceOf(table.name) !== PLATFORM_NAMESPACE
  );

  const namespaces = [
    ...new Set(appTables.map((table) => namespaceOf(table.name))),
  ];

  return {
    administration: tables.filter(
      (table) => namespaceOf(table.name) === PLATFORM_NAMESPACE
    ),
    apps: namespaces.map((namespace) => ({
      namespace,
      tables: appTables.filter(
        (table) => namespaceOf(table.name) === namespace
      ),
    })),
  };
};

/**
 * Whether a table is one of the platform's.
 *
 * @param table - The table's name.
 * @returns True for a `core` table.
 */
export const isPlatformTable = (table: string): boolean =>
  namespaceOf(table) === PLATFORM_NAMESPACE;
