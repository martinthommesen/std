/** Saved filter translation from one caller-visible configuration snapshot. */
import { callerFilterView } from "@std/access/saved-filters";
import { decodeExpr } from "@std/conditions/ast";
import { printCondition } from "@std/conditions/syntax-print";
import { apiAttributeNameOf } from "@std/definitions/names";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import type { MetaSavedFilter } from "@std/definitions/table-metadata";
import { Effect } from "effect";

import type { ActingUser } from "../auth/actor.ts";

/** Translate visible filters; malformed configuration fails the request as a defect. */
export const savedFiltersInApiNames = Effect.fn("Metadata.savedFilterNames")(
  function* savedFiltersInApiNames(
    snapshot: ConfigSnapshot,
    actor: ActingUser,
    classId: string,
    filters: readonly MetaSavedFilter[]
  ) {
    const view = callerFilterView(snapshot, actor);

    const translated: MetaSavedFilter[] = [];

    for (const filter of filters) {
      const expression = decodeExpr(filter.condition);

      if (expression._tag === "Failure") {
        return yield* Effect.die(
          new Error(`Cannot decode saved filter ${filter.id}`)
        );
      }

      const printed = printCondition(expression.success, {
        classId,
        field: (owner, id) => {
          const field = view.field(owner, id);

          return field === undefined
            ? undefined
            : { ...field, name: apiAttributeNameOf(field.name) };
        },
      });

      if (!printed.ok) {
        return yield* Effect.die(
          new Error(`Cannot print saved filter ${filter.id} with API names`)
        );
      }

      translated.push({ ...filter, filter: printed.value });
    }

    return translated;
  }
);
