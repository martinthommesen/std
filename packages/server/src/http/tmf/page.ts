import { InvalidFilter } from "@std/api/errors/invalid-filter";
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { UnknownField } from "@std/api/errors/unknown-field";
import { isJsonArray, isJsonObject } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { alternativesOf } from "../v2/query.ts";
import { jsonAnswer } from "../v2/records.ts";

const CONTROL = new Set([
  "fields",
  "offset",
  "limit",
  "after",
  "sort",
  "count",
]);

const COMPARISONS = new Set(["eq", "gt", "gte", "lt", "lte"]);
const IDENTITY = new Set(["id", "href", "@type"]);
const HUB_IDENTITY = new Set(["id", "href", "@type", "callback"]);

/**
 * Field selection after authorization preserves resource identity.
 * @param resource - Authorized representation.
 * @param fields - Requested attributes, or all.
 * @returns The selected representation.
 */
export const selectFields = (
  resource: JsonObject,
  fields: string | null
): JsonObject => {
  if (fields === null) {
    return resource;
  }

  const names = fields.split(",");
  const required = resource["@type"] === "Hub" ? HUB_IDENTITY : IDENTITY;

  const excluded = new Set(
    names.flatMap((name) => (name.startsWith("!") ? [name.slice(1)] : []))
  );

  const included = new Set(names.filter((name) => !name.startsWith("!")));

  return Object.fromEntries(
    Object.entries(resource).filter(
      ([name]) =>
        required.has(name) ||
        (!excluded.has(name) && (included.size === 0 || included.has(name)))
    )
  );
};

const matches = (
  value: JsonValue | undefined,
  expected: readonly string[],
  comparison: string
): boolean => {
  if (
    value === undefined ||
    value === null ||
    isJsonObject(value) ||
    isJsonArray(value)
  ) {
    return false;
  }

  const actual = String(value);

  return expected.some((target) => {
    switch (comparison) {
      case "gt": {
        return actual > target;
      }

      case "gte": {
        return actual >= target;
      }

      case "lt": {
        return actual < target;
      }

      case "lte": {
        return actual <= target;
      }

      default: {
        return actual === target;
      }
    }
  });
};

/**
 * Validate the bounded TMF688 request window before database work.
 * @param params - List query parameters.
 * @returns The permitted window, or undefined.
 */
export const pageBounds = (params: URLSearchParams) => {
  const limit = Number(params.get("limit") ?? "100");
  const offset = Number(params.get("offset") ?? "0");
  const validLimit = Number.isInteger(limit) && limit >= 1 && limit <= 1000;

  const validOffset =
    Number.isInteger(offset) && offset >= 0 && offset + limit <= 1000;

  return validLimit && validOffset ? { limit, offset } : undefined;
};

/** Validate scalar filter attributes and comparisons before reading resources. */
export const validateResourceFilters = Effect.fn(
  "Tmf688.validateResourceFilters"
)(function* validateResourceFilters(
  params: URLSearchParams,
  allowed: ReadonlySet<string>
) {
  const filters = [];

  for (const name of new Set(params.keys())) {
    if (CONTROL.has(name)) {
      continue;
    }

    const [attribute = "", comparison = "eq"] = name.split(".");

    if (!allowed.has(attribute)) {
      return yield* new UnknownField({ field: attribute });
    }

    if (!COMPARISONS.has(comparison) || attribute === "event") {
      return yield* new InvalidFilter({
        issues: [
          {
            message: "Only scalar attributes are filterable.",
            reason: "attributeNotFilterable",
          },
        ],
      });
    }

    const expected = params
      .getAll(name)
      .flatMap((value) => alternativesOf(value));

    filters.push({ attribute, comparison, expected });
  }

  return filters;
});

/** Validate requested fields against the published resource attributes.
 * @param fields - Requested attributes.
 * @param allowed - Published attributes.
 * @returns A field error, or success.
 */
export const validateResourceFields = (
  fields: string | null,
  allowed: ReadonlySet<string>
) => {
  const unknown = (fields ?? "")
    .split(",")
    .filter(Boolean)
    .map((name) => (name.startsWith("!") ? name.slice(1) : name))
    .find((field) => field !== "none" && !allowed.has(field));

  return unknown === undefined
    ? Effect.void
    : Effect.fail(new UnknownField({ field: unknown }));
};

/** Apply validated first-level scalar filters to authorized representations. */
export const filteredResources = Effect.fn("Tmf688.filterResources")(
  function* filteredResources(
    resources: readonly JsonObject[],
    params: URLSearchParams,
    allowed: ReadonlySet<string>
  ) {
    const filters = yield* validateResourceFilters(params, allowed);

    return resources.filter((resource) =>
      filters.every(({ attribute, comparison, expected }) =>
        matches(resource[attribute], expected, comparison)
      )
    );
  }
);

/** Validate a single-resource selection against its published attributes. */
export const selectedResource = Effect.fn("Tmf688.selectedResource")(
  function* selectedResource(
    resource: JsonObject,
    fields: string | null,
    allowed: readonly string[]
  ) {
    yield* validateResourceFields(fields, new Set(allowed));

    return selectFields(resource, fields);
  }
);

/** TMF688's standard offset paging and scalar attribute filters. */
export const pageAnswer = Effect.fn("Tmf688.page")(function* pageAnswer(
  resources: readonly JsonObject[],
  params: URLSearchParams,
  attributes: readonly string[],
  complete = true
) {
  const bounds = pageBounds(params);

  if (bounds === undefined) {
    return yield* new InvalidRequest({
      message: "offset must be nonnegative and limit between 1 and 1000.",
      parameter: "limit",
    });
  }

  if (params.has("after") || params.has("sort")) {
    return yield* new InvalidRequest({
      message: "This resource list uses offset and limit.",
      parameter: "after",
    });
  }

  const allowed = new Set(attributes);
  const selected = yield* filteredResources(resources, params, allowed);
  const fields = params.get("fields");
  yield* validateResourceFields(fields, allowed);

  const page = selected
    .slice(bounds.offset, bounds.offset + bounds.limit)
    .map((resource) => selectFields(resource, fields));

  const headers = {
    "cache-control": "no-store",
    "content-type": "application/json;charset=utf-8",
    "x-result-count": String(page.length),
  };

  return jsonAnswer(
    page,
    200,
    complete === false
      ? headers
      : { ...headers, "x-total-count": String(selected.length) }
  );
});
