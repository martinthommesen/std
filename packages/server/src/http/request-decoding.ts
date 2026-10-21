/**
 * The server side of `RequestDecoding` (Contracts 3.8): a request part that
 * does not decode becomes `400 InvalidRequest` naming the part, with a fixed
 * message, so the response never repeats the request's values. Failures to
 * encode a response (`Body`, `ResponseHeaders`) are server bugs and stay
 * 500s.
 */
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { RequestDecoding } from "@std/api/request-decoding";
import { Effect } from "effect";
import { HttpApiMiddleware } from "effect/http-api";

const PARTS = {
  Headers: "headers",
  Params: "path",
  Payload: "body",
  Query: "query",
} as const;

/** The middleware implementation. */
export const RequestDecodingLayer = HttpApiMiddleware.layerSchemaErrorTransform(
  RequestDecoding,
  (failure) => {
    if (failure.kind === "Body" || failure.kind === "ResponseHeaders") {
      return Effect.fail(failure);
    }

    const parameter = PARTS[failure.kind];

    return Effect.fail(
      new InvalidRequest({
        message: `The request ${parameter} does not match this endpoint.`,
        parameter,
      })
    );
  }
);
