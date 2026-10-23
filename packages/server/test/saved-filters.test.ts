/**
 * Saved list filters as layered config records (decision 0019; Contracts
 * 1.7, 6.3, 8.2): `core.saved_filter` rows written through the generic
 * routes and the change-set endpoint as change sets, validated under the
 * `filter` profile, served in the metadata only to callers who may name
 * every field they read, and tied into the dependency rules: retiring a
 * field one reads is allowed and reported (the filter is no longer
 * served), purging that field is refused while the filter lives, and a
 * table purge takes its filters along.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import type { Requester } from "@std/definitions/requester";
import { TableMetadataSchema } from "@std/definitions/table-metadata";
import { BUILT_IN_ROLE_IDS } from "@std/definitions/well-known";
import type { JsonObject } from "@std/values/json-value";
import { Effect, Schema } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import { arrayOf, objectOf, signInAll, textOf } from "./authz-support.ts";
import { committedState } from "./committed-state.ts";
import { readsTestLayer } from "./reads-support.ts";
import {
  ACME,
  addField,
  change,
  createClass,
  ensureSite,
  values,
} from "./schema-support.ts";

const PURGER: Requester = {
  roleIds: [BUILT_IN_ROLE_IDS.schema_purger],
  userId: randomUUID(),
};

const decodeMetadata = Schema.decodeUnknownEffect(TableMetadataSchema);

const filtersOf = Effect.fn("SavedFilters.filtersOf")(function* filtersOf(
  token: string,
  table: string
) {
  const http = yield* TestHttpClient;
  const response = yield* http.get(`/api/v1/meta/tables/${table}`, { token });
  const body = yield* decodeMetadata(response.json).pipe(Effect.orDie);

  return (body.table.savedFilters ?? []).map(
    (filter) => `${filter.name}: ${filter.filter}`
  );
});

const versionOf = (id: string) =>
  Effect.gen(function* readVersion() {
    return (yield* (yield* Catalog).refresh).get(id)?.version ?? 0;
  });

/**
 * Purges a retired field or table as the purger.
 *
 * @param id - The definition.
 * @returns The change set's exit.
 */
const purge = (id: string) =>
  Effect.gen(function* purgeDefinition() {
    const version = yield* versionOf(id);

    return yield* Effect.exit(
      applyChangeSet({
        operations: [{ confirm: { id, version }, id, op: "purge", version }],
        requester: PURGER,
      })
    );
  });

const filterBody = (
  name: string,
  classId: string,
  condition: JsonObject
): JsonObject => ({
  condition,
  label: name,
  name,
  table_id: classId,
});

const notEmpty = (fieldId: string) => ({
  arg: { path: [fieldId] },
  op: "notEmpty" as const,
});

describe("saved-filters", () => {
  it("writes a saved filter's body by column", () => {
    assert.deepStrictEqual(filterBody("lost", ACME.asset, { op: "true" }), {
      condition: { op: "true" },
      label: "lost",
      name: "lost",
      table_id: ACME.asset,
    });
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "served only to callers who may read every field they name, as list API filter text",
      () =>
        Effect.gen(function* served() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;

          for (const body of [
            filterBody("lost", ACME.asset, {
              left: { path: [ACME.status] },
              op: "eq",
              right: { value: "lost" },
            }),
            filterBody("pricey", ACME.asset, {
              left: { path: [ACME.cost] },
              op: "gt",
              right: { value: "1000" },
            }),
            filterBody("serials", ACME.laptop, notEmpty(ACME.serial)),
          ]) {
            const created = yield* http.request(
              "POST",
              "/api/v1/tables/core.saved_filter/records",
              { body, token: tokens.admin }
            );

            assert.strictEqual(created.status, 201, created.text);
          }

          // Bob never reads `cost`: `pricey` is not his, so his metadata
          // names neither the field nor the filter.
          assert.deepStrictEqual(yield* filtersOf(tokens.alice, "acme.asset"), [
            'lost: status = "lost"',
            "pricey: cost > 1000",
          ]);
          assert.deepStrictEqual(yield* filtersOf(tokens.bob, "acme.asset"), [
            'lost: status = "lost"',
          ]);

          // A child endpoint serves its ancestors' filters, root first.
          assert.deepStrictEqual(
            yield* filtersOf(tokens.alice, "acme.laptop"),
            [
              'lost: status = "lost"',
              "pricey: cost > 1000",
              "serials: serial is not empty",
            ]
          );
        })
    );

    dbTest.effect(
      "invalid saved filters are refused through both paths and change nothing",
      () =>
        Effect.gen(function* invalid() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;

          yield* change([
            {
              definition: {
                classId: ACME.asset,
                condition: notEmpty(ACME.name),
                id: randomUUID(),
                kind: "savedFilter",
                label: "Named",
                name: "named",
                owner: { layer: "local" },
                protected: false,
              },
              op: "createSavedFilter",
            },
          ]);

          const cases: readonly {
            readonly name: string;
            readonly filterName: string;
            readonly condition: JsonObject;
          }[] = [
            {
              condition: notEmpty(ACME.serial),
              filterName: "child_field",
              name: "a child's field on the parent",
            },
            {
              condition: { arg: { path: [ACME.name] }, op: "changed" },
              filterName: "changed",
              name: "an operator the filter profile refuses",
            },
            {
              condition: notEmpty(ACME.name),
              filterName: "named",
              name: "a name the table's filters already use",
            },
            {
              condition: notEmpty(ACME.name),
              filterName: "Not An Identifier",
              name: "a name that is not an identifier",
            },
          ];

          for (const entry of cases) {
            const before = yield* committedState;

            const generic = yield* http.request(
              "POST",
              "/api/v1/tables/core.saved_filter/records",
              {
                body: filterBody(entry.filterName, ACME.asset, entry.condition),
                token: tokens.admin,
              }
            );

            const endpoint = yield* http.request(
              "POST",
              "/api/v1/schema/change-sets",
              {
                body: {
                  operations: [
                    {
                      definition: {
                        classId: ACME.asset,
                        condition: entry.condition,
                        id: randomUUID(),
                        kind: "savedFilter",
                        label: entry.filterName,
                        name: entry.filterName,
                        owner: { layer: "local" },
                        protected: false,
                      },
                      op: "createSavedFilter",
                    },
                  ],
                },
                token: tokens.admin,
              }
            );

            for (const response of [generic, endpoint]) {
              assert.strictEqual(
                response.status,
                422,
                `${entry.name}: ${response.text}`
              );
              assert.strictEqual(
                objectOf(response.json)._tag,
                "DefinitionInvalid",
                entry.name
              );
            }

            assert.deepStrictEqual(yield* committedState, before, entry.name);
          }
        })
    );

    dbTest.effect(
      "retiring a field a saved filter reads is reported, its purge refused until the filter is deleted; a table purge takes filters along",
      () =>
        Effect.gen(function* lifecycle() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;

          yield* ensureSite;

          const scratch = createClass("filtered");
          const label = addField(scratch.id, "label", { kind: "text" });
          const extra = addField(scratch.id, "extra", { kind: "text" });
          const filterId = randomUUID();
          const tableFilterId = randomUUID();

          yield* change([scratch.op, label.op, extra.op]);
          yield* change([
            {
              definition: {
                classId: scratch.id,
                condition: notEmpty(extra.id),
                id: filterId,
                kind: "savedFilter",
                label: "Extra",
                name: "with_extra",
                owner: { layer: "local" },
                protected: false,
              },
              op: "createSavedFilter",
            },
            {
              definition: {
                classId: scratch.id,
                condition: notEmpty(label.id),
                id: tableFilterId,
                kind: "savedFilter",
                label: "Labelled",
                name: "labelled",
                owner: { layer: "local" },
                protected: false,
              },
              op: "createSavedFilter",
            },
          ]);

          assert.deepStrictEqual(
            yield* filtersOf(tokens.admin, "site.filtered"),
            ["labelled: label is not empty", "with_extra: extra is not empty"]
          );

          // Retire: allowed, the filter reported, no longer served.
          const retired = yield* http.request(
            "PATCH",
            `/api/v1/tables/core.field/records/${extra.id}`,
            {
              body: { state: "retired" },
              headers: { "if-match": `"${yield* versionOf(extra.id)}"` },
              token: tokens.admin,
            }
          );

          assert.strictEqual(retired.status, 200, retired.text);

          const [journal] = yield* values(
            `SELECT operations::text AS value FROM core.schema_change
             ORDER BY first_revision DESC NULLS LAST LIMIT 1`
          );

          assert.include(journal ?? "", filterId);
          assert.deepStrictEqual(
            yield* filtersOf(tokens.admin, "site.filtered"),
            ["labelled: label is not empty"]
          );

          // Purge: refused while the filter lives.
          const refused = yield* purge(extra.id);

          assert.isTrue(refused._tag === "Failure");
          assert.include(JSON.stringify(refused), "DependencyConflict");
          assert.include(JSON.stringify(refused), filterId);

          const deleted = yield* http.request(
            "DELETE",
            `/api/v1/tables/core.saved_filter/records/${filterId}`,
            {
              headers: { "if-match": `"${yield* versionOf(filterId)}"` },
              token: tokens.admin,
            }
          );

          assert.strictEqual(deleted.status, 200, deleted.text);
          assert.strictEqual((yield* purge(extra.id))._tag, "Success");

          // A table purge takes its remaining filter along.
          yield* change([
            {
              id: scratch.id,
              op: "retire",
              version: yield* versionOf(scratch.id),
            },
          ]);

          assert.strictEqual((yield* purge(scratch.id))._tag, "Success");

          const snapshot = yield* (yield* Catalog).refresh;

          assert.strictEqual(snapshot.get(tableFilterId)?.state, "purged");
          assert.strictEqual(snapshot.get(filterId)?.state, "purged");
        })
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "through /api/v2 a saved filter is written as a change set and served in API names, as condition takes it",
      () =>
        Effect.gen(function* servedInApiNames() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;

          const inService = addField(ACME.asset, "in_service", {
            kind: "text",
          });

          yield* change([inService.op]);

          const created = yield* http.request(
            "POST",
            "/api/v2/coreSavedFilter",
            {
              body: {
                condition: notEmpty(inService.id),
                label: "In service",
                name: "in_service_set",
                tableId: ACME.asset,
              },
              token: tokens.admin,
            }
          );

          assert.strictEqual(created.status, 201, created.text);
          assert.deepStrictEqual(yield* filtersOf(tokens.admin, "acme.asset"), [
            "in_service_set: in_service is not empty",
          ]);

          const metadata = yield* http.get("/api/v2/tableMetadata/acmeAsset", {
            token: tokens.admin,
          });

          const [saved] = arrayOf(objectOf(metadata.json).savedFilters).map(
            (filter) => objectOf(filter)
          );

          assert.strictEqual(saved?.filter, "inService is not empty");

          const listed = yield* http.get(
            `/api/v2/acmeAsset?condition=${encodeURIComponent(textOf(saved?.filter))}`,
            { token: tokens.admin }
          );

          assert.strictEqual(listed.status, 200, listed.text);
        })
    );
  });
});
