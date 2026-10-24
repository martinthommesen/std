import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

/** Base path of the pinned TMF688 swagger (checked against pins.json). */
export const TMF688_PREFIX = "/tmf-api/event/v4";

const extension = Schema.Record(Schema.String, Schema.Json);

/** TMF688 Event, strengthened with the conformance profile's mandatory fields. */
export const TmfEvent = Schema.StructWithRest(
  Schema.Struct({
    "@type": Schema.String,
    event: Schema.Json,
    eventId: Schema.String,
    eventTime: Schema.String.annotate({ format: "date-time" }),
    eventType: Schema.String,
    href: Schema.String,
    id: Schema.String,
  }),
  [extension]
);

/** TMF688 Topic. */
export const Topic = Schema.StructWithRest(
  Schema.Struct({
    href: Schema.String,
    id: Schema.String,
    name: Schema.String,
  }),
  [extension]
);

/** TMF688 permits a callback-only registration. */
export const TmfHubCreate = Schema.Struct({
  "@type": Schema.optionalKey(Schema.String),
  callback: Schema.String,
  query: Schema.optionalKey(Schema.String),
});

/** TMF688 Topic_Create, requiring name as the conformance profile does. */
export const TopicCreate = Schema.Struct({
  "@type": Schema.optionalKey(Schema.String),
  contentQuery: Schema.optionalKey(Schema.String),
  headerQuery: Schema.optionalKey(Schema.String),
  name: Schema.NonEmptyString,
});

/** Event_Create with the profile's required attributes and nested references. */
export const EventCreate = Schema.StructWithRest(
  Schema.Struct({
    "@type": Schema.NonEmptyString,
    analyticCharacteristic: Schema.optionalKey(
      Schema.Array(
        Schema.StructWithRest(
          Schema.Struct({ name: Schema.String, value: Schema.Json }),
          [extension]
        )
      )
    ),
    event: Schema.Record(Schema.String, Schema.Json),
    eventId: Schema.NonEmptyString,
    eventTime: Schema.optionalKey(
      Schema.String.annotate({ format: "date-time" })
    ),
    eventType: Schema.NonEmptyString,
    relatedParty: Schema.optionalKey(
      Schema.Array(
        Schema.StructWithRest(
          Schema.Struct({ "@referredType": Schema.String, id: Schema.String }),
          [extension]
        )
      )
    ),
    reportingSystem: Schema.optionalKey(
      Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [extension])
    ),
    source: Schema.optionalKey(
      Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [extension])
    ),
  }),
  [extension]
);

const error = Schema.Struct({
  code: Schema.String,
  reason: Schema.String,
  status: Schema.String,
});

const errors = [400, 401, 403, 404, 405, 409, 429, 500].map((status) =>
  error.pipe(HttpApiSchema.status(status))
);

const Hub = Schema.StructWithRest(
  Schema.Struct({ callback: Schema.String, id: Schema.String }),
  [extension]
);

const topicParams = { topicId: Schema.String };
const itemParams = { id: Schema.String, topicId: Schema.String };

/** The pinned TMF688 resource operations, shared with its HTTP implementation. */
export class Tmf688Group extends HttpApiGroup.make("tmf688").add(
  HttpApiEndpoint.get("listTopics", "/topic", {
    error: errors,
    success: Schema.Array(Topic),
  }),
  HttpApiEndpoint.post("createTopic", "/topic", {
    error: errors,
    payload: TopicCreate,
    success: Topic.pipe(HttpApiSchema.status(201)),
  }),
  HttpApiEndpoint.get("getTopic", "/topic/:id", {
    error: errors,
    params: { id: Schema.String },
    success: Topic,
  }),
  HttpApiEndpoint.delete("deleteTopic", "/topic/:id", {
    error: errors,
    params: { id: Schema.String },
    success: HttpApiSchema.NoContent,
  }),
  HttpApiEndpoint.get("listEvents", "/topic/:topicId/event", {
    error: errors,
    params: topicParams,
    success: Schema.Array(TmfEvent),
  }),
  HttpApiEndpoint.post("createEvent", "/topic/:topicId/event", {
    error: errors,
    params: topicParams,
    payload: EventCreate,
    success: TmfEvent.pipe(HttpApiSchema.status(201)),
  }),
  HttpApiEndpoint.get("getEvent", "/topic/:topicId/event/:id", {
    error: errors,
    params: itemParams,
    success: TmfEvent,
  }),
  HttpApiEndpoint.get("listHubs", "/topic/:topicId/hub", {
    error: errors,
    params: topicParams,
    success: Schema.Array(Hub),
  }),
  HttpApiEndpoint.post("createHub", "/topic/:topicId/hub", {
    error: errors,
    params: topicParams,
    payload: TmfHubCreate,
    success: Hub.pipe(HttpApiSchema.status(201)),
  }),
  HttpApiEndpoint.get("getHub", "/topic/:topicId/hub/:id", {
    error: errors,
    params: itemParams,
    success: Hub,
  }),
  HttpApiEndpoint.delete("deleteHub", "/topic/:topicId/hub/:id", {
    error: errors,
    params: itemParams,
    success: HttpApiSchema.NoContent,
  }),
  HttpApiEndpoint.post("register", "/hub", {
    error: errors,
    payload: TmfHubCreate,
    success: Hub.pipe(HttpApiSchema.status(201)),
  }),
  HttpApiEndpoint.get("retrieve", "/hub/:id", {
    error: errors,
    params: { id: Schema.String },
    success: Hub,
  }),
  HttpApiEndpoint.delete("unregister", "/hub/:id", {
    error: errors,
    params: { id: Schema.String },
    success: HttpApiSchema.NoContent,
  })
) {}
