/**
 * The generic record endpoints of `/api/v1` (Contracts 10.1 to 10.5).
 */
import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/http-api";

import { FormState, FormStateRequest } from "./form-state.ts";
import {
  ChangeEntry,
  JsonPatchOperation,
  Resource,
  ResourceCreate,
  ResourcePatch,
} from "./resource.ts";
import { READ_ERRORS, WRITE_ERRORS } from "./tmf-error.ts";

const table = { table: Schema.String } as const;
const ITEM_PATH = "/:table/:id";
const tableAndId = { id: Schema.String, table: Schema.String } as const;

/** The list query. Attribute filters are further, open-ended parameters. */
export const ListQuery = {
  after: Schema.optionalKey(Schema.String),
  allowedFor: Schema.optionalKey(Schema.String),
  before: Schema.optionalKey(Schema.String),
  condition: Schema.optionalKey(Schema.String),
  count: Schema.optionalKey(Schema.String),
  fields: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.String),
  offset: Schema.optionalKey(Schema.String),
  sort: Schema.optionalKey(Schema.String),
} as const;

const ifMatch = { "if-match": Schema.String } as const;

/** A history list's named query parameters (Contracts 3.7, 10.4). */
export const HistoryQuery = {
  actor: Schema.optionalKey(Schema.String),
  after: Schema.optionalKey(Schema.String),
  before: Schema.optionalKey(Schema.String),
  count: Schema.optionalKey(Schema.String),
  field: Schema.optionalKey(Schema.String),
  fields: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.String),
  offset: Schema.optionalKey(Schema.String),
  since: Schema.optionalKey(Schema.String),
  until: Schema.optionalKey(Schema.String),
} as const;

/** The collections and their resources. */
export class RecordsGroup extends HttpApiGroup.make("records").add(
  HttpApiEndpoint.get("list", "/:table", {
    error: READ_ERRORS,
    params: table,
    query: ListQuery,
    success: Schema.Array(Resource),
  }).annotate(
    OpenApi.Description,
    "A page of the table's resources. Besides the named parameters, any attribute name filters by equality (`status=spare`), with the operator forms of Contracts 10.3. `fields` selects attributes and one-hop paths (`!name` excludes), `sort` lists attribute names (`-` descending), `condition` takes STD's condition text syntax with API names. `allowedFor=<collection>/<attribute>` narrows to what a reference attribute may point at (decision 0020). `after` and `before` are cursors, `offset` and `limit` (1 to 1000, default 100) page by position; `count=false` drops `X-Total-Count` on cursor pages."
  ),
  HttpApiEndpoint.post("create", "/:table", {
    error: WRITE_ERRORS,
    params: table,
    payload: ResourceCreate,
    success: Resource.pipe(HttpApiSchema.status(201)),
  }),
  HttpApiEndpoint.get("get", ITEM_PATH, {
    error: READ_ERRORS,
    params: tableAndId,
    query: { fields: Schema.optionalKey(Schema.String) },
    success: Resource,
  }),
  HttpApiEndpoint.patch("patch", ITEM_PATH, {
    error: WRITE_ERRORS,
    headers: ifMatch,
    params: tableAndId,
    payload: [
      ResourcePatch.pipe(
        HttpApiSchema.asJson({ contentType: "application/merge-patch+json" })
      ),
      Schema.Array(JsonPatchOperation).pipe(
        HttpApiSchema.asJson({ contentType: "application/json-patch+json" })
      ),
    ],
    success: Resource,
  }).annotate(
    OpenApi.Description,
    "Changes a resource. The body is an RFC 7396 merge patch (`application/merge-patch+json`) or an RFC 6902 operation list (`application/json-patch+json`); `If-Match` carries the revision the change is based on."
  ),
  HttpApiEndpoint.delete("delete", ITEM_PATH, {
    error: WRITE_ERRORS,
    headers: ifMatch,
    params: tableAndId,
    success: HttpApiSchema.NoContent,
  }),
  HttpApiEndpoint.post("formState", "/checkFormState", {
    error: WRITE_ERRORS,
    payload: FormStateRequest,
    success: FormState,
  }),
  HttpApiEndpoint.get("history", `${ITEM_PATH}/history`, {
    error: READ_ERRORS,
    params: tableAndId,
    query: HistoryQuery,
    success: Schema.Array(ChangeEntry),
  }).annotate(
    OpenApi.Description,
    "The record's change entries the caller may see (Contracts 3.7, 10.4). Besides the named parameters, ChangeEntry attributes filter with the operator forms of 10.3: `action`, `kind`, `revision` and `creationDate` with `.gt`/`.gte`/`.lt`/`.lte`, `revisedBy.id`. `after` and `before` are version keyset cursors; `count=false` omits totals on cursor pages. History requests without cursors or count retain offset navigation."
  ),
  HttpApiEndpoint.get("historyEntry", `${ITEM_PATH}/history/:changeId`, {
    error: READ_ERRORS,
    params: { ...tableAndId, changeId: Schema.String },
    query: { fields: Schema.optionalKey(Schema.String) },
    success: ChangeEntry,
  })
) {}
