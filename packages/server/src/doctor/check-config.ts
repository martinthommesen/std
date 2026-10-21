/**
 * `doctor` checks of the configuration tables (Contracts 1.10 checks 6, 7,
 * 8, 9, 10, 16 and the data part of 12). Every query only reads.
 */
import type { Definition } from "@std/definitions/definition";
import { dependenciesOf } from "@std/definitions/dependencies";
import { effectiveJson } from "@std/definitions/effective-json";
import { effectiveField } from "@std/definitions/effective-schema";
import type { EffectiveField } from "@std/definitions/effective-schema";
import type { DefinitionId } from "@std/definitions/ids";
import {
  applyOverrides,
  overridesByRecord,
  sameJson,
} from "@std/definitions/layers";
import type { LayerState, LocalOverride } from "@std/definitions/layers";
import { overrideProblem } from "@std/definitions/overridable";
import type { DefinitionInvalid } from "@std/definitions/problems";
import { resolveSet } from "@std/definitions/set-resolve";
import type { Draft } from "@std/definitions/set-resolve";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { displayName } from "@std/definitions/upgrade-report";
import { USER_CLASS_ID } from "@std/definitions/well-known";
import { maxLengthOf } from "@std/values/field-type";
import { stringifyJson } from "@std/values/json";
import type { JsonObject } from "@std/values/json-value";
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import { jsonColumn, jsonHash, setHash } from "../config/layer-store.ts";
import { readSetDirectory, CORE_SET_DIRECTORY } from "../config/set-files.ts";
import { defaultLiteral, quoteIdent, tableName } from "../schema/sql-text.ts";
import { advisoryClassId, advisoryObjectId, SCHEMA_KEY } from "../sql/locks.ts";
import { decodeRows } from "../sql/rows.ts";
import { readOnly } from "../sql/statement-marks.ts";
import { finding } from "./finding.ts";
import type { Finding } from "./finding.ts";

const decodeCount = decodeRows(Schema.Struct({ n: Schema.String }));

const decodeRevisions = decodeRows(
  Schema.Struct({
    journal: Schema.NullOr(Schema.String),
    revision: Schema.String,
  })
);

const decodeChanges = decodeRows(
  Schema.Struct({ id: Schema.String, state: Schema.String })
);

const decodeSteps = decodeRows(
  Schema.Struct({
    change_id: Schema.String,
    change_state: Schema.String,
    ordinal: Schema.Int,
    state: Schema.String,
  })
);

const schemaKeyHeld = Effect.gen(function* schemaKeyHeld() {
  const sql = yield* SqlClient.SqlClient;

  const [held] = yield* readOnly(sql`
    SELECT count(*)::text AS n FROM pg_locks
    WHERE locktype = 'advisory' AND granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND classid = ${String(advisoryClassId(SCHEMA_KEY))}::oid
      AND objid = ${String(advisoryObjectId(SCHEMA_KEY))}::oid AND objsubid = 1`).pipe(
    Effect.flatMap(decodeCount)
  );

  return Number(held?.n ?? "0") > 0;
});

const changeSetFinding = (
  row: { readonly id: string; readonly state: string },
  running: boolean
): Finding => {
  if (row.state === "needs_attention") {
    return finding(
      6,
      "error",
      "changeSetNeedsAttention",
      `Change set ${row.id} needs attention: fix the cause and run std schema resume ${row.id}, or std schema abandon ${row.id}.`,
      row.id
    );
  }

  return running
    ? finding(
        6,
        "info",
        "changeSetRunning",
        `Change set ${row.id} is being applied by the session holding SCHEMA_KEY.`,
        row.id
      )
    : finding(
        6,
        "error",
        "changeSetInterrupted",
        `Change set ${row.id} was interrupted; std upgrade or a server start resumes it.`,
        row.id
      );
};

/** Step states that fit each change set state. */
const STEP_STATES = {
  abandoned: new Set(["done", "failed", "pending"]),
  applying: new Set(["done", "failed", "pending", "running"]),
  completed: new Set(["done"]),
  needs_attention: new Set(["done", "failed", "pending"]),
} satisfies Readonly<Record<string, ReadonlySet<string>>>;

/**
 * Whether a step's state fits its change set's state.
 *
 * @param change - The change set's state.
 * @param step - The step's state.
 * @returns True when they fit.
 */
const fits = (change: string, step: string): boolean =>
  Object.entries(STEP_STATES).some(
    ([state, steps]) => state === change && steps.has(step)
  );

const stepFinding = (
  row: {
    readonly change_id: string;
    readonly change_state: string;
    readonly ordinal: number;
    readonly state: string;
  },
  running: boolean
): readonly Finding[] => {
  const subject = `${row.change_id}/${row.ordinal}`;

  if (!fits(row.change_state, row.state)) {
    return [
      finding(
        6,
        "error",
        "stepStateInconsistent",
        `Step ${row.ordinal} of change set ${row.change_id} is ${row.state}, which a ${row.change_state} change set cannot have.`,
        subject
      ),
    ];
  }

  return row.state === "running" && !running
    ? [
        finding(
          6,
          "error",
          "stepLeftRunning",
          `Step ${row.ordinal} of change set ${row.change_id} was left running; no session holds SCHEMA_KEY.`,
          subject
        ),
      ]
    : [];
};

/**
 * Check 6: interrupted or `needs_attention` change sets, every step left
 * `running` (whatever its change set's state), and steps whose state does
 * not fit their change set's. A change set `applying` while a session holds
 * `SCHEMA_KEY` is still being applied (informational).
 *
 * @returns The findings.
 */
export const checkChangeSets = Effect.gen(function* checkChangeSets() {
  const sql = yield* SqlClient.SqlClient;
  const running = yield* schemaKeyHeld;

  const changes = yield* readOnly(sql`
    SELECT id::text AS id, state FROM core."schema_change"
    WHERE state IN ('applying', 'needs_attention')
    ORDER BY first_revision`).pipe(Effect.flatMap(decodeChanges));

  const steps = yield* readOnly(sql`
    SELECT s.change_id::text AS change_id, c.state AS change_state, s.ordinal, s.state
    FROM core."schema_change_step" s
    JOIN core."schema_change" c ON c.id = s.change_id
    WHERE s.state <> 'done' OR c.state <> 'completed'
    ORDER BY s.change_id, s.ordinal`).pipe(Effect.flatMap(decodeSteps));

  return [
    ...changes.map((row) => changeSetFinding(row, running)),
    ...steps.flatMap((row) => stepFinding(row, running)),
  ];
});

/**
 * Check 7: `config_state.revision` equals the journal's highest revision.
 *
 * @returns The findings.
 */
export const checkRevision = Effect.gen(function* checkRevision() {
  const sql = yield* SqlClient.SqlClient;

  const [row] = yield* readOnly(sql`
    SELECT s.revision::text AS revision,
           (SELECT max(greatest(first_revision, coalesce(last_revision, first_revision)))::text
            FROM core."schema_change") AS journal
    FROM core.config_state s`).pipe(Effect.flatMap(decodeRevisions));

  const revision = Number(row?.revision ?? "0");
  const journal = Number(row?.journal ?? "0");

  return revision === journal
    ? []
    : [
        finding(
          7,
          "error",
          "revisionMismatch",
          `core.config_state is at revision ${revision}; the journal's highest revision is ${journal}.`,
          "core.config_state"
        ),
      ];
});

const decodeBaseHashes = decodeRows(
  Schema.Struct({
    hash: Schema.String,
    id: Schema.String,
    shipped: Schema.String,
  })
);

const baseEdits = Effect.gen(function* baseEdits() {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* readOnly(sql`
    SELECT id::text AS id, hash, shipped::text AS shipped FROM core."config_base" ORDER BY id`).pipe(
    Effect.flatMap(decodeBaseHashes)
  );

  const found: Finding[] = [];

  for (const row of rows) {
    if (jsonHash(yield* jsonColumn(row.shipped)) !== row.hash) {
      found.push(
        finding(
          8,
          "error",
          "baseEdited",
          `The shipped base of ${row.id} does not match its hash: it was edited outside std upgrade.`,
          row.id
        )
      );
    }
  }

  return found;
});

const effectiveFindings = (
  snapshot: ConfigSnapshot,
  layers: LayerState
): readonly Finding[] => {
  const overrides = overridesByRecord(layers.overrides);

  return [...layers.base.values()].flatMap((base): Finding[] => {
    const definition = snapshot.get(base.id);

    if (definition === undefined) {
      return [
        finding(
          8,
          "error",
          "baseWithoutRecord",
          `The shipped base of ${base.id} has no definition.`,
          base.id
        ),
      ];
    }

    if (base.removed) {
      return [];
    }

    const expected = applyOverrides(base.shipped, overrides.get(base.id));
    const effective = effectiveJson(definition);

    const differing = Object.keys(expected).filter(
      (key) => !sameJson(expected[key], effective[key])
    );

    return differing.length === 0
      ? []
      : [
          finding(
            8,
            "error",
            "effectiveMismatch",
            `The effective record ${displayName(snapshot, definition)} (${base.id}) differs from its base plus overrides in ${differing.join(", ")}.`,
            base.id
          ),
        ];
  });
};

const overrideFindings = (
  snapshot: ConfigSnapshot,
  layers: LayerState
): readonly Finding[] =>
  layers.overrides.flatMap((override): Finding[] => {
    const definition = snapshot.get(override.recordId);
    const base = layers.base.get(override.recordId);

    const problem =
      definition === undefined || base === undefined
        ? "it overrides a record without a shipped base"
        : overrideProblem(
            definition,
            override.property,
            override.value,
            base.shipped[override.property] ?? null
          );

    return problem === undefined
      ? []
      : [
          finding(
            8,
            "error",
            "overrideNotAllowed",
            `The override of ${override.property} on ${override.recordId} is not allowed: ${problem}`,
            override.recordId
          ),
        ];
  });

const unrecorded = (
  snapshot: ConfigSnapshot,
  layers: LayerState
): readonly Finding[] => {
  if (layers.sets.size === 0) {
    return snapshot.definitions().length === 0
      ? []
      : [
          finding(
            8,
            "info",
            "layersNotRecorded",
            "No definition set is recorded in core.config_set yet; std upgrade records the installed sets.",
            null
          ),
        ];
  }

  return snapshot
    .definitions()
    .flatMap((definition) =>
      definition.owner.layer === "local" ||
      definition.state === "purged" ||
      layers.base.has(definition.id)
        ? []
        : [
            finding(
              8,
              "error",
              "recordWithoutBase",
              `The shipped definition ${displayName(snapshot, definition)} (${definition.id}) has no shipped base.`,
              definition.id
            ),
          ]
    );
};

const decodeConflicts = decodeRows(
  Schema.Struct({
    id: Schema.String,
    property: Schema.String,
    record_id: Schema.String,
  })
);

const openConflictFindings = Effect.gen(function* openConflictFindings() {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* readOnly(sql`
    SELECT id::text AS id, record_id::text AS record_id, property
    FROM core."config_conflict" WHERE state = 'open' ORDER BY created_at, id`).pipe(
    Effect.flatMap(decodeConflicts)
  );

  return rows.map((row) =>
    finding(
      8,
      "info",
      "openConflict",
      `Upgrade conflict ${row.id} on ${row.property} of ${row.record_id} is open; resolve it with keep_local, take_shipped or replace.`,
      row.id
    )
  );
});

const decodeViolations = decodeRows(
  Schema.Struct({ ids: Schema.String, n: Schema.String })
);

/** How many violating records an `overrideViolated` finding names. */
const VIOLATION_SAMPLES = 20;

/**
 * The predicate of rows that break a field's effective rules at a class:
 * required, maximum length, numeric bounds.
 *
 * @param field - The effective field at the override's class.
 * @returns SQL conditions over the field's column, ORed.
 */
const violationPredicates = (field: EffectiveField): readonly string[] => {
  const column = quoteIdent(field.field.name);
  const { type } = field;
  const predicates = field.required ? [`${column} IS NULL`] : [];

  if (type.kind === "text" || type.kind === "longText") {
    predicates.push(`char_length(${column}) > ${maxLengthOf(type)}`);
  }

  if (
    type.kind === "integer" ||
    type.kind === "bigInteger" ||
    type.kind === "decimal"
  ) {
    if (type.min !== undefined) {
      predicates.push(`${column} < ${defaultLiteral(type, type.min)}`);
    }

    if (type.max !== undefined) {
      predicates.push(`${column} > ${defaultLiteral(type, type.max)}`);
    }
  }

  return predicates;
};

/**
 * Check 8, data part: records of a class's subtree that break a child-class
 * override (Contracts 2.5) — counted from the records themselves, whatever
 * the override's enforcement state says.
 *
 * @param snapshot - The configuration.
 * @returns The findings.
 */
const overrideViolations = Effect.fn("Doctor.overrideViolations")(
  function* overrideViolations(
    snapshot: ConfigSnapshot
  ): Effect.fn.Return<readonly Finding[], SqlError, SqlClient.SqlClient> {
    const sql = yield* SqlClient.SqlClient;
    const found: Finding[] = [];

    for (const override of snapshot.all("override")) {
      const field = snapshot.field(override.fieldId);

      const owner =
        field === undefined ? undefined : snapshot.class(field.classId);

      if (
        override.state === "active" &&
        field !== undefined &&
        field.state === "active" &&
        owner?.storage === "standard"
      ) {
        const predicates = violationPredicates(
          effectiveField(snapshot, override.classId, field)
        );

        const subtree = snapshot.subtreeIds(override.classId);

        const [row] = yield* readOnly(
          sql.unsafe(
            `SELECT count(*)::text AS n,
                    coalesce((SELECT string_agg(s.id::text, ',' ORDER BY s.id) FROM (
                      SELECT id FROM ${tableName(snapshot, field.classId)} AS v
                      WHERE v.class_id IN (SELECT jsonb_array_elements_text($1::jsonb)::uuid)
                        AND (${predicates.join(" OR ")})
                      ORDER BY id LIMIT ${VIOLATION_SAMPLES}) AS s), '') AS ids
             FROM ${tableName(snapshot, field.classId)} AS t
             WHERE t.class_id IN (SELECT jsonb_array_elements_text($1::jsonb)::uuid)
               AND (${predicates.join(" OR ")})`,
            [stringifyJson(subtree)]
          )
        ).pipe(Effect.flatMap(decodeViolations));

        const count = Number(row?.n ?? "0");

        if (predicates.length > 0 && count > 0) {
          found.push(
            finding(
              8,
              "error",
              "overrideViolated",
              `${count} records violate the ${displayName(snapshot, override)} (for example ${row?.ids ?? ""}).`,
              override.id
            )
          );
        }
      }
    }

    return found;
  }
);

/**
 * Check 8: effective records equal base plus overrides; no override on a
 * non-overridable property; base rows unedited; open conflicts listed
 * (informational: they do not block the system); child-class overrides
 * that records violate (`validate_override` ended `failed`).
 *
 * @param snapshot - The configuration.
 * @param layers - The layer tables.
 * @returns The findings.
 */
export const checkLayers = Effect.fn("Doctor.checkLayers")(
  function* checkLayers(
    snapshot: ConfigSnapshot,
    layers: LayerState,
    layerTables: boolean
  ) {
    const violated = yield* overrideViolations(snapshot);

    if (!layerTables) {
      return violated;
    }

    return [
      ...(yield* baseEdits),
      ...effectiveFindings(snapshot, layers),
      ...overrideFindings(snapshot, layers),
      ...unrecorded(snapshot, layers),
      ...(yield* openConflictFindings),
      ...violated,
    ];
  }
);

const dependencyKey = (from: string, kind: string, to: string): string =>
  `${from} ${kind} ${to}`;

const decodeDependencies = decodeRows(
  Schema.Struct({
    from_id: Schema.String,
    kind: Schema.String,
    to_id: Schema.String,
  })
);

/**
 * Check 9: the dependency index equals a full recomputation, and refers to
 * no unknown IDs.
 *
 * @param snapshot - The configuration.
 * @returns The findings.
 */
export const checkDependencies = Effect.fn("Doctor.checkDependencies")(
  function* checkDependencies(snapshot: ConfigSnapshot) {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* readOnly(sql`
      SELECT from_id::text AS from_id, kind, to_id::text AS to_id
      FROM core.config_dependency ORDER BY from_id, kind, to_id`).pipe(
      Effect.flatMap(decodeDependencies)
    );

    const expected = new Set<string>();

    for (const definition of snapshot.definitions()) {
      for (const edge of dependenciesOf(definition)) {
        expected.add(dependencyKey(edge.fromId, edge.kind, edge.toId));
      }
    }

    const actual = new Set<string>();
    const dangling: Finding[] = [];
    const extra: Finding[] = [];

    for (const row of rows) {
      const key = dependencyKey(row.from_id, row.kind, row.to_id);

      const known =
        snapshot.get(row.from_id) !== undefined &&
        snapshot.get(row.to_id) !== undefined;

      actual.add(key);

      if (!known) {
        dangling.push(
          finding(
            9,
            "error",
            "dependencyDangling",
            `core.config_dependency row ${key} names an unknown definition.`,
            row.from_id
          )
        );
      } else if (!expected.has(key)) {
        extra.push(
          finding(
            9,
            "error",
            "dependencyExtra",
            `core.config_dependency holds ${key}, which no definition implies.`,
            row.from_id
          )
        );
      }
    }

    const missing = [...expected].flatMap((entry) =>
      actual.has(entry)
        ? []
        : [
            finding(
              9,
              "error",
              "dependencyMissing",
              `core.config_dependency lacks ${entry}.`,
              entry.split(" ")[0] ?? null
            ),
          ]
    );

    return [...dangling, ...extra, ...missing];
  }
);

const protectedFinding = (
  snapshot: ConfigSnapshot,
  definition: Definition,
  draft: Draft | undefined,
  overrides: ReadonlyMap<string, LocalOverride> | undefined
): readonly Finding[] => {
  const name = `${displayName(snapshot, definition)} (${definition.id})`;

  if (draft === undefined) {
    return [
      finding(
        10,
        "error",
        "protectedNotShipped",
        `The protected definition ${name} is not in the core set this server ships.`,
        definition.id
      ),
    ];
  }

  const shipped: JsonObject = draft;
  const expected = applyOverrides(shipped, overrides);
  const effective = effectiveJson(definition);

  const same = Object.keys(expected).every((property) =>
    sameJson(expected[property], effective[property])
  );

  return same
    ? []
    : [
        finding(
          10,
          "error",
          "protectedMismatch",
          `The protected definition ${name} differs from the installed core set.`,
          definition.id
        ),
      ];
};

const protectedFindings = (
  snapshot: ConfigSnapshot,
  layers: LayerState,
  shipped: ReadonlyMap<DefinitionId, Draft>
): readonly Finding[] => {
  const overrides = overridesByRecord(layers.overrides);

  return snapshot
    .definitions()
    .flatMap((definition) =>
      definition.protected && definition.state !== "purged"
        ? protectedFinding(
            snapshot,
            definition,
            shipped.get(definition.id),
            overrides.get(definition.id)
          )
        : []
    );
};

/**
 * Check 10: protected definitions match the core set this server ships, by
 * hash, label and help-text overrides applied; a core set that differs
 * from the installed one means `std upgrade` is pending.
 *
 * @param snapshot - The configuration.
 * @param layers - The layer tables.
 * @param coreDirectory - The core set (default: the shipped one).
 * @returns The findings.
 */
export const checkProtected = Effect.fn("Doctor.checkProtected")(
  function* checkProtected(
    snapshot: ConfigSnapshot,
    layers: LayerState,
    coreDirectory: string = CORE_SET_DIRECTORY
  ): Effect.fn.Return<readonly Finding[], DefinitionInvalid> {
    const files = yield* readSetDirectory(coreDirectory);
    const resolved = resolveSet(files, snapshot);

    if (Result.isFailure(resolved)) {
      return yield* resolved.failure;
    }

    const installed = [...layers.sets.values()].find(
      (set) => set.layer === "core"
    );

    const pending =
      installed !== undefined && installed.hash !== setHash(resolved.success)
        ? [
            finding(
              10,
              "warning",
              "coreSetPending",
              `The installed core set (version ${installed.version}) differs from the one this server ships (version ${resolved.success.header.version}); run std upgrade.`,
              installed.id
            ),
          ]
        : [];

    return [
      ...pending,
      ...protectedFindings(
        snapshot,
        layers,
        new Map(resolved.success.drafts.map((draft) => [draft.id, draft]))
      ),
    ];
  }
);

const decodeLatest = decodeRows(
  Schema.Struct({ definition_id: Schema.String, effective: Schema.String })
);

/**
 * Check 16: each definition's latest `core.definition_revision` row equals
 * its effective record (Contracts 4.4).
 *
 * @param snapshot - The configuration.
 * @returns The findings.
 */
export const checkDefinitionRevisions = Effect.fn(
  "Doctor.checkDefinitionRevisions"
)(function* checkDefinitionRevisions(snapshot: ConfigSnapshot) {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* readOnly(sql`
    SELECT DISTINCT ON (definition_id) definition_id::text AS definition_id, effective::text AS effective
    FROM core.definition_revision ORDER BY definition_id, revision DESC`).pipe(
    Effect.flatMap(decodeLatest)
  );

  const latest = new Map(rows.map((row) => [row.definition_id, row.effective]));
  const found: Finding[] = [];

  for (const definition of snapshot.definitions()) {
    const text = latest.get(definition.id);
    const name = `${displayName(snapshot, definition)} (${definition.id})`;

    if (text === undefined) {
      found.push(
        finding(
          16,
          "error",
          "definitionRevisionMissing",
          `The definition ${name} has no definition revision.`,
          definition.id
        )
      );
    } else if (!sameJson(yield* jsonColumn(text), effectiveJson(definition))) {
      found.push(
        finding(
          16,
          "error",
          "definitionRevisionStale",
          `The latest definition revision of ${name} differs from its effective record.`,
          definition.id
        )
      );
    }
  }

  return found;
});

/**
 * Check 12, data part: every record of a non-root class has its lowest
 * level row (Contracts 2.2 item 2).
 *
 * @param snapshot - The configuration.
 * @param existing - Keys (`schema.table`) of tables that exist.
 * @returns The findings.
 */
export const checkLevelRows = Effect.fn("Doctor.checkLevelRows")(
  function* checkLevelRows(
    snapshot: ConfigSnapshot,
    existing: (classId: DefinitionId) => boolean
  ): Effect.fn.Return<readonly Finding[], SqlError, SqlClient.SqlClient> {
    const sql = yield* SqlClient.SqlClient;
    const found: Finding[] = [];

    const classes = snapshot
      .all("class")
      .filter(
        (definition) =>
          definition.parentId !== null &&
          definition.state !== "purged" &&
          definition.storage === "standard"
      );

    for (const definition of classes) {
      const root = snapshot.root(definition.id);

      if (root !== undefined && existing(definition.id) && existing(root.id)) {
        const [row] = yield* readOnly(
          sql.unsafe(
            `SELECT count(*)::text AS n FROM ${tableName(snapshot, root.id)} AS r
             WHERE r.class_id = $1::uuid
               AND NOT EXISTS (SELECT 1 FROM ${tableName(snapshot, definition.id)} AS l WHERE l.id = r.id)`,
            [definition.id]
          )
        ).pipe(Effect.flatMap(decodeCount));

        const count = Number(row?.n ?? "0");

        if (count > 0) {
          found.push(
            finding(
              12,
              "error",
              "missingLevelRow",
              `${count} records of ${snapshot.qualifiedNameOf(definition.id) ?? definition.id} lack their own level row.`,
              definition.id
            )
          );
        }
      }
    }

    return found;
  }
);

/**
 * Check 2, platform part (Contracts 1.9): every audit ID on a platform
 * table names a `core.user` row. Platform tables carry `created_by` and
 * `updated_by` without a foreign key, because they exist before
 * `core.user`.
 *
 * @param snapshot - The configuration.
 * @param existing - Whether a class's table exists.
 * @returns The findings.
 */
export const checkAuditUsers = Effect.fn("Doctor.checkAuditUsers")(
  function* checkAuditUsers(
    snapshot: ConfigSnapshot,
    existing: (classId: DefinitionId) => boolean
  ): Effect.fn.Return<readonly Finding[], SqlError, SqlClient.SqlClient> {
    if (!existing(USER_CLASS_ID)) {
      return [];
    }

    const sql = yield* SqlClient.SqlClient;
    const users = tableName(snapshot, USER_CLASS_ID);
    const found: Finding[] = [];

    const platform = snapshot
      .all("class")
      .filter(
        (definition) =>
          definition.storage === "platform" &&
          definition.parentId === null &&
          existing(definition.id)
      );

    for (const definition of platform) {
      const table = tableName(snapshot, definition.id);

      const [row] = yield* readOnly(
        sql.unsafe(
          `SELECT count(*)::text AS n FROM ${table} AS t
           WHERE NOT EXISTS (SELECT 1 FROM ${users} AS u WHERE u.id = t.created_by)
              OR NOT EXISTS (SELECT 1 FROM ${users} AS u WHERE u.id = t.updated_by)`
        )
      ).pipe(Effect.flatMap(decodeCount));

      const count = Number(row?.n ?? "0");

      if (count > 0) {
        found.push(
          finding(
            2,
            "error",
            "auditUserMissing",
            `${count} rows of ${table} name a created_by or updated_by user that core.user does not hold.`,
            definition.id
          )
        );
      }
    }

    return found;
  }
);
