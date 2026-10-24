import { FieldsConflict } from "@std/api/errors/fields-conflict";
import { InvalidFilter } from "@std/api/errors/invalid-filter";
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { UnknownField } from "@std/api/errors/unknown-field";
import { parseTmfFields } from "@std/tmf/query";
import { IDENTITY_ATTRIBUTES } from "@std/tmf/render";
import { isJsonArray, isJsonObject } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Result } from "effect";

import { alternativesOf } from "../api/query.ts";
import { jsonAnswer } from "../api/records.ts";

/** TMF688 list directives, excluded from scalar resource filters. */
export const CONTROL: ReadonlySet<string> = new Set([
  "fields",
  "offset",
  "limit",
  "after",
  "sort",
  "count",
]);

const COMPARISONS = new Set(["eq", "gt", "gte", "lt", "lte"]);
const HUB_IDENTITY = new Set([...IDENTITY_ATTRIBUTES, "callback"]);

/** A validated scalar filter on a published resource attribute. */
export interface ResourceFilter {
  readonly attribute: string;
  readonly comparison: string;
  readonly expected: readonly string[];
}

/**
 * Field selection after authorization preserves resource identity.
 * @param resource - Authorized representation.
 * @param fields - Validated selected attributes, or all.
 * @returns The selected representation.
 */
export const selectFields = (
  resource: JsonObject,
  fields: ReadonlySet<string> | null
): JsonObject => {
  if (fields === null) {
    return resource;
  }

  const required =
    resource["@type"] === "Hub" ? HUB_IDENTITY : IDENTITY_ATTRIBUTES;

  return Object.fromEntries(
    Object.entries(resource).filter(
      ([name]) => required.has(name) || fields.has(name)
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
  const filters: ResourceFilter[] = [];

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

/** Parse requested fields against the published resource attributes.
 * @param fields - Requested attributes.
 * @param allowed - Published attributes.
 * @returns The selected attributes (null: all), or a field error.
 */
export const resourceFields = Effect.fn("Tmf688.resourceFields")(
  function* resourceFields(
    fields: string | null,
    allowed: ReadonlySet<string>
  ) {
    const parsed = parseTmfFields(fields ?? undefined, [...allowed]);

    if (Result.isSuccess(parsed)) {
      return parsed.success;
    }

    const issue = parsed.failure;

    if (issue.kind === "unknownAttribute") {
      return yield* new UnknownField({ field: issue.attribute });
    }

    if (issue.kind === "conflict") {
      return yield* new FieldsConflict({ field: issue.attribute });
    }

    return yield* new InvalidRequest({
      message: "fields lists attribute names.",
      parameter: "fields",
    });
  }
);

/**
 * Whether an authorized representation satisfies all validated scalar filters.
 * @param resource - The authorized representation.
 * @param filters - Validated scalar filters.
 * @returns Whether every filter matches.
 */
export const matchesResourceFilters = (
  resource: JsonObject,
  filters: readonly ResourceFilter[]
): boolean =>
  filters.every(({ attribute, comparison, expected }) =>
    matches(resource[attribute], expected, comparison)
  );

/** Validate and apply first-level scalar filters to authorized representations. */
export const filteredResources = Effect.fn("Tmf688.filterResources")(
  function* filteredResources(
    resources: readonly JsonObject[],
    params: URLSearchParams,
    allowed: ReadonlySet<string>
  ) {
    const filters = yield* validateResourceFilters(params, allowed);

    return resources.filter((resource) =>
      matchesResourceFilters(resource, filters)
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
    return selectFields(
      resource,
      yield* resourceFields(fields, new Set(allowed))
    );
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
  const fields = yield* resourceFields(params.get("fields"), allowed);

  const page = selected
    .slice(bounds.offset, bounds.offset + bounds.limit)
    .map((resource) => selectFields(resource, fields));

  const headers = {
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
