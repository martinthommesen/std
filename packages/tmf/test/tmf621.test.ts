import { readFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { SetFileSchema } from "@std/definitions/set-file";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Result, Schema } from "effect";
import { parse } from "yaml";

import { eventTypesOf } from "../src/events.ts";
import {
  HELPDESK_CLASS_IDS,
  INCIDENT_FIELD_IDS,
  NOTE_FIELD_IDS,
  PARTY_LINK_FIELD_IDS,
  PROBLEM_FIELD_IDS,
  SPECIFICATION_FIELD_IDS,
  TICKET_FIELD_IDS,
} from "../src/helpdesk-ids.ts";
import {
  derivedAttribute,
  fieldAttribute,
  partsAttribute,
  pathOf,
  pathSource,
} from "../src/mapping.ts";
import type {
  ChangeView,
  OwnerItem,
  SourceKey,
  SourceRecord,
  SourceValues,
} from "../src/mapping.ts";
import { renderResource } from "../src/render.ts";
import { PRIORITY_LABELS, SEVERITY_LABELS } from "../src/tmf621-labels.ts";
import {
  TMF621_STATUSES,
  tmf621StatusOf,
  writeTmf621Status,
} from "../src/tmf621-status.ts";
import { TROUBLE_TICKET_RESOURCE } from "../src/tmf621.ts";
import { planWrite } from "../src/write.ts";
import type { ClassAccess } from "../src/write.ts";

// The TMF621 mapping's pure parts (Contracts 11.2, decision 0035) and the
// framework features it added: owner items, soft defaults, path sources,
// optional sources and a new part's prospective rendering.

const F = TICKET_FIELD_IDS;
const C = HELPDESK_CLASS_IDS;

const SET_DIRECTORY = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "examples",
  "helpdesk",
  "v3"
);

const valuesOf = (
  entries: Readonly<Record<SourceKey, JsonValue>>
): SourceValues =>
  new Map(Object.entries(entries).map(([key, value]) => [key, { value }]));

const ALL_ACCESS: ClassAccess = {
  canName: () => true,
  canRead: () => true,
  canWrite: () => true,
  knows: true,
};

/**
 * The definitions of the set's tables file.
 *
 * @returns `table` and `table.field` to stable ID.
 */
const definitionIds = (): ReadonlyMap<string, string> => {
  const file = Schema.decodeUnknownSync(SetFileSchema)(
    parse(readFileSync(path.join(SET_DIRECTORY, "tables.yaml"), "utf-8"))
  );

  const ids = new Map<string, string>();

  for (const table of file.tables ?? []) {
    ids.set(table.name, table.id);

    for (const field of table.fields ?? []) {
      ids.set(`${table.name}.${field.name}`, field.id);
    }
  }

  return ids;
};

const snake = (name: string): string =>
  name.replaceAll(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);

/** The field names the constants spell differently from their key. */
const RENAMED: ReadonlyMap<string, string> = new Map([
  ["helpdesk.ticket.expectedResolutionAt", "expected_resolution_at"],
  ["helpdesk.ticket.requestedResolutionAt", "requested_resolution_at"],
  ["helpdesk.ticket.specification", "ticket_specification"],
  [
    "helpdesk.ticket_specification.characteristicSpecification",
    "characteristic_specification",
  ],
  ["helpdesk.ticket_specification.version", "specification_version"],
]);

const change = (
  action: ChangeView["action"],
  before: Readonly<Record<SourceKey, JsonValue>> | undefined,
  after?: Readonly<Record<SourceKey, JsonValue>>
): ChangeView => {
  if (before === undefined) {
    return { action, after: valuesOf(after ?? {}) };
  }

  return after === undefined
    ? { action, before: valuesOf(before) }
    : { action, after: valuesOf(after), before: valuesOf(before) };
};

const state = (
  status: string,
  holdReason: string | null = null,
  statusReason: string | null = null
) => ({
  [F.holdReason]: holdReason,
  [F.status]: status,
  [F.statusReason]: statusReason,
});

/** The TMF types and hrefs the pure tests know. */
const NO_NAMES: ReadonlyMap<string, string> = new Map([
  [C.ticket, "TroubleTicket"],
]);

const typesOf = (view: ChangeView) =>
  eventTypesOf(TROUBLE_TICKET_RESOURCE, view).map((rule) => rule.type);

describe("tmf621-mapping", () => {
  it("names every helpdesk definition by its stable ID in helpdesk set v3", () => {
    const ids = definitionIds();

    const groups: readonly (readonly [
      string,
      Readonly<Record<string, string>>,
    ])[] = [
      ["helpdesk.ticket", F],
      ["helpdesk.incident", INCIDENT_FIELD_IDS],
      ["helpdesk.problem", PROBLEM_FIELD_IDS],
      ["helpdesk.ticket_note", NOTE_FIELD_IDS],
      ["helpdesk.ticket_party", PARTY_LINK_FIELD_IDS],
      ["helpdesk.ticket_specification", SPECIFICATION_FIELD_IDS],
    ];

    for (const [table, fields] of groups) {
      for (const [key, id] of Object.entries(fields)) {
        const name = RENAMED.get(`${table}.${key}`) ?? snake(key);

        assert.strictEqual(ids.get(`${table}.${name}`), id, `${table}.${key}`);
      }
    }

    for (const [key, id] of Object.entries(C)) {
      const table =
        key === "note" || key === "party" || key === "specification"
          ? `helpdesk.ticket_${key}`
          : `helpdesk.${key}`;

      assert.strictEqual(ids.get(table), id, key);
    }
  });

  it("renders every ITIL state as one of TMF621's eight statuses", () => {
    const cases: readonly (readonly [ReturnType<typeof state>, string])[] = [
      [state("new"), "acknowledged"],
      [state("assess"), "acknowledged"],
      [state("in_progress"), "inProgress"],
      [state("root_cause_analysis"), "inProgress"],
      [state("fix_in_progress"), "inProgress"],
      [state("on_hold", "awaiting_caller"), "pending"],
      [state("on_hold", "awaiting_vendor"), "held"],
      [state("on_hold"), "held"],
      [state("awaiting_approval"), "held"],
      [state("resolved"), "resolved"],
      [state("closed"), "closed"],
      [state("canceled"), "cancelled"],
      [state("canceled", null, "rejected"), "rejected"],
    ];

    for (const [stored, expected] of cases) {
      assert.strictEqual(tmf621StatusOf(valuesOf(stored)), expected);
      assert.include(TMF621_STATUSES, expected);
    }

    // A source the caller cannot read: no status at all.
    const hidden = new Map(valuesOf(state("new")));

    hidden.delete(F.holdReason);
    assert.isUndefined(tmf621StatusOf(hidden));
  });

  it("writes each TMF621 status onto the incident and problem state models", () => {
    const incident = { lineage: [C.incident, C.ticket] };
    const problem = { lineage: [C.problem, C.ticket] };

    const written = (
      status: string,
      current: ReturnType<typeof state> | undefined,
      target: { readonly lineage: readonly string[] }
    ) => {
      const result = writeTmf621Status(
        status,
        current === undefined ? undefined : valuesOf(current),
        target
      );

      return Result.isSuccess(result)
        ? Object.fromEntries(result.success)
        : null;
    };

    assert.deepStrictEqual(written("acknowledged", undefined, incident), {
      [F.holdReason]: null,
      [F.status]: "new",
    });
    assert.deepStrictEqual(
      written("acknowledged", state("assess"), problem)?.[F.status],
      "assess"
    );
    assert.deepStrictEqual(
      written("inProgress", state("new"), problem)?.[F.status],
      "root_cause_analysis"
    );
    assert.deepStrictEqual(
      written("inProgress", state("fix_in_progress"), problem)?.[F.status],
      "fix_in_progress"
    );
    assert.deepStrictEqual(written("pending", state("new"), incident), {
      [F.holdReason]: "awaiting_caller",
      [F.status]: "on_hold",
    });
    assert.deepStrictEqual(
      written("held", state("on_hold", "awaiting_change"), incident)?.[
        F.holdReason
      ],
      "awaiting_change"
    );
    assert.deepStrictEqual(
      written("held", state("on_hold", "awaiting_caller"), incident)?.[
        F.holdReason
      ],
      "awaiting_vendor"
    );
    assert.deepStrictEqual(written("rejected", state("new"), incident), {
      [F.holdReason]: null,
      [F.status]: "canceled",
      [F.statusReason]: "rejected",
    });
    assert.deepStrictEqual(
      written("cancelled", state("canceled", null, "rejected"), incident),
      {
        [F.holdReason]: null,
        [F.status]: "canceled",
        [F.statusReason]: null,
      }
    );
    assert.isNull(written("done", undefined, incident));
  });

  it("renders and writes severity and priority labels both ways, keeping other values as given", () => {
    const severity = TROUBLE_TICKET_RESOURCE.attributes.find(
      (attribute) => attribute.name === "severity"
    );

    const priority = TROUBLE_TICKET_RESOURCE.attributes.find(
      (attribute) => attribute.name === "priority"
    );

    assert.deepStrictEqual(SEVERITY_LABELS, ["Critical", "Major", "Minor"]);
    assert.deepStrictEqual(PRIORITY_LABELS, [
      "Critical",
      "High",
      "Medium",
      "Low",
      "Planning",
    ]);

    if (severity?.kind !== "value" || priority?.kind !== "value") {
      assert.fail("severity and priority are value attributes");

      return;
    }

    const target = { lineage: [C.incident, C.ticket] };

    const context = {
      history: [],
      hrefOf: (classId: string) => NO_NAMES.get(classId),
      lineage: target.lineage,
      typeOf: (classId: string) => NO_NAMES.get(classId),
    };

    const writeOf = (attribute: typeof severity, value: JsonValue) => {
      const result = attribute.write?.(value, undefined, target);

      return result !== undefined && Result.isSuccess(result)
        ? Object.fromEntries(result.success)
        : null;
    };

    assert.deepStrictEqual(writeOf(severity, "major"), {
      [F.impact]: "2",
      [F.severityLabel]: null,
    });
    assert.deepStrictEqual(writeOf(severity, "Sev-A"), {
      [F.severityLabel]: "Sev-A",
    });
    assert.isNull(writeOf(severity, " "));
    assert.deepStrictEqual(writeOf(priority, "PLANNING"), {
      [F.priority]: "5",
      [F.priorityLabel]: null,
    });

    assert.strictEqual(
      severity.render(
        valuesOf({ [F.impact]: "1", [F.severityLabel]: null }),
        context
      ),
      "Critical"
    );
    assert.strictEqual(
      priority.render(
        valuesOf({ [F.priority]: "2", [F.priorityLabel]: "P1-urgent" }),
        context
      ),
      "P1-urgent"
    );
  });

  it("gives StatusChange when the TMF status changes and Resolved and InformationRequired on entering them", () => {
    assert.deepStrictEqual(typesOf(change("create", undefined, state("new"))), [
      "TroubleTicketCreateEvent",
    ]);
    assert.deepStrictEqual(
      typesOf(change("update", state("new"), state("resolved"))),
      [
        "TroubleTicketAttributeValueChangeEvent",
        "TroubleTicketStatusChangeEvent",
        "TroubleTicketResolvedEvent",
      ]
    );
    assert.deepStrictEqual(
      typesOf(
        change("update", state("new"), state("on_hold", "awaiting_caller"))
      ),
      [
        "TroubleTicketAttributeValueChangeEvent",
        "TroubleTicketStatusChangeEvent",
        "TroubleTicketInformationRequiredEvent",
      ]
    );
    // A hold reason that keeps the TMF status `held` is no status change.
    assert.deepStrictEqual(
      typesOf(
        change(
          "update",
          state("on_hold", "awaiting_vendor"),
          state("on_hold", "awaiting_change")
        )
      ),
      ["TroubleTicketAttributeValueChangeEvent"]
    );
    assert.deepStrictEqual(typesOf(change("delete", state("new"))), [
      "TroubleTicketDeleteEvent",
    ]);
  });
});

// The framework features the TMF621 mapping added (decision 0035).

const OWNER = "00000000-0000-4000-8000-0000000000d1";
const PART = "00000000-0000-4000-8000-0000000000d2";
const CALLER = "00000000-0000-4000-8000-0000000000d3";
const PART_ROLE = "00000000-0000-4000-8000-0000000000d4";
const PART_OWNER = "00000000-0000-4000-8000-0000000000d5";
const DEFAULTED = "00000000-0000-4000-8000-0000000000d6";
const OPTIONAL = "00000000-0000-4000-8000-0000000000d7";
const AUTHOR = "00000000-0000-4000-8000-0000000000d8";

const reporter: OwnerItem = {
  matches: (item) => item.role === "reporter",
  name: "reporter",
  render: (values) => {
    const caller = values.get(CALLER)?.value;

    return caller === undefined || caller === null
      ? undefined
      : { "@type": "Party", id: caller, role: "reporter" };
  },
  sources: [CALLER],
  write: (item) =>
    Result.succeed(
      new Map([[CALLER, item === null ? null : (item.id ?? null)]])
    ),
  writes: [CALLER],
};

const PARTIES = partsAttribute(
  "party",
  {
    attributes: [
      fieldAttribute("role", PART_ROLE),
      fieldAttribute("author", AUTHOR, { readOnly: true }),
    ],
    classId: PART,
    newItemRendering: (actor) => ({ author: actor?.label ?? null }),
    ownerField: PART_OWNER,
    type: "Party",
  },
  { ownerItems: [reporter] }
);

const DEFAULTING = derivedAttribute({
  name: "defaulting",
  render: () => {},
  softWrites: () => [DEFAULTED],
  sources: [DEFAULTED],
  write: (value) =>
    Result.succeed(
      new Map<SourceKey, JsonValue>([
        [DEFAULTED, "default"],
        [OPTIONAL, value],
      ])
    ),
  writes: [DEFAULTED],
});

const DIRECT = fieldAttribute("direct", DEFAULTED);

const ownerRecord = (caller: string | null): SourceRecord => ({
  classId: OWNER,
  id: "00000000-0000-4000-8000-0000000000e1",
  parts: new Map([
    [
      "party",
      [
        {
          classId: PART,
          id: "00000000-0000-4000-8000-0000000000e2",
          parts: new Map(),
          values: valuesOf({ [PART_ROLE]: "customer" }),
          version: 1,
        },
      ],
    ],
  ]),
  values: valuesOf({ [CALLER]: caller }),
  version: 1,
});

const planInput = (body: JsonObject, access: ClassAccess) => ({
  access,
  actor: { id: "user", label: "Ada", targetClassId: null },
  attributes: [PARTIES, DEFAULTING, DIRECT],
  body,
  partAccess: () => ALL_ACCESS,
});

const plan = (body: JsonObject, access: ClassAccess = ALL_ACCESS) =>
  planWrite(planInput(body, access));

const planUpdate = (body: JsonObject, current: SourceRecord) =>
  planWrite({
    ...planInput(body, ALL_ACCESS),
    current: { record: current, rendered: {}, renderedParts: new Map() },
  });

describe("tmf621-framework", () => {
  it("renders owner items before the parts and routes them to owner fields on write", () => {
    const rendered = renderResource(
      { attributes: [PARTIES] },
      ownerRecord("p1"),
      {
        extensions: [],
        fields: null,
        href: "https://std.test/x",
        hrefOf: () => {},
        typeAttributes: { "@type": "Owner" },
        typeOf: () => {},
      }
    );

    assert.deepStrictEqual(rendered.party, [
      { "@type": "Party", id: "p1", role: "reporter" },
      {
        "@type": "Party",
        id: "00000000-0000-4000-8000-0000000000e2",
        role: "customer",
      },
    ]);

    const written = planUpdate(
      { party: [{ id: "p2", role: "reporter" }, { role: "customer" }] },
      ownerRecord("p1")
    );

    assert.isTrue(Result.isSuccess(written));

    if (Result.isSuccess(written)) {
      assert.strictEqual(written.success.values.get(CALLER), "p2");
      assert.strictEqual(written.success.parts[0]?.items.length, 1);
    }

    // Strict RFC 7396: an array without the reporter clears the caller.
    const cleared = planUpdate({ party: [] }, ownerRecord("p1"));

    assert.isTrue(
      Result.isSuccess(cleared) && cleared.success.values.get(CALLER) === null
    );

    // An owner item the caller may not name is unknown, never a part.
    const hidden = plan(
      { party: [{ id: "p2", role: "reporter" }] },
      {
        ...ALL_ACCESS,
        canName: (source) => source !== CALLER,
      }
    );

    assert.deepStrictEqual(Result.isFailure(hidden) ? hidden.failure : [], [
      { attribute: "party.reporter", kind: "unknownAttribute" },
    ]);
  });

  it("lets another attribute's value win over a soft default, and writes an optional source only when nameable", () => {
    const both = plan({ defaulting: "x", direct: "explicit" });

    assert.isTrue(
      Result.isSuccess(both) &&
        both.success.values.get(DEFAULTED) === "explicit" &&
        both.success.values.get(OPTIONAL) === "x"
    );

    const unnameable = plan(
      { defaulting: "x" },
      { ...ALL_ACCESS, canName: (source) => source !== OPTIONAL }
    );

    assert.deepStrictEqual(
      Result.isFailure(unnameable) ? unnameable.failure : [],
      [{ attribute: "defaulting", kind: "unknownAttribute" }]
    );
  });

  it("lets a new part repeat the read-only values it would render, and nothing else", () => {
    const own = plan({ party: [{ author: "Ada", role: "customer" }] });
    const forged = plan({ party: [{ author: "Bob", role: "customer" }] });

    assert.isTrue(Result.isSuccess(own));
    assert.deepStrictEqual(Result.isFailure(forged) ? forged.failure : [], [
      { attribute: "party.author", kind: "readOnly" },
    ]);
  });

  it("spells a path source as its two fields", () => {
    const source = pathSource(CALLER, AUTHOR);

    assert.deepStrictEqual(pathOf(source), {
      reference: CALLER,
      target: AUTHOR,
    });
    assert.isUndefined(pathOf(CALLER));
  });
});
