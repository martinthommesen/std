/**
 * Request decoding failures as API errors (Contracts 3.8): a path, query,
 * header or body that does not match an endpoint's schema, or a body that
 * is not JSON, is answered with a tagged `400 InvalidRequest` naming the
 * part of the request, never with an empty response or the decoder's
 * message (which could repeat the request's values).
 */
import { HttpApiMiddleware } from "effect/http-api";

import { InvalidRequest } from "./errors/invalid-request.ts";

/** Maps request decoding failures to `InvalidRequest`; on every endpoint. */
export class RequestDecoding extends HttpApiMiddleware.Service<RequestDecoding>()(
  "@std/api/request-decoding/RequestDecoding",
  { error: InvalidRequest }
) {}
