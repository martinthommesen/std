/**
 * Choices, choice-subset overrides, layouts and auto-number prefixes
 * (plan Step 2, decision 0017) in memory: validation, dependencies, the
 * effective schema, lifecycle cascades, set files and the shared field
 * rules.
 */
import { assert, describe, it } from "@effect/vitest";
import { isFailure, isSuccess } from "effect/Result";

import { applyOperations } from "../src/apply.ts";
import type {
  ChoiceDefinition,
  Definition,
  FieldDefinition,
  LayoutDefinition,
  LayoutElement,
} from "../src/definition.ts";
import { dependenciesOf } from "../src/dependencies.ts";
import {
  effectiveChoices,
  effectiveFields,
  effectiveLayout,
} from "../src/effective-schema.ts";
import type { Operation } from "../src/operation.ts";
import type { ProblemCode } from "../src/problems.ts";
import {
  absentCreateValue,
  convertCreate,
  convertUpdate,
  fieldErrorsOf,
  fieldRulesOf,
  writtenOnCreate,
} from "../src/record-rules.ts";
import type { FieldRules } from "../src/record-rules.ts";
import { setOrigin, SYSTEM_REQUESTER } from "../src/requester.ts";
import type { NamedSetFile, SetFile } from "../src/set-file.ts";
import { planSet } from "../src/set-plan.ts";
import { decodeSetFile, resolveSet } from "../src/set-resolve.ts";
import { ConfigSnapshot } from "../src/snapshot.ts";
import { validateSnapshot } from "../src/validate.ts";
import {
  field,
  freshId,
  KEY,
  namespace,
  purgeAuthorization,
  override,
  snapshotOf,
  table,
} from "./fixtures.ts";

const NEXT = { changeSetId: KEY.changeSetId, revision: 2 };

const local = { owner: { layer: "local" }, protected: false } as const;

const choice = (
  owner: FieldDefinition,
  key: string,
  order: number,
  extra: Partial<ChoiceDefinition> = {}
): ChoiceDefinition => ({
  ...local,
  fieldId: owner.id,
  hidden: false,
  id: freshId(),
  key,
  kind: "choice",
  label: key.toUpperCase(),
  order,
  state: "active",
  version: 1,
  ...extra,
});

const layout = (
  classId: string,
  type: "form" | "list",
  elements: readonly LayoutElement[]
): LayoutDefinition => ({
  ...local,
  classId,
  elements,
  id: freshId(),
  kind: "layout",
  state: "active",
  type,
  version: 1,
});

const fieldElement = (target: FieldDefinition): LayoutElement => ({
  fieldId: target.id,
  kind: "field",
});

const world = () => {
  const ns = namespace("helpdesk");
  const ticket = table(ns, "ticket");
  const incident = table(ns, "incident", ticket);
  const major = table(ns, "major", incident);
  const status = field(ticket, "status", { kind: "choice" });
  const title = field(ticket, "title", { kind: "text" });
  const impact = field(incident, "impact", { kind: "integer" });

  const number = field(
    ticket,
    "number",
    { kind: "text", maxLength: 40 },
    { numberPrefix: "TKT" }
  );

  const open = choice(status, "open", 1);
  const pending = choice(status, "pending", 2);
  const closed = choice(status, "closed", 3);
  const legacy = choice(status, "legacy", 4, { hidden: true });

  const definitions: Definition[] = [
    ns,
    ticket,
    incident,
    major,
    status,
    title,
    impact,
    number,
    open,
    pending,
    closed,
    legacy,
  ];

  return {
    closed,
    definitions,
    impact,
    incident,
    legacy,
    major,
    number,
    open,
    pending,
    snapshot: snapshotOf(definitions),
    status,
    ticket,
    title,
  };
};

const codes = (definitions: readonly Definition[]): readonly ProblemCode[] =>
  validateSnapshot(snapshotOf(definitions)).map((entry) => entry.code);

const rulesFor = (
  snapshot: ConfigSnapshot,
  classId: string,
  fieldId: string
): FieldRules => {
  const found = effectiveFields(snapshot, classId).find(
    (entry) => entry.field.id === fieldId
  );

  if (found === undefined) {
    throw new Error(`no field ${fieldId} on ${classId}`);
  }

  return fieldRulesOf(snapshot, found);
};

describe("choices", () => {
  it("validates choices: a choice field, the key format and unique live keys", () => {
    const w = world();

    assert.deepStrictEqual(codes(w.definitions), []);
    assert.include(
      codes([...w.definitions, choice(w.status, "Open", 5)]),
      "invalidChoice"
    );
    assert.include(
      codes([...w.definitions, choice(w.status, "open", 5)]),
      "duplicateName"
    );
    assert.include(
      codes([...w.definitions, choice(w.title, "x", 1)]),
      "invalidChoice"
    );
    // A purged choice frees its key.
    assert.deepStrictEqual(
      codes([
        ...w.definitions,
        choice(w.status, "open", 5, { state: "purged" }),
      ]),
      []
    );
  });

  it("orders choices by order then key and keeps hidden ones as retired", () => {
    const w = world();
    const [status] = effectiveFields(w.snapshot, w.ticket.id);

    assert.deepStrictEqual(
      w.snapshot.choicesOf(w.status.id).map((entry) => entry.key),
      ["open", "pending", "closed", "legacy"]
    );

    if (status !== undefined) {
      assert.deepStrictEqual(
        effectiveChoices(w.snapshot, status).map((entry) => entry.key),
        ["open", "pending", "closed", "legacy"]
      );
    }

    const rules = rulesFor(w.snapshot, w.ticket.id, w.status.id);

    assert.deepStrictEqual(
      [...(rules.choices?.active ?? [])],
      ["open", "pending", "closed"]
    );
    assert.deepStrictEqual([...(rules.choices?.retired ?? [])], ["legacy"]);
  });

  it("a choice default must be a live, visible choice inside the subset", () => {
    const w = world();

    const withDefault = (value: string) =>
      w.definitions.map((entry) =>
        entry.id === w.status.id ? { ...w.status, default: value } : entry
      );

    assert.deepStrictEqual(codes(withDefault("open")), []);
    assert.include(codes(withDefault("legacy")), "invalidDefault");
    assert.include(codes(withDefault("nosuch")), "invalidDefault");

    const narrowed = override(w.incident, w.status, { choices: ["pending"] });

    assert.include(codes([...withDefault("open"), narrowed]), "invalidDefault");
  });

  it("depends on its field (choice_of)", () => {
    const w = world();

    assert.deepStrictEqual(dependenciesOf(w.open), [
      { fromId: w.open.id, kind: "choice_of", toId: w.status.id },
    ]);
  });
});

describe("choice-subset overrides", () => {
  it("narrow the parent's choices and stack top down", () => {
    const w = world();

    const onIncident = override(w.incident, w.status, {
      choices: ["open", "closed", "legacy"],
    });

    const onMajor = override(w.major, w.status, { choices: ["closed"] });

    const definitions = [...w.definitions, onIncident, onMajor];
    const snapshot = snapshotOf(definitions);

    assert.deepStrictEqual(codes(definitions), []);

    const keysOf = (classId: string) => {
      const status = effectiveFields(snapshot, classId).find(
        (entry) => entry.field.id === w.status.id
      );

      return status === undefined
        ? []
        : effectiveChoices(snapshot, status).map((entry) => entry.key);
    };

    assert.deepStrictEqual(keysOf(w.ticket.id), [
      "open",
      "pending",
      "closed",
      "legacy",
    ]);
    assert.deepStrictEqual(keysOf(w.incident.id), ["open", "closed", "legacy"]);
    assert.deepStrictEqual(keysOf(w.major.id), ["closed"]);
  });

  it("refuse loosening, unknown keys, duplicates, empty lists and other types", () => {
    const w = world();
    const onIncident = override(w.incident, w.status, { choices: ["open"] });

    assert.include(
      codes([
        ...w.definitions,
        onIncident,
        override(w.major, w.status, { choices: ["open", "closed"] }),
      ]),
      "overrideLoosens"
    );
    assert.include(
      codes([
        ...w.definitions,
        override(w.incident, w.status, { choices: ["nosuch"] }),
      ]),
      "overrideInvalid"
    );
    assert.include(
      codes([
        ...w.definitions,
        override(w.incident, w.status, { choices: ["open", "open"] }),
      ]),
      "overrideInvalid"
    );
    assert.include(
      codes([
        ...w.definitions,
        override(w.incident, w.status, { choices: [] }),
      ]),
      "overrideInvalid"
    );
    assert.include(
      codes([
        ...w.definitions,
        override(w.incident, w.title, { choices: ["open"] }),
      ]),
      "overrideInvalid"
    );
  });

  it("the shared rules accept only the subset, keep an unchanged retired key and refuse it when new", () => {
    const w = world();

    const snapshot = snapshotOf([
      ...w.definitions,
      override(w.incident, w.status, { choices: ["open", "legacy"] }),
    ]);

    const parent = rulesFor(snapshot, w.ticket.id, w.status.id);
    const child = rulesFor(snapshot, w.incident.id, w.status.id);

    assert.isTrue(convertCreate(parent, "pending").ok);

    const refused = convertCreate(child, "pending");

    assert.isFalse(refused.ok);

    if (!refused.ok) {
      assert.strictEqual(refused.error.reason, "unknownChoice");
    }

    assert.isTrue(convertCreate(child, "open").ok);

    const retired = convertCreate(child, "legacy");

    assert.isFalse(retired.ok);

    if (!retired.ok) {
      assert.strictEqual(retired.error.reason, "retiredChoice");
    }

    assert.isTrue(convertUpdate(child, "legacy", "legacy").ok);
    assert.isFalse(convertUpdate(child, "legacy", "open").ok);
    assert.isTrue(convertUpdate(child, null, "legacy").ok);
  });
});

describe("layouts", () => {
  it("names fields of the table's lineage once; list layouts hold fields only", () => {
    const w = world();

    const valid = layout(w.incident.id, "form", [
      { kind: "section", label: "Main" },
      fieldElement(w.title),
      fieldElement(w.impact),
    ]);

    assert.deepStrictEqual(codes([...w.definitions, valid]), []);

    assert.include(
      codes([
        ...w.definitions,
        layout(w.ticket.id, "form", [fieldElement(w.impact)]),
      ]),
      "invalidLayout"
    );
    assert.include(
      codes([
        ...w.definitions,
        layout(w.ticket.id, "list", [
          fieldElement(w.title),
          fieldElement(w.title),
        ]),
      ]),
      "invalidLayout"
    );
    assert.include(
      codes([
        ...w.definitions,
        layout(w.ticket.id, "list", [{ kind: "section", label: "x" }]),
      ]),
      "invalidLayout"
    );
    assert.include(
      codes([
        ...w.definitions,
        layout(w.ticket.id, "list", [fieldElement(w.title)]),
        layout(w.ticket.id, "list", [fieldElement(w.status)]),
      ]),
      "duplicateName"
    );
    // A purged field's entry stays valid: layout entries never block a purge.
    assert.deepStrictEqual(
      codes([
        ...w.definitions.map((entry) =>
          entry.id === w.title.id
            ? { ...w.title, state: "purged" as const }
            : entry
        ),
        layout(w.ticket.id, "list", [fieldElement(w.title)]),
      ]),
      []
    );
  });

  it("a child without its own layout uses its nearest ancestor's, replaced as a whole", () => {
    const w = world();
    const ticketList = layout(w.ticket.id, "list", [fieldElement(w.title)]);

    const incidentList = layout(w.incident.id, "list", [
      fieldElement(w.impact),
    ]);

    const ticketForm = layout(w.ticket.id, "form", [fieldElement(w.status)]);

    const snapshot = snapshotOf([
      ...w.definitions,
      ticketList,
      incidentList,
      ticketForm,
    ]);

    assert.strictEqual(
      effectiveLayout(snapshot, w.ticket.id, "list")?.id,
      ticketList.id
    );
    assert.strictEqual(
      effectiveLayout(snapshot, w.incident.id, "list")?.id,
      incidentList.id
    );
    assert.strictEqual(
      effectiveLayout(snapshot, w.major.id, "list")?.id,
      incidentList.id
    );
    assert.strictEqual(
      effectiveLayout(snapshot, w.major.id, "form")?.id,
      ticketForm.id
    );
    assert.deepStrictEqual(
      dependenciesOf(incidentList),
      [
        {
          fromId: incidentList.id,
          kind: "layout_uses" as const,
          toId: w.incident.id,
        },
        {
          fromId: incidentList.id,
          kind: "layout_uses" as const,
          toId: w.impact.id,
        },
      ].toSorted((a, b) => (a.toId < b.toId ? -1 : 1))
    );
  });
});

const {
  context: asPurger,
  grant: PURGE_GRANT,
  permission: PURGE_PERMISSION,
  role: PURGER,
} = purgeAuthorization();

describe("ui-config lifecycle", () => {
  it("a field purge takes its choices along and keeps the layout entry; a retire reports the layout", () => {
    const w = world();

    const list = layout(w.ticket.id, "list", [
      fieldElement(w.title),
      fieldElement(w.status),
    ]);

    const snapshot = snapshotOf([
      ...w.definitions,
      list,
      PURGE_PERMISSION,
      PURGER,
      PURGE_GRANT,
    ]);

    const retired = applyOperations(
      snapshot,
      [{ id: w.status.id, op: "retire", version: 1 }],
      NEXT
    );

    assert.isTrue(isSuccess(retired));

    if (!isSuccess(retired)) {
      return;
    }

    assert.include(
      retired.success.notes[0]?.reported.map((entry) => entry.id) ?? [],
      list.id
    );

    const purged = applyOperations(
      retired.success.after,
      [
        {
          confirm: { id: w.status.id, version: 2 },
          id: w.status.id,
          op: "purge",
          version: 2,
        },
      ],
      { ...NEXT, revision: 3 },
      asPurger
    );

    assert.isTrue(
      isSuccess(purged),
      isFailure(purged) ? purged.failure.message : ""
    );

    if (!isSuccess(purged)) {
      return;
    }

    const { after } = purged.success;

    for (const entry of [w.open, w.pending, w.closed, w.legacy]) {
      assert.strictEqual(after.get(entry.id)?.state, "purged");
    }

    assert.strictEqual(after.get(list.id)?.state, "active");
    assert.lengthOf(after.choicesOf(w.status.id), 0);
  });

  it("refuses switching auto-numbering on or off; the prefix may change", () => {
    const w = world();

    const change = (changes: Operation) =>
      applyOperations(w.snapshot, [changes], NEXT);

    assert.isTrue(
      isSuccess(
        change({
          changes: { numberPrefix: "TCK" },
          id: w.number.id,
          op: "update",
          version: 1,
        })
      )
    );
    assert.isTrue(
      isFailure(
        change({
          changes: { numberPrefix: null },
          id: w.number.id,
          op: "update",
          version: 1,
        })
      )
    );
    assert.isTrue(
      isFailure(
        change({
          changes: { numberPrefix: "TTL" },
          id: w.title.id,
          op: "update",
          version: 1,
        })
      )
    );
  });
});

describe("auto-number prefixes", () => {
  it("only on text fields with room for the number, without default or required", () => {
    const w = world();

    const replace = (next: FieldDefinition) =>
      codes(
        w.definitions.map((entry) => (entry.id === next.id ? next : entry))
      );

    assert.include(
      replace({ ...w.number, type: { kind: "integer" } }),
      "invalidAutoNumber"
    );
    assert.include(
      replace({ ...w.number, type: { kind: "text", maxLength: 20 } }),
      "invalidAutoNumber"
    );
    assert.include(
      replace({ ...w.number, numberPrefix: "1X" }),
      "invalidAutoNumber"
    );
    // A prefix ending in a digit could read as another prefix's number.
    assert.include(
      replace({ ...w.number, numberPrefix: "A1" }),
      "invalidAutoNumber"
    );
    assert.notInclude(
      replace({ ...w.number, numberPrefix: "A1-" }),
      "invalidAutoNumber"
    );
    assert.notInclude(
      replace({ ...w.number, numberPrefix: "A" }),
      "invalidAutoNumber"
    );
    assert.include(
      replace({ ...w.number, required: true }),
      "invalidAutoNumber"
    );
    assert.include(
      replace({ ...w.number, default: "TKT1" }),
      "invalidAutoNumber"
    );
  });

  it("a child's override replaces the prefix; auto-numbered fields are read-only and never required", () => {
    const w = world();
    const prefix = override(w.incident, w.number, { numberPrefix: "INC" });
    const snapshot = snapshotOf([...w.definitions, prefix]);

    assert.deepStrictEqual(codes([...w.definitions, prefix]), []);
    assert.include(
      codes([
        ...w.definitions,
        override(w.incident, w.title, { numberPrefix: "INC" }),
      ]),
      "invalidAutoNumber"
    );

    const ofClass = (classId: string) =>
      effectiveFields(snapshot, classId).find(
        (entry) => entry.field.id === w.number.id
      );

    assert.strictEqual(ofClass(w.ticket.id)?.numberPrefix, "TKT");
    assert.strictEqual(ofClass(w.incident.id)?.numberPrefix, "INC");
    assert.strictEqual(ofClass(w.major.id)?.numberPrefix, "INC");
    assert.isTrue(ofClass(w.ticket.id)?.readOnly);
    assert.isNull(
      effectiveFields(snapshot, w.ticket.id).find(
        (entry) => entry.field.id === w.title.id
      )?.numberPrefix
    );

    const rules = rulesFor(snapshot, w.incident.id, w.number.id);

    assert.isTrue(rules.autoNumber);
    assert.isNull(absentCreateValue(rules));
    assert.isFalse(writtenOnCreate(rules, null));
    assert.isTrue(writtenOnCreate(rules, "INC1"));
    assert.deepStrictEqual(fieldErrorsOf(rules, null, false), []);
    assert.deepStrictEqual(fieldErrorsOf(rules, "INC1", true), [
      { _tag: "ReadOnlyField", field: "number" },
    ]);
  });
});

const SET_ID = "20000000-0000-4000-8000-0000000000ff";

const setIds = {
  closed: "20000000-0000-4000-8000-000000000006",
  form: "20000000-0000-4000-8000-000000000008",
  incident: "20000000-0000-4000-8000-000000000003",
  incidentList: "20000000-0000-4000-8000-000000000009",
  namespace: "20000000-0000-4000-8000-000000000001",
  number: "20000000-0000-4000-8000-00000000000a",
  open: "20000000-0000-4000-8000-000000000005",
  prefix: "20000000-0000-4000-8000-00000000000c",
  status: "20000000-0000-4000-8000-000000000004",
  subset: "20000000-0000-4000-8000-000000000007",
  ticket: "20000000-0000-4000-8000-000000000002",
  title: "20000000-0000-4000-8000-00000000000b",
} as const;

const helpdeskFile = (): SetFile => ({
  namespaces: [{ id: setIds.namespace, name: "helpdesk" }],
  set: { id: SET_ID, layer: "app", name: "helpdesk", version: 1 },
  tables: [
    {
      extends: "helpdesk.ticket",
      id: setIds.incident,
      layouts: [
        {
          elements: [{ field: "title" }, { field: "status" }],
          id: setIds.incidentList,
          type: "list",
        },
      ],
      name: "helpdesk.incident",
      overrides: [
        { choices: ["open"], field: "status", id: setIds.subset },
        { field: "number", id: setIds.prefix, numberPrefix: "INC" },
      ],
    },
    {
      fields: [
        {
          choices: [
            { id: setIds.open, key: "open", label: "Open" },
            { id: setIds.closed, key: "closed", label: "Closed" },
          ],
          id: setIds.status,
          name: "status",
          type: "choice",
        },
        { id: setIds.title, name: "title", type: "text" },
        {
          id: setIds.number,
          name: "number",
          numberPrefix: "TKT",
          type: "text",
        },
      ],
      id: setIds.ticket,
      layouts: [
        {
          elements: [
            { section: "Main" },
            { field: "number" },
            { field: "title" },
          ],
          id: setIds.form,
          type: "form",
        },
      ],
      name: "helpdesk.ticket",
    },
  ],
});

describe("set files", () => {
  it("resolve choices, layouts, subsets and prefixes by name and plan them in the last phase", () => {
    const empty = ConfigSnapshot.empty({ ...KEY, revision: 0 });
    const decoded = decodeSetFile("helpdesk.yaml", helpdeskFile());

    assert.isTrue(isSuccess(decoded));

    if (!isSuccess(decoded)) {
      return;
    }

    const files: NamedSetFile[] = [decoded.success];
    const resolved = resolveSet(files, empty);

    assert.isTrue(
      isSuccess(resolved),
      isFailure(resolved) ? resolved.failure.message : ""
    );

    if (!isSuccess(resolved)) {
      return;
    }

    const planned = planSet(resolved.success, empty);

    assert.isTrue(isSuccess(planned));

    if (!isSuccess(planned)) {
      return;
    }

    const order = planned.success.map((operation) =>
      "definition" in operation ? operation.definition.id : operation.id
    );

    assert.isBelow(order.indexOf(setIds.subset), order.indexOf(setIds.open));
    assert.isBelow(order.indexOf(setIds.title), order.indexOf(setIds.form));

    const applied = applyOperations(empty, planned.success, KEY, {
      origin: setOrigin(resolved.success.owner),
      requester: SYSTEM_REQUESTER,
    });

    assert.isTrue(
      isSuccess(applied),
      isFailure(applied) ? applied.failure.message : ""
    );

    if (!isSuccess(applied)) {
      return;
    }

    const { after } = applied.success;

    assert.deepStrictEqual(
      after.choicesOf(setIds.status).map((entry) => [entry.key, entry.order]),
      [
        ["open", 1],
        ["closed", 2],
      ]
    );
    assert.deepStrictEqual(
      effectiveLayout(after, setIds.incident, "form")?.elements,
      [
        { kind: "section", label: "Main" },
        { fieldId: setIds.number, kind: "field" },
        { fieldId: setIds.title, kind: "field" },
      ]
    );
    assert.strictEqual(
      effectiveFields(after, setIds.incident).find(
        (entry) => entry.field.id === setIds.number
      )?.numberPrefix,
      "INC"
    );
  });

  it("refuses a layout naming a field outside the table's lineage", () => {
    const file = helpdeskFile();

    const broken: SetFile = {
      ...file,
      tables: (file.tables ?? []).map((entry) =>
        entry.id === setIds.ticket
          ? {
              ...entry,
              layouts: [
                {
                  elements: [{ field: "nosuch" }],
                  id: setIds.form,
                  type: "form",
                },
              ],
            }
          : entry
      ),
    };

    const decoded = decodeSetFile("helpdesk.yaml", broken);

    assert.isTrue(isSuccess(decoded));

    if (isSuccess(decoded)) {
      assert.isTrue(
        isFailure(
          resolveSet(
            [decoded.success],
            ConfigSnapshot.empty({ ...KEY, revision: 0 })
          )
        )
      );
    }
  });
});
