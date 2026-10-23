/** Reserved service identities and roles cannot be repurposed by record clients. */
import { NotAllowed } from "@std/api/errors/not-allowed";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import {
  HELPDESK_CASCADE_ROLE_ID,
  HELPDESK_CASCADE_USER_ID,
  SYSTEM_USER_ID,
  USER_CLASS_ID,
  USER_FIELD_IDS,
  USER_ROLE_CLASS_ID,
  USER_ROLE_FIELD_IDS,
} from "@std/definitions/well-known";
import { Effect } from "effect";

import type { StoredRecord } from "../records/stored-record.ts";
import { Actor } from "./actor.ts";

/** Refuses protected writes; internal system provisioning is audited by the pipeline. */
export const protectServiceIdentity = Effect.fn("Auth.protectServiceIdentity")(
  function* protectServiceIdentity(
    snapshot: ConfigSnapshot,
    classId: string,
    id: string | undefined,
    values: ReadonlyMap<string, unknown>,
    existing?: StoredRecord,
    operation: "write" | "delete" = "write"
  ): Effect.fn.Return<void, NotAllowed, Actor> {
    if ((yield* Actor).userId === SYSTEM_USER_ID) {
      return yield* Effect.void;
    }

    const lineage = new Set(snapshot.lineage(classId).map((entry) => entry.id));

    const changesCredentials =
      operation === "delete" ||
      values.has(USER_FIELD_IDS.active) ||
      values.has(USER_FIELD_IDS.password);

    if (
      lineage.has(USER_CLASS_ID) &&
      id === HELPDESK_CASCADE_USER_ID &&
      changesCredentials
    ) {
      return yield* new NotAllowed();
    }

    if (lineage.has(USER_ROLE_CLASS_ID)) {
      const protectedAssignment = [values, existing?.values].some(
        (fields) =>
          fields?.get(USER_ROLE_FIELD_IDS.user) === HELPDESK_CASCADE_USER_ID ||
          fields?.get(USER_ROLE_FIELD_IDS.role) === HELPDESK_CASCADE_ROLE_ID
      );

      if (protectedAssignment) {
        return yield* new NotAllowed();
      }
    }

    return yield* Effect.void;
  }
);
