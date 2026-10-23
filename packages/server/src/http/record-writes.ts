/**
 * `If-Match` on the API's writes (Contracts 6.7, 10.5): `PATCH` and
 * `DELETE` name the version they are based on as `If-Match: "<version>"`;
 * a missing header is `428 VersionRequired` and changes nothing, a
 * malformed one `400 InvalidRequest`.
 */
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { VersionRequired } from "@std/api/errors/version-required";
import { Effect } from "effect";

const IF_MATCH = /^"(?<version>0|[1-9]\d{0,15})"$/u;

/**
 * The version an `If-Match` header states (Contracts 6.7).
 *
 * @param header - The header value, if any.
 * @returns The version; `VersionRequired` when missing, `InvalidRequest`
 *   when malformed.
 */
export const expectedVersionOf = Effect.fn("Http.ifMatch")(
  function* expectedVersionOf(header: string | undefined) {
    if (header === undefined) {
      return yield* new VersionRequired();
    }

    const version = IF_MATCH.exec(header.trim())?.groups?.version;

    return version === undefined
      ? yield* new InvalidRequest({
          message: 'Expected If-Match: "<version>".',
          parameter: "If-Match",
        })
      : Number(version);
  }
);
