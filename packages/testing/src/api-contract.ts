/**
 * The response contract of `/api/v1`: every response the test client gets
 * from `/api/v1` is checked against the shared `StdApi` definition that
 * `/api/v1/openapi.json` is generated from. The endpoint is found by method
 * and path as the router finds it (literal segments before parameters);
 * the status must be one the endpoint documents, and the body must decode
 * with the endpoint's schemas for that status. A response of no endpoint
 * (an unknown path, a method no route serves) must be a documented TMF
 * `Error` subtype. `HEAD` and `OPTIONS` carry no body and are not checked,
 * nor is a defect (`500` without a body, Contracts 3.8).
 */
import { StdApi } from "@std/api/api";
import { TmfErrorSubtypes } from "@std/api/tmf-error";
import type { JsonValue } from "@std/values/json-value";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import { Effect, Schema } from "effect";
import { HttpApi } from "effect/http-api";

const PREFIX = "/api/v1/";

/** One documented endpoint. */
export interface ApiEndpoint {
  /** `<group>.<endpoint>`, as in the definition. */
  readonly name: string;
  readonly method: string;
  readonly segments: readonly string[];
  readonly successes: ReadonlyMap<number, readonly Schema.Top[]>;
  readonly errors: ReadonlyMap<number, readonly Schema.Top[]>;
}

const collect = (): readonly ApiEndpoint[] => {
  const found: ApiEndpoint[] = [];

  HttpApi.reflect(StdApi, {
    onEndpoint: ({ endpoint, errors, group, successes }) => {
      found.push({
        errors,
        method: endpoint.method,
        name: `${group.identifier}.${endpoint.identifier}`,
        segments: endpoint.path.split("/").slice(1),
        successes,
      });
    },
    onGroup: () => {
      // Groups carry nothing the check needs.
    },
  });

  return found;
};

/** Every endpoint of the definition. */
export const API_ENDPOINTS: readonly ApiEndpoint[] = collect();

const pathSegments = (path: string): readonly string[] =>
  (path.split("?")[0] ?? "").split("/").slice(1);

const literalCount = (endpoint: ApiEndpoint): number =>
  endpoint.segments.filter((segment) => !segment.startsWith(":")).length;

const orderedEndpoints = API_ENDPOINTS.toSorted(
  (left, right) => literalCount(right) - literalCount(left)
);

/**
 * The documented endpoint a request reaches, if any.
 *
 * @param method - The request method.
 * @param path - The request path, with or without a query.
 * @returns The endpoint, or undefined.
 */
export const apiEndpointOf = (
  method: string,
  path: string
): ApiEndpoint | undefined => {
  const segments = pathSegments(path);

  return orderedEndpoints.find(
    (endpoint) =>
      endpoint.method === method &&
      endpoint.segments.length === segments.length &&
      endpoint.segments.every(
        (segment, index) =>
          segments[index] !== "" &&
          (segment.startsWith(":") || segment === segments[index])
      )
  );
};

// Whether a body is a value of one of the schemas. The shared schemas'
// encoded and decoded forms coincide (JSON values), so the type-side check
// is the wire check.
const fitsOneOf = (
  schemas: readonly Schema.Top[],
  body: JsonValue | undefined
): boolean => schemas.some((schema) => Schema.is(schema)(body));

const SUBTYPES: ReadonlyMap<string, Schema.Top> = new Map(
  Object.entries(TmfErrorSubtypes)
);

const errorSubtype = (body: JsonValue | undefined): Schema.Top | undefined => {
  const code = body !== undefined && isJsonObject(body) ? body.code : undefined;

  return code !== undefined && isJsonString(code)
    ? SUBTYPES.get(code)
    : undefined;
};

/** A response as the contract check sees it. */
export interface ApiExchange {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly text: string;
  readonly json: JsonValue | undefined;
}

// A response of no endpoint: a documented TMF Error subtype.
const unroutedProblem = (
  exchange: ApiExchange,
  where: string
): string | undefined => {
  const subtype = errorSubtype(exchange.json);

  if (exchange.status < 400 || subtype === undefined) {
    return `${where}: no endpoint documents it and it is not a TMF Error: ${exchange.text}`;
  }

  return fitsOneOf([subtype], exchange.json)
    ? undefined
    : `${where}: not a documented Error: ${exchange.text}`;
};

// A response of an endpoint: a documented status and a body of its schemas.
const endpointProblem = (
  exchange: ApiExchange,
  endpoint: ApiEndpoint,
  where: string
): string | undefined => {
  const { status } = exchange;
  const documented = status < 400 ? endpoint.successes : endpoint.errors;
  const schemas = documented.get(status);

  if (schemas === undefined) {
    return `${where}: ${endpoint.name} does not document status ${status}: ${exchange.text}`;
  }

  if (status === 204) {
    return exchange.text === "" ? undefined : `${where}: a 204 has a body`;
  }

  return fitsOneOf(schemas, exchange.json)
    ? undefined
    : `${where}: ${endpoint.name} body does not match its schema: ${exchange.text}`;
};

/**
 * What is wrong with one exchange, measured against the definition.
 *
 * @param exchange - The request and its response.
 * @returns A description of the mismatch, or undefined.
 */
export const apiExchangeProblem = (
  exchange: ApiExchange
): string | undefined => {
  const { method, path, status } = exchange;
  const where = `${method} ${path} -> ${status}`;

  // `HEAD` and `OPTIONS` have no body; a defect is `500` without a body
  // (Contracts 3.8), not an answer the definition describes.
  const bodiless = method === "HEAD" || method === "OPTIONS";
  const defect = status === 500 && exchange.text === "";

  if (!path.startsWith(PREFIX) || bodiless || defect) {
    return undefined;
  }

  const endpoint = apiEndpointOf(method, path);

  return endpoint === undefined
    ? unroutedProblem(exchange, where)
    : endpointProblem(exchange, endpoint, where);
};

/**
 * Checks one exchange against the definition.
 *
 * @param exchange - The request and its response.
 * @returns Nothing, or fails with a description of the mismatch.
 */
export const checkApiExchange = (
  exchange: ApiExchange
): Effect.Effect<void, string> => {
  const problem = apiExchangeProblem(exchange);

  return problem === undefined ? Effect.void : Effect.fail(problem);
};
