/** Reserved service identities and roles cannot be repurposed by record clients. */
import { NotAllowed } from "@std/api/errors/not-allowed";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import {
  HELPDESK_CASCADE_ROLE_ID,
  HELPDESK_CASCADE_USER_ID,
  USER_CLASS_ID,
  USER_FIELD_IDS,
  USER_ROLE_CLASS_ID,
  USER_ROLE_FIELD_IDS,
} from "@std/definitions/well-known";
import { Effect, Option, Predicate } from "effect";

import type { StoredRecord } from "../records/stored-record.ts";
import { isReservedServiceLogin } from "./service-identities.ts";
import { ServiceIdentityProvisioning } from "./service-identity-provisioning.ts";

/** Refuses protected writes; internal system provisioning is audited by the pipeline. */
export const protectServiceIdentity = Effect.fn("Auth.protectServiceIdentity")(
  function* protectServiceIdentity(
    snapshot: ConfigSnapshot,
    classId: string,
    id: string | undefined,
    values: ReadonlyMap<string, unknown>,
    existing?: StoredRecord,
    operation: "write" | "delete" = "write"
  ): Effect.fn.Return<void, NotAllowed> {
    if (
      Option.isSome(yield* Effect.serviceOption(ServiceIdentityProvisioning))
    ) {
      return yield* Effect.void;
    }

    const lineage = new Set(snapshot.lineage(classId).map((entry) => entry.id));

    if (lineage.has(USER_CLASS_ID)) {
      const login = values.get(USER_FIELD_IDS.login);

      const protectsIdentity =
        id === HELPDESK_CASCADE_USER_ID &&
        (existing === undefined ||
          operation === "delete" ||
          [
            USER_FIELD_IDS.login,
            USER_FIELD_IDS.name,
            USER_FIELD_IDS.active,
            USER_FIELD_IDS.password,
          ].some((fieldId) => values.has(fieldId)));

      if (
        protectsIdentity ||
        (Predicate.isString(login) && isReservedServiceLogin(login))
      ) {
        return yield* new NotAllowed();
      }
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
