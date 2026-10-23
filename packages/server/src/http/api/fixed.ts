/**
 * The fixed resources of `/api/v1` (Contracts 10.1):
 *
 * | Route | Answer |
 * | --- | --- |
 * | `POST /api/v1/session` | `201`, the session; `tokenDelivery` `body` or `cookie` |
 * | `GET`, `DELETE /api/v1/session/current` | `200` the session, `204` signed out |
 * | `GET /api/v1/tableMetadata` | `200`, the tables the caller can open |
 * | `GET /api/v1/tableMetadata/{table}` | `200`, a table's metadata, fields with API names |
 * | `GET /api/v1/tableMetadata/{table}/schema.json` | the caller's JSON Schema of the table's resource |
 * | `GET /api/v1/tableMetadata/{table}/openapi.json` | the caller's OpenAPI 3.1 document of the table's record routes |
 * | `GET /api/v1/openapi.json` | this API's OpenAPI 3.1 document, no session |
 *
 * They run like their v1 counterparts: sign-in and the session check the
 * stated revision naming no field (6.4), sign-out only its format; the
 * session cookie and its CSRF rule are v1's (decision 0018), its path now
 * `/api`. No fixed resource's name is a table's v2 name: definition
 * validation refuses it (`apiNameClash`).
 */
import { tableList, tableMetadata } from "@std/access/table-metadata";
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { UnknownTable } from "@std/api/errors/unknown-table";
import { WEB_CLIENT, WEB_CLIENT_HEADER } from "@std/api/session-cookie";
import { SessionToken } from "@std/api/session-token";
import { apiAttributeNameOf } from "@std/definitions/names";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import type {
  MetaField,
  MetaTable,
  MetaTableSummary,
} from "@std/definitions/table-metadata";
import { USER_CLASS_ID } from "@std/definitions/well-known";
import { formatDateTime } from "@std/values/date-time";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Plaintext } from "@std/values/write-only";
import { Effect, Layer, Redacted } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import { Actor } from "../../auth/actor.ts";
import type { ActingUser } from "../../auth/actor.ts";
import { displayName, signIn, signOut } from "../../auth/sessions.ts";
import { Catalog } from "../../catalog/catalog.ts";
import type { InstanceSettings } from "../../config/instance-settings.ts";
import { currentReadScope } from "../../records/read-records.ts";
import { savedFiltersInApiNames } from "../../records/saved-filter-names.ts";
import { RequestRevision } from "../../sql/request-revision.ts";
import { Transactions } from "../../sql/transactions.ts";
import { DEFINITION_KIND_OF_TABLE } from "../change-sets.ts";
import { genericWriteLimits } from "../metadata-limits.ts";
import { asActor, inRequestTransaction } from "../request-scope.ts";
import { revisionHeaderValue } from "../schema-revision-header.ts";
import { clearSessionCookie, setSessionCookie } from "../session-cookie.ts";
import {
  checkUnscopedRevision,
  parseRequestRevision,
} from "../stale-request.ts";
import { tableOpenApi } from "../table-openapi.ts";
import { answered } from "./answered.ts";
import { getAndHead } from "./methods.ts";
import { apiOpenApi } from "./openapi.ts";
import { jsonAnswer } from "./records.ts";
import { checkedSessionCreate } from "./request-schemas.ts";
import { jsonBodyOf, withSession } from "./request.ts";
import {
  entityRef,
  originOf,
  refTypeOf,
  schemaLocation,
  API_PREFIX,
} from "./resource.ts";
import {
  collectionNameOf,
  tableOfCollection,
  typeNameOf,
} from "./table-names.ts";

const SESSION_PATH = `${API_PREFIX}/session`;
const CURRENT_SESSION = `${SESSION_PATH}/current`;
const METADATA_PATH = `${API_PREFIX}/tableMetadata`;

/** A sign-in body: login, password, and where the token goes. */
interface SessionRequest {
  readonly login: string;
  readonly password: Plaintext;
  readonly tokenDelivery: "body" | "cookie";
}

const invalidBody = () =>
  new InvalidRequest({
    message:
      "A session is created with login, password and tokenDelivery (body or cookie).",
    parameter: "body",
  });

const sessionRequestOf = Effect.fn("Api.sessionRequest")(
  function* sessionRequestOf(body: JsonValue) {
    const fields = isJsonObject(body) ? body : {};
    const login = fields.login ?? null;
    const password = fields.password ?? null;
    const delivery = fields.tokenDelivery ?? "body";

    if (
      isJsonString(login) &&
      isJsonString(password) &&
      (delivery === "body" || delivery === "cookie")
    ) {
      return {
        login,
        password: new Plaintext(password),
        tokenDelivery: delivery,
      } satisfies SessionRequest;
    }

    return yield* invalidBody();
  }
);

const userRef = Effect.fn("Api.userRef")(function* userRef(
  origin: string,
  userId: string,
  label: string | null
) {
  const scope = yield* currentReadScope();

  return entityRef(scope, origin, {
    declaredClassId: USER_CLASS_ID,
    id: userId,
    label,
    targetClassId: USER_CLASS_ID,
  });
});

const STRING_TYPE = "string";

/** The reference `@type` a caller sees for a declared target. */
export interface RefTypes {
  /**
   * The `@type` of a reference to a table metadata names (`<Type>Ref`),
   * or `EntityRef` for null (a target the caller does not know).
   */
  readonly typeOf: (target: string | null) => string;
  /** The `@type` of `createdBy` and `updatedBy`. */
  readonly user: string;
}

const refSchema = (refType: string): JsonObject => ({
  $ref: `#/$defs/${refType}`,
});

// One reference type's definition: an EntityRef whose `@type` is fixed.
const refDefinition = (refType: string): JsonObject => ({
  properties: {
    "@referredType": { type: STRING_TYPE },
    "@type": { const: refType },
    href: { format: "uri", type: STRING_TYPE },
    id: { type: STRING_TYPE },
    name: { type: STRING_TYPE },
  },
  required: ["id"],
  type: "object",
});

/**
 * The JSON Schema type of a field as metadata shows it.
 *
 * @param field - The field's metadata.
 * @param refs - The reference types the caller sees.
 * @returns The JSON Schema of its values.
 */
const typeSchema = (field: MetaField, refs: RefTypes): JsonObject => {
  const { type } = field;

  switch (type.kind) {
    case "integer": {
      return { type: "integer" };
    }

    case "boolean": {
      return { type: "boolean" };
    }

    case "date": {
      return { format: "date", type: STRING_TYPE };
    }

    case "dateTime": {
      return { format: "date-time", type: STRING_TYPE };
    }

    case "uuid": {
      return { format: "uuid", type: STRING_TYPE };
    }

    case "choice": {
      return {
        enum: (field.choices ?? []).map((choice) => choice.key),
        type: STRING_TYPE,
      };
    }

    case "reference": {
      return refSchema(refs.typeOf(type.target));
    }

    case "password":
    case "secret": {
      return {
        properties: { set: { type: "boolean" } },
        type: "object",
      };
    }

    case "json":
    case "condition": {
      return {};
    }

    case "bigInteger":
    case "decimal":
    case "longText":
    case "text": {
      return { type: STRING_TYPE };
    }

    default: {
      return { type: STRING_TYPE };
    }
  }
};

/**
 * The caller's JSON Schema of a table's resource (Contracts 10.2,
 * `@schemaLocation`): built from the same metadata as 6.3, so it names no
 * field the caller cannot read.
 *
 * A reference attribute is a `<Type>Ref` when the caller knows its
 * declared target, else the generic `EntityRef`, as resources show them
 * (Contracts 10.2); the schema defines each type it uses and no other, so
 * it names no table the caller does not know.
 *
 * @param table - The caller's metadata of the table.
 * @param type - The table's type name.
 * @param location - The schema's own URL.
 * @param refs - The reference types the caller sees.
 * @returns The JSON Schema (2020-12).
 */
export const resourceSchema = (
  table: MetaTable,
  type: string,
  location: string,
  refs: RefTypes
): JsonObject => {
  const readable = table.fields.filter((field) => field.read !== "no");

  const properties = Object.fromEntries([
    ["id", { type: STRING_TYPE }],
    ["href", { format: "uri", type: STRING_TYPE }],
    ["@type", { type: STRING_TYPE }],
    ["@baseType", { type: STRING_TYPE }],
    ["@schemaLocation", { format: "uri", type: STRING_TYPE }],
    ["revision", { type: "integer" }],
    ["creationDate", { format: "date-time", type: STRING_TYPE }],
    ["createdBy", refSchema(refs.user)],
    ["lastUpdate", { format: "date-time", type: STRING_TYPE }],
    ["updatedBy", refSchema(refs.user)],
    ...readable.map((field): [string, JsonValue] => [
      apiAttributeNameOf(field.name),
      { ...typeSchema(field, refs), title: field.label },
    ]),
    ["withheld", { items: { type: STRING_TYPE }, type: "array" }],
  ]);

  const used = new Set([
    "EntityRef",
    refs.user,
    ...readable.flatMap((field) =>
      field.type.kind === "reference" ? [refs.typeOf(field.type.target)] : []
    ),
  ]);

  return {
    $defs: Object.fromEntries(
      [...used].toSorted().map((refType) => [refType, refDefinition(refType)])
    ),
    $id: location,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    properties,
    required: ["id", "href", "@type"],
    title: type,
    type: "object",
  };
};

// The stated revision names no field; then the route's work.
const checkedThen = <A, E, R>(
  stated: Parameters<typeof checkUnscopedRevision>[0],
  work: Effect.Effect<A, E, R>
) =>
  Effect.gen(function* checkedWork() {
    yield* checkUnscopedRevision(stated);

    return yield* work;
  });

// The caller's roles as the session shows them.
const rolesOf = (snapshot: ConfigSnapshot, actor: ActingUser) =>
  actor.roleIds.flatMap((roleId) => {
    const role = snapshot.role(roleId);

    return role === undefined
      ? []
      : [{ id: role.id, label: role.label, name: role.name }];
  });

// The table list as TableMetadata summaries.
const tableEntries = (
  snapshot: ConfigSnapshot,
  listed: readonly MetaTableSummary[],
  origin: string
) =>
  listed.flatMap((entry) => {
    const classId = snapshot.classByName(entry.name)?.id;

    if (classId === undefined) {
      return [];
    }

    const collection = collectionNameOf(snapshot, classId);

    return [
      {
        "@type": "TableMetadata",
        creatable: entry.creatable,
        definitionTable: DEFINITION_KIND_OF_TABLE.has(entry.name),
        href: `${origin}${METADATA_PATH}/${collection}`,
        id: collection,
        label: entry.label,
        name: entry.name,
        resourceType: typeNameOf(snapshot, classId),
      },
    ];
  });

/** The fixed routes. */
export const FixedRoutes = Layer.unwrap(
  Effect.gen(function* buildFixedRoutes() {
    const transactions = yield* Transactions;

    const services = yield* Effect.context<
      Catalog | InstanceSettings | Transactions
    >();

    // The caller's metadata of a table by v2 name; `UnknownTable` names
    // the request's segment, whether the table is missing or hidden.
    const metadataOf = Effect.fn("Api.metadataOf")(function* metadataOf(
      collection: string
    ) {
      const snapshot = yield* (yield* Catalog).current;
      const actor = yield* Actor;
      const table = tableOfCollection(snapshot, collection);

      const found =
        table === undefined ? undefined : snapshot.classByName(table);

      const described =
        found === undefined
          ? undefined
          : tableMetadata(
              snapshot,
              actor,
              found.id,
              genericWriteLimits(snapshot)
            );

      return described === undefined || found === undefined
        ? yield* new UnknownTable({ table: collection })
        : { actor, classId: found.id, described, snapshot };
    });

    // A session request, after its stated revision: one request
    // transaction as the session's `Actor` (when `actor`).
    const inRequest = <A, E, R>(
      request: HttpServerRequest,
      effect: Effect.Effect<A, E, R>
    ) => inRequestTransaction(transactions, request, effect);

    const createSession = (request: HttpServerRequest) =>
      Effect.gen(function* createSessionRoute() {
        const stated = yield* parseRequestRevision(request);
        const origin = yield* originOf(request);

        const body = yield* sessionRequestOf(
          yield* checkedSessionCreate(yield* jsonBodyOf(request))
        );

        // A cookie sign-in is the web app's: without `STD-Client: web` it
        // is refused before any session exists, so a cross-site form cannot
        // sign a browser in (login CSRF; decision 0018).
        if (
          body.tokenDelivery === "cookie" &&
          request.headers[WEB_CLIENT_HEADER] !== WEB_CLIENT
        ) {
          return yield* new InvalidRequest({
            message: "A cookie sign-in needs the header STD-Client: web.",
            parameter: "STD-Client",
          });
        }

        const session = yield* inRequest(
          request,
          Effect.gen(function* signInRequest() {
            yield* checkUnscopedRevision(stated);

            return yield* signIn(
              yield* (yield* Catalog).current,
              body.login,
              body.password
            );
          })
        );

        if (body.tokenDelivery === "cookie") {
          yield* setSessionCookie(session.token, session.expiresAt);
        }

        const token =
          body.tokenDelivery === "body"
            ? { token: Redacted.value(session.token) }
            : {};

        const href = `${origin}${CURRENT_SESSION}`;

        return jsonAnswer(
          {
            "@type": "Session",
            expiresAt: formatDateTime(session.expiresAt),
            href,
            id: "current",
            tokenDelivery: body.tokenDelivery,
            user: {
              "@referredType": "CoreUser",
              "@type": "EntityRef",
              id: session.userId,
            },
            ...token,
          },
          201,
          { location: href }
        );
      });

    const currentSession = (request: HttpServerRequest) =>
      withSession(
        request,
        Effect.gen(function* currentSessionRoute() {
          const stated = yield* parseRequestRevision(request);
          const origin = yield* originOf(request);

          return yield* inRequest(
            request,
            asActor(
              Effect.gen(function* currentSessionRequest() {
                yield* checkUnscopedRevision(stated);

                const actor = yield* Actor;
                const snapshot = yield* (yield* Catalog).current;
                const { revision } = yield* RequestRevision;
                const name = yield* displayName(snapshot, actor.userId);

                const roles = rolesOf(snapshot, actor);

                return jsonAnswer(
                  {
                    "@type": "Session",
                    href: `${origin}${CURRENT_SESSION}`,
                    id: "current",
                    name,
                    roles,
                    schemaRevision: revision,
                    user: yield* userRef(origin, actor.userId, name),
                  },
                  200
                );
              })
            )
          );
        })
      );

    const endSession = (request: HttpServerRequest) =>
      withSession(
        request,
        Effect.gen(function* endSessionRoute() {
          // The format is checked; staleness never keeps a session alive.
          yield* parseRequestRevision(request);

          return yield* inRequest(
            request,
            asActor(
              Effect.gen(function* endSessionRequest() {
                const token = yield* SessionToken;

                yield* signOut(token);
                yield* clearSessionCookie(token);

                return HttpServerResponse.empty({ status: 204 });
              })
            )
          );
        })
      );

    // A metadata read: session, stated revision (naming no field), one
    // request transaction as the `Actor`.
    const metadataRoute =
      <E, R>(
        work: (
          origin: string,
          collection: string
        ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
      ) =>
      (request: HttpServerRequest) =>
        withSession(
          request,
          Effect.gen(function* metadataRequest() {
            const params = yield* HttpRouter.params;
            const stated = yield* parseRequestRevision(request);
            const origin = yield* originOf(request);

            return yield* inRequest(
              request,
              asActor(checkedThen(stated, work(origin, params.table ?? "")))
            );
          })
        );

    const tables = metadataRoute((origin) =>
      Effect.gen(function* tablesRoute() {
        const snapshot = yield* (yield* Catalog).current;
        const actor = yield* Actor;
        const listed = tableList(snapshot, actor, genericWriteLimits(snapshot));

        const entries = tableEntries(snapshot, listed, origin);

        return jsonAnswer(entries, 200, {
          "x-result-count": String(entries.length),
          "x-total-count": String(entries.length),
        });
      })
    );

    const table = metadataRoute((origin, collection) =>
      Effect.gen(function* tableRoute() {
        const { classId, described, snapshot, actor } =
          yield* metadataOf(collection);

        const { revision } = yield* RequestRevision;

        return jsonAnswer(
          {
            ...described,
            "@type": "TableMetadata",
            classId: described.id,
            definitionTable: DEFINITION_KIND_OF_TABLE.has(described.name),
            fields: described.fields.map((field) => ({
              ...field,
              apiName: apiAttributeNameOf(field.name),
            })),
            href: `${origin}${METADATA_PATH}/${collection}`,
            id: collection,
            resourceType: typeNameOf(snapshot, described.id),
            savedFilters: yield* savedFiltersInApiNames(
              snapshot,
              actor,
              classId,
              described.savedFilters ?? []
            ),
            schemaRevision: revision,
          },
          200
        );
      })
    );

    // The reference types the caller sees; metadata names a target only
    // when the caller knows it.
    const refsOf = Effect.fn("Api.refsOf")(function* refsOf() {
      const snapshot = yield* (yield* Catalog).current;
      const actor = yield* Actor;

      return {
        typeOf: (target: string | null) => {
          const found =
            target === null ? undefined : snapshot.classByName(target);

          return found === undefined
            ? "EntityRef"
            : refTypeOf(snapshot, actor, found.id);
        },
        user: refTypeOf(snapshot, actor, USER_CLASS_ID),
      } satisfies RefTypes;
    });

    const schema = metadataRoute((origin, collection) =>
      Effect.gen(function* schemaRoute() {
        const { classId, described } = yield* metadataOf(collection);
        const snapshot = yield* (yield* Catalog).current;

        return jsonAnswer(
          resourceSchema(
            described,
            typeNameOf(snapshot, classId),
            schemaLocation(origin, collection),
            yield* refsOf()
          ),
          200,
          { "content-type": "application/schema+json" }
        );
      })
    );

    const tableOpenApiRoute = metadataRoute((_origin, collection) =>
      Effect.gen(function* tableOpenApiRequest() {
        const { classId, described } = yield* metadataOf(collection);
        const snapshot = yield* (yield* Catalog).current;
        const state = yield* RequestRevision;

        return jsonAnswer(
          tableOpenApi(
            described,
            { header: revisionHeaderValue(state), revision: state.revision },
            {
              collection,
              refs: yield* refsOf(),
              type: typeNameOf(snapshot, classId),
            }
          ),
          200
        );
      })
    );

    const openApi = (request: HttpServerRequest) =>
      Effect.gen(function* openApiRoute() {
        const stated = yield* parseRequestRevision(request);

        return yield* inRequest(
          request,
          Effect.gen(function* openApiRequest() {
            yield* checkUnscopedRevision(stated);

            return jsonAnswer(apiOpenApi, 200);
          })
        );
      });

    const provided =
      <E, R>(
        handler: (
          request: HttpServerRequest
        ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
      ) =>
      (request: HttpServerRequest) =>
        answered(handler(request)).pipe(Effect.provide(services));

    return HttpRouter.addAll([
      HttpRouter.route("POST", SESSION_PATH, provided(createSession)),
      ...getAndHead(CURRENT_SESSION, provided(currentSession)),
      HttpRouter.route("DELETE", CURRENT_SESSION, provided(endSession)),
      ...getAndHead(METADATA_PATH, provided(tables)),
      ...getAndHead(`${METADATA_PATH}/:table`, provided(table)),
      ...getAndHead(`${METADATA_PATH}/:table/schema.json`, provided(schema)),
      ...getAndHead(
        `${METADATA_PATH}/:table/openapi.json`,
        provided(tableOpenApiRoute)
      ),
      ...getAndHead(`${API_PREFIX}/openapi.json`, provided(openApi)),
    ]);
  })
);
