/**
 * The response contract of `/api/v2`: every response the test client gets
 * from `/api/v2` is checked against the shared `StdApiV2` definition that
 * `/api/v2/openapi.json` is generated from. The endpoint is found by method
 * and path as the router finds it (literal segments before parameters);
 * the status must be one the endpoint documents, and the body must decode
 * with the endpoint's schemas for that status. A response of no endpoint
 * (an unknown path, a method no route serves) must be a documented TMF
 * `Error` subtype. `HEAD` and `OPTIONS` carry no body and are not checked,
 * nor is a defect (`500` without a body, Contracts 3.8).
 */
import { StdApiV2 } from "@std/api/v2/api";
import { TmfErrorSubtypes } from "@std/api/v2/tmf-error";
import type { JsonValue } from "@std/values/json-value";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import { Effect, Schema } from "effect";
import { HttpApi } from "effect/http-api";

const PREFIX = "/api/v2/";

/** One documented endpoint. */
export interface V2Endpoint {
  /** `<group>.<endpoint>`, as in the definition. */
  readonly name: string;
  readonly method: string;
  readonly segments: readonly string[];
  readonly successes: ReadonlyMap<number, readonly Schema.Top[]>;
  readonly errors: ReadonlyMap<number, readonly Schema.Top[]>;
}

const collect = (): readonly V2Endpoint[] => {
  const found: V2Endpoint[] = [];

  HttpApi.reflect(StdApiV2, {
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
export const V2_ENDPOINTS: readonly V2Endpoint[] = collect();

const pathSegments = (path: string): readonly string[] =>
  (path.split("?")[0] ?? "").split("/").slice(1);

const literalCount = (endpoint: V2Endpoint): number =>
  endpoint.segments.filter((segment) => !segment.startsWith(":")).length;

/**
 * The documented endpoint a request reaches, if any.
 *
 * @param method - The request method.
 * @param path - The request path, with or without a query.
 * @returns The endpoint, or undefined.
 */
export const v2EndpointOf = (
  method: string,
  path: string
): V2Endpoint | undefined => {
  const segments = pathSegments(path);

  const candidates = V2_ENDPOINTS.filter(
    (endpoint) =>
      endpoint.method === method &&
      endpoint.segments.length === segments.length &&
      endpoint.segments.every(
        (segment, index) =>
          segments[index] !== "" &&
          (segment.startsWith(":") || segment === segments[index])
      )
  );

  return candidates.toSorted(
    (left, right) => literalCount(right) - literalCount(left)
  )[0];
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
export interface V2Exchange {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly text: string;
  readonly json: JsonValue | undefined;
}

// A response of no endpoint: a documented TMF Error subtype.
const unroutedProblem = (
  exchange: V2Exchange,
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
  exchange: V2Exchange,
  endpoint: V2Endpoint,
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
export const v2ExchangeProblem = (exchange: V2Exchange): string | undefined => {
  const { method, path, status } = exchange;
  const where = `${method} ${path} -> ${status}`;

  // `HEAD` and `OPTIONS` have no body; a defect is `500` without a body
  // (Contracts 3.8), not an answer the definition describes.
  const bodiless = method === "HEAD" || method === "OPTIONS";
  const defect = status === 500 && exchange.text === "";

  if (!path.startsWith(PREFIX) || bodiless || defect) {
    return undefined;
  }

  const endpoint = v2EndpointOf(method, path);

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
export const checkV2Exchange = (
  exchange: V2Exchange
): Effect.Effect<void, string> => {
  const problem = v2ExchangeProblem(exchange);

  return problem === undefined ? Effect.void : Effect.fail(problem);
};
