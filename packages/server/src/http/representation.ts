import type { JsonValue } from "@std/values/json-value";
import { DateTime, Effect } from "effect";
import { HttpServerResponse } from "effect/http";

import { jsonAnswer } from "./api/records.ts";

/** Internal provenance supplied only by a producer that covers the selected body. */
export interface ModificationMetadata {
  readonly modifiedAt?: DateTime.Utc;
}

const httpDate = (instant: DateTime.Utc, field: "Date" | "Last-Modified") => {
  const date = DateTime.toDateUtc(instant);
  const year = date.getUTCFullYear();

  // RFC 9110 5.6.7 requires four digits and imports RFC 5322 3.3's
  // year >= 1900 semantics. This is a wire constraint, not a stored-date limit.
  if (year < 1900 || year > 9999) {
    throw new RangeError(
      `Cannot serialize ${field} as HTTP-date: year must be 1900..9999; received ${DateTime.formatIso(instant)}.`
    );
  }

  return date.toUTCString();
};

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
      date: httpDate(originatedAt, "Date"),
      "last-modified": httpDate(
        DateTime.min(metadata.modifiedAt, originatedAt),
        "Last-Modified"
      ),
    });
  }
);
