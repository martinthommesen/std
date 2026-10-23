/**
 * The parts of a TMF query (Contracts 10.3, 11.1) that depend only on the
 * mapping: `fields` and `sort` in TMF attribute names. Attribute filters
 * compile on the server against the caller's visible schema, through the
 * same TMF630 machinery as `/api/v2` (`server/http/tmf/query.ts`).
 */
import { Result } from "effect";

import { IDENTITY_ATTRIBUTES } from "./render.ts";

/** Why `fields` or `sort` is refused. */
export type QueryIssue =
  | { readonly kind: "malformed"; readonly parameter: string }
  | { readonly kind: "unknownAttribute"; readonly attribute: string }
  | { readonly kind: "conflict"; readonly attribute: string }
  | { readonly kind: "unsortable"; readonly attribute: string };

/**
 * Parses `fields` (TMF630 v5.0.0 Part 1 §4.3 pp.50-57): comma-separated
 * attribute names; `none` for the identity attributes only; `!name` leaves
 * an attribute out; a dotted name (`note.text`) selects its top-level
 * attribute whole [judgment: TMF responses are not trimmed inside an
 * attribute]. `id`, `href`, `@type`, `@baseType` and `@schemaLocation` are
 * always returned. A name the caller does not know is `unknownAttribute`,
 * identical for a missing and a hidden attribute (3.4).
 *
 * @param text - The parameter, if given.
 * @param known - The attribute names known to the caller.
 * @returns The attributes to render (null: all), or the issue.
 */
export const parseTmfFields = (
  text: string | undefined,
  known: readonly string[]
): Result.Result<ReadonlySet<string> | null, QueryIssue> => {
  if (text === undefined) {
    return Result.succeed(null);
  }

  const items = text.split(",").map((item) => item.trim());

  if (items.includes("")) {
    return Result.fail({ kind: "malformed", parameter: "fields" });
  }

  const knownSet = new Set(known);
  const included = new Set<string>();
  const excluded = new Set<string>();

  for (const item of items) {
    const negated = item.startsWith("!");
    const [name = ""] = (negated ? item.slice(1) : item).split(".");

    if (name === "none" || IDENTITY_ATTRIBUTES.has(name)) {
      // Identity attributes are always returned.
    } else if (knownSet.has(name)) {
      (negated ? excluded : included).add(name);
    } else {
      return Result.fail({ attribute: name, kind: "unknownAttribute" });
    }
  }

  const conflict = [...included].find((name) => excluded.has(name));

  if (conflict !== undefined) {
    return Result.fail({ attribute: conflict, kind: "conflict" });
  }

  return Result.succeed(
    included.size > 0 || excluded.size === 0
      ? included
      : new Set(known.filter((name) => !excluded.has(name)))
  );
};

/** One key of a `sort`. */
export interface TmfSortKey {
  readonly attribute: string;
  readonly descending: boolean;
}

/**
 * Parses `sort` (TMF630 v5.0.0 Part 1 §4.8 p.99): `-name` descending,
 * `name` and `+name` ascending.
 *
 * @param text - The parameter, if given.
 * @param known - The attribute names known to the caller.
 * @returns The keys, or the issue.
 */
export const parseTmfSort = (
  text: string | undefined,
  known: readonly string[]
): Result.Result<readonly TmfSortKey[], QueryIssue> => {
  if (text === undefined) {
    return Result.succeed([]);
  }

  const keys: TmfSortKey[] = [];
  const knownSet = new Set(known);

  for (const raw of text.split(",")) {
    const item = raw.trim();
    const descending = item.startsWith("-");

    const name =
      item.startsWith("-") || item.startsWith("+") ? item.slice(1) : item;

    if (name === "") {
      return Result.fail({ kind: "malformed", parameter: "sort" });
    }

    if (!knownSet.has(name)) {
      return Result.fail({ attribute: name, kind: "unknownAttribute" });
    }

    keys.push({ attribute: name, descending });
  }

  return Result.succeed(keys);
};
