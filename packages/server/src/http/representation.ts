import type { JsonValue } from "@std/values/json-value";
import { DateTime, Effect } from "effect";
import { HttpServerResponse } from "effect/http";

import { jsonAnswer } from "./api/records.ts";

/** Internal provenance supplied only by a producer that covers the selected body. */
export interface ModificationMetadata {
  readonly modifiedAt?: DateTime.Utc;
}

/** Serialize a selected body with its known modification time, if any. */
export const jsonAnswerWithMetadata = Effect.fn("Http.jsonAnswerWithMetadata")(
  function* jsonAnswerWithMetadata(
    body: JsonValue,
    status: number,
    metadata: ModificationMetadata,
    headers: Readonly<Record<string, string>> = {}
  ) {
    const response = jsonAnswer(body, status, headers);

    if (metadata.modifiedAt === undefined) {
      return response;
    }

    const originatedAt = yield* DateTime.now;

    // RFC 9110 8.8.2.1: a known future source is clamped to the same
    // origination instant used for Date. HTTP dates have second precision.
    return HttpServerResponse.setHeaders(response, {
      date: DateTime.toDateUtc(originatedAt).toUTCString(),
      "last-modified": DateTime.toDateUtc(
        DateTime.min(metadata.modifiedAt, originatedAt)
      ).toUTCString(),
    });
  }
);
