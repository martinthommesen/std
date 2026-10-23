/**
 * Statuses on TMF routes (Contracts 11.1; decision 0021, decisions 52 and
 * 55): a TMF route answers only the statuses its pinned OpenAPI document
 * declares for the operation. STD's errors keep their tags (the TMF
 * `Error`'s `code`) and take the nearest declared status:
 *
 * - the status STD's own API gives (Contracts 3.8, 10.6) when declared;
 * - a stale `If-Match` (`VersionConflict`): `412` when declared, else `409`
 *   (TMF621 declares `409` for `PATCH` and `DELETE`: decision 55);
 * - any other client error: `400` (`ValidationFailed` and
 *   `InvalidReference`, whose `422` no TMF document declares, as decision
 *   52 says; and every other undeclared `4xx`, such as
 *   `SchemaChanged` (409) on a `GET` [judgment: 400 is declared by every TMF
 *   operation and is the generic client error]);
 * - any other server error: `500`.
 */

/** The status of a stale `If-Match` on STD's own API (`/api/v2`). */
const STALE_STATUS = 412;

const CONFLICT = 409;
const BAD_REQUEST = 400;
const SERVER_ERROR = 500;
const FIRST_SERVER_ERROR = 500;

/**
 * The status a TMF route answers for an STD error.
 *
 * @param tag - The error's tag (`VersionConflict`, `ValidationFailed`).
 * @param status - Its status on STD's own API.
 * @param declared - The statuses the operation declares.
 * @returns A declared status (or `status` when nothing fits, which the
 *   contract test then reports).
 */
export const tmfStatusFor = (
  tag: string,
  status: number,
  declared: readonly number[]
): number => {
  const has = (candidate: number) => declared.includes(candidate);

  if (has(status)) {
    return status;
  }

  if (tag === "VersionConflict" || status === STALE_STATUS) {
    if (has(STALE_STATUS)) {
      return STALE_STATUS;
    }

    if (has(CONFLICT)) {
      return CONFLICT;
    }
  }

  if (status >= FIRST_SERVER_ERROR) {
    return has(SERVER_ERROR) ? SERVER_ERROR : status;
  }

  return has(BAD_REQUEST) ? BAD_REQUEST : status;
};
