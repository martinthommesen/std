import { Result } from "effect";
import { describe, expect, it } from "vitest";

import { eventTypesOf, standardEvents } from "../src/events.ts";
import {
  derivedAttribute,
  enumAttribute,
  fieldAttribute,
  jsonAttribute,
  mappingProblems,
  partsAttribute,
  referenceAttribute,
  SYSTEM_SOURCES,
} from "../src/mapping.ts";
import type {
  RenderContext,
  SourceRecord,
  SourceValue,
  TmfResourceMapping,
} from "../src/mapping.ts";
import { parseTmfFields, parseTmfSort } from "../src/query.ts";
import { renderResource, typeAttributesOf } from "../src/render.ts";
import { tmfStatusFor } from "../src/status.ts";
import { mergeBodyOf, planWrite } from "../src/write.ts";
import type { ClassAccess } from "../src/write.ts";

// The pure parts of the TMF Open API framework (Contracts 11.1, decision
// 0033): rendering from what the caller may read, write planning with
// strict RFC 7396 arrays of parts, queries, statuses and events.

const F = {
  holdReason: "00000000-0000-4000-8000-0000000000a2",
  json: "00000000-0000-4000-8000-0000000000a5",
  name: "00000000-0000-4000-8000-0000000000a1",
  noteOwner: "00000000-0000-4000-8000-0000000000b1",
  noteText: "00000000-0000-4000-8000-0000000000b2",
  owner: "00000000-0000-4000-8000-0000000000a4",
  severity: "00000000-0000-4000-8000-0000000000a6",
  status: "00000000-0000-4000-8000-0000000000a3",
} as const;

const TICKET = "00000000-0000-4000-8000-0000000000c1";
const INCIDENT = "00000000-0000-4000-8000-0000000000c2";
const LOCAL = "00000000-0000-4000-8000-0000000000c3";
const NOTE = "00000000-0000-4000-8000-0000000000c4";

const STATUS = derivedAttribute({
  name: "status",
  render: (values) => {
    if (values.get(F.status)?.value !== "on_hold") {
      return "acknowledged";
    }

    return values.get(F.holdReason)?.value === "caller" ? "pending" : "held";
  },
  sources: [F.status, F.holdReason],
  write: (value) =>
    value === "pending"
      ? Result.succeed(
          new Map([
            [F.status, "on_hold"],
            [F.holdReason, "caller"],
          ])
        )
      : Result.fail({ kind: "invalidValue", message: "status: pending only" }),
});

const RESOURCE: TmfResourceMapping = {
  attributes: [
    fieldAttribute("name", F.name, { requiredOnCreate: true }),
    STATUS,
    enumAttribute("severity", F.severity, [
      ["1", "Critical"],
      ["2", "Major"],
    ]),
    referenceAttribute("owner", F.owner, { refType: "PartyRef" }),
    jsonAttribute("characteristic", F.json),
    fieldAttribute("creationDate", SYSTEM_SOURCES.createdAt, {
      readOnly: true,
    }),
    partsAttribute("note", {
      attributes: [fieldAttribute("text", F.noteText)],
      classId: NOTE,
      ownerField: F.noteOwner,
      type: "Note",
    }),
  ],
  classId: TICKET,
  declaredStatuses: {
    create: [201, 400],
    delete: [204, 400],
    list: [200, 400],
    patch: [200, 400, 409],
    retrieve: [200, 400, 404],
  },
  events: standardEvents({
    status: { sources: [F.status, F.holdReason] },
    type: "TroubleTicket",
  }),
  name: "troubleTicket",
  operations: ["list", "retrieve", "create", "patch", "delete"],
  type: "TroubleTicket",
  types: [
    { classId: TICKET, createTarget: true, type: "TroubleTicket" },
    { classId: INCIDENT, createTarget: false, type: "TroubleTicket" },
  ],
};

const CONTEXT: RenderContext = {
  hrefOf: () => {},
  typeOf: (classId) => (classId === "user" ? "Individual" : undefined),
};

const value = (json: SourceValue["value"]): SourceValue => ({ value: json });

const note = (id: string, text: string): SourceRecord => ({
  classId: NOTE,
  id,
  parts: new Map(),
  values: new Map([[F.noteText, value(text)]]),
  version: 1,
});

const RECORD: SourceRecord = {
  classId: TICKET,
  id: "t1",
  parts: new Map([["note", [note("n1", "one"), note("n2", "two")]]]),
  values: new Map<string, SourceValue>([
    [F.name, value("Mail")],
    [F.status, value("on_hold")],
    [F.holdReason, value("caller")],
    [F.severity, value("2")],
    [F.json, value(null)],
    [
      F.owner,
      {
        reference: { id: "u1", label: "Alice", targetClassId: "user" },
        value: "u1",
      },
    ],
    [SYSTEM_SOURCES.createdAt, value("2026-10-23T10:00:00.000Z")],
  ]),
  version: 3,
};

const render = (
  record: SourceRecord,
  fields: ReadonlySet<string> | null = null
) =>
  renderResource(RESOURCE, record, {
    ...CONTEXT,
    extensions: [],
    fields,
    href: "https://std.test/t1",
    typeAttributes: { "@type": "TroubleTicket" },
  });

const ALL_ACCESS: ClassAccess = {
  canName: () => true,
  canRead: () => true,
  knows: true,
};

const without = (record: SourceRecord, ...hidden: string[]): SourceRecord => ({
  ...record,
  values: new Map([...record.values].filter(([key]) => !hidden.includes(key))),
});

// A value of type `undefined`, for a field that is absent.
const ABSENT = new Map<string, SourceRecord["values"]>().get("");

const withNullId = (item: {
  readonly existingId: string | undefined;
  readonly values: ReadonlyMap<string, unknown>;
}) => ({ existingId: item.existingId ?? null, values: item.values });

const types = (change: Parameters<typeof eventTypesOf>[1]) =>
  eventTypesOf(RESOURCE, change).map((rule) => rule.type);

describe("tmf-mapping", () => {
  it("renders readable attributes, leaves empty and hidden ones out, and derives only from readable sources", () => {
    expect(render(RECORD)).toStrictEqual({
      "@type": "TroubleTicket",
      creationDate: "2026-10-23T10:00:00.000Z",
      href: "https://std.test/t1",
      id: "t1",
      name: "Mail",
      note: [
        { "@type": "Note", id: "n1", text: "one" },
        { "@type": "Note", id: "n2", text: "two" },
      ],
      owner: {
        "@referredType": "Individual",
        "@type": "PartyRef",
        id: "u1",
        name: "Alice",
      },
      severity: "Major",
      status: "pending",
    });

    // A hidden hold reason hides the derived status, not only the field.
    const hidden = render(without(RECORD, F.holdReason, F.name));

    expect(hidden).not.toHaveProperty("status");
    expect(hidden).not.toHaveProperty("name");
    expect(render(RECORD, new Set(["severity"]))).toStrictEqual({
      "@type": "TroubleTicket",
      href: "https://std.test/t1",
      id: "t1",
      severity: "Major",
    });
  });

  it("types a shipped class by its mapping and a local child class by its own name and its nearest mapped ancestor", () => {
    expect(
      typeAttributesOf(RESOURCE, [INCIDENT, TICKET], "SiteIncident")
    ).toStrictEqual({
      "@type": "TroubleTicket",
    });
    expect(
      typeAttributesOf(RESOURCE, [LOCAL, INCIDENT, TICKET], "LocalVip")
    ).toStrictEqual({
      "@baseType": "TroubleTicket",
      "@type": "LocalVip",
    });
  });

  it("plans a create: fields, a derived write, parts, required and unknown attributes", () => {
    const planned = planWrite({
      access: ALL_ACCESS,
      attributes: RESOURCE.attributes,
      body: {
        note: [{ "@type": "Note", text: "first" }],
        severity: "Critical",
        status: "pending",
      },
      partAccess: () => ALL_ACCESS,
    });

    expect(Result.isFailure(planned)).toBeTruthy();
    expect(Result.isFailure(planned) ? planned.failure : []).toStrictEqual([
      { attribute: "name", kind: "required" },
    ]);

    const created = planWrite({
      access: ALL_ACCESS,
      attributes: RESOURCE.attributes,
      body: { name: "x", note: [{ text: "first" }], status: "pending" },
      partAccess: () => ALL_ACCESS,
    });

    const plan = Result.isSuccess(created) ? created.success : undefined;

    expect([...(plan?.values ?? [])]).toStrictEqual([
      [F.name, "x"],
      [F.status, "on_hold"],
      [F.holdReason, "caller"],
    ]);
    expect(plan?.parts[0]?.items.map(withNullId)).toStrictEqual([
      { existingId: null, values: new Map([[F.noteText, "first"]]) },
    ]);

    const refused = planWrite({
      access: { ...ALL_ACCESS, canName: (key) => key !== F.severity },
      attributes: RESOURCE.attributes,
      body: { creationDate: "x", name: "y", nope: 1, severity: "Bogus" },
      partAccess: () => ALL_ACCESS,
    });

    expect(Result.isFailure(refused) ? refused.failure : []).toStrictEqual([
      { attribute: "creationDate", kind: "readOnly" },
      { attribute: "nope", kind: "unknownAttribute" },
      { attribute: "severity", kind: "unknownAttribute" },
    ]);
  });

  it("replaces the visible parts strictly (RFC 7396) and accepts read-only repeats in a merge-patch", () => {
    const rendered = render(RECORD);

    const merged = planWrite({
      access: ALL_ACCESS,
      attributes: RESOURCE.attributes,
      body: {
        creationDate: "2026-10-23T10:00:00.000Z",
        note: [
          { "@type": "Note", id: "n2", text: "two, changed" },
          { "@type": "Note", id: "n9", text: "new" },
        ],
      },
      current: {
        record: RECORD,
        rendered,
        renderedParts: new Map(),
      },
      partAccess: () => ALL_ACCESS,
    });

    const plan = Result.isSuccess(merged) ? merged.success : undefined;

    expect(plan?.values.size).toBe(0);
    expect(plan?.parts[0]?.deleted).toStrictEqual(["n1"]);
    expect(plan?.parts[0]?.items.map(withNullId)).toStrictEqual([
      { existingId: "n2", values: new Map([[F.noteText, "two, changed"]]) },
      { existingId: null, values: new Map([[F.noteText, "new"]]) },
    ]);

    const changedReadOnly = planWrite({
      access: ALL_ACCESS,
      attributes: RESOURCE.attributes,
      body: { creationDate: "2020-01-01T00:00:00.000Z", id: "t2" },
      current: { record: RECORD, rendered, renderedParts: new Map() },
      partAccess: () => ALL_ACCESS,
    });

    expect(
      Result.isFailure(changedReadOnly) ? changedReadOnly.failure : []
    ).toStrictEqual([
      { attribute: "id", kind: "readOnly" },
      { attribute: "creationDate", kind: "readOnly" },
    ]);
  });

  it("refuses a reorder of an array without an order field, and new items before kept ones", () => {
    const current = {
      record: RECORD,
      rendered: render(RECORD),
      renderedParts: new Map(),
    };

    const plan = (items: readonly object[]) =>
      planWrite({
        access: ALL_ACCESS,
        attributes: RESOURCE.attributes,
        body: { note: items.map((item) => ({ ...item })) },
        current,
        partAccess: () => ALL_ACCESS,
      });

    const issue = {
      attribute: "note",
      kind: "invalidValue",
      message:
        "note cannot be reordered here: list the kept items in their current order, new items after them.",
    };

    expect(
      plan([
        { id: "n2", text: "two" },
        { id: "n1", text: "one" },
      ])
    ).toStrictEqual(Result.fail([issue]));
    expect(plan([{ text: "new" }, { id: "n1", text: "one" }])).toStrictEqual(
      Result.fail([issue])
    );
    expect(
      Result.isSuccess(plan([{ id: "n1", text: "one" }, { text: "new" }]))
    ).toBeTruthy();
  });

  it("stores positions with an order field, plans existing parts with their own class's access, and fails a clear its writer refuses", () => {
    const strict = derivedAttribute({
      name: "kind",
      render: (values) => values.get(F.json)?.value ?? undefined,
      sources: [F.json],
      write: (written) =>
        written === null
          ? Result.fail({ kind: "invalidValue", message: "kind is required" })
          : Result.succeed(new Map([[F.json, written]])),
    });

    const notes = partsAttribute("note", {
      attributes: [fieldAttribute("text", F.noteText), strict],
      classId: NOTE,
      orderField: F.status,
      ownerField: F.noteOwner,
      type: "Note",
    });

    const seen: (string | undefined)[] = [];

    const plan = (items: readonly object[], hidden: readonly string[] = []) =>
      planWrite({
        access: ALL_ACCESS,
        attributes: [notes],
        body: { note: items.map((item) => ({ ...item })) },
        current: { record: RECORD, rendered: {}, renderedParts: new Map() },
        partAccess: (_item, existing) => {
          seen.push(existing?.id);

          return {
            ...ALL_ACCESS,
            canName: (key) => !hidden.includes(key),
            canRead: (key) => !hidden.includes(key),
          };
        },
      });

    const ordered = plan([
      { id: "n2", kind: "b", text: "two" },
      { id: "n1", kind: "a", text: "one" },
    ]);

    // Once for whether the part class is known, then once per item.
    expect(seen).toStrictEqual([undefined, "n2", "n1"]);
    expect(
      Result.isSuccess(ordered) ? ordered.success.parts[0]?.items : []
    ).toStrictEqual([
      {
        existingId: "n2",
        values: new Map<string, unknown>([
          [F.noteText, "two"],
          [F.json, "b"],
          [F.status, 0],
        ]),
      },
      {
        existingId: "n1",
        values: new Map<string, unknown>([
          [F.noteText, "one"],
          [F.json, "a"],
          [F.status, 1],
        ]),
      },
    ]);

    // The kind the item leaves out cannot be cleared: the write fails.
    expect(plan([{ id: "n1", text: "one" }])).toStrictEqual(
      Result.fail([
        {
          attribute: "note.kind",
          kind: "invalidValue",
          message: "kind cannot be cleared; send its value.",
        },
      ])
    );

    // A field the caller cannot name on the part is neither cleared nor
    // named, and the order is then kept as it is.
    const hiddenKind = plan([{ id: "n1", text: "one" }], [F.json, F.status]);

    expect(
      Result.isSuccess(hiddenKind) ? hiddenKind.success.parts[0]?.items : []
    ).toStrictEqual([
      { existingId: "n1", values: new Map([[F.noteText, "one"]]) },
    ]);
  });

  it("keeps positions when the order stays, appends after the highest, and rewrites all on a reorder, with duplicate and negative positions", () => {
    const positioned = (id: string, position: number): SourceRecord => ({
      ...note(id, id),
      values: new Map([
        [F.noteText, value(id)],
        [F.status, value(position)],
      ]),
    });

    // As reads list them: position, then creation (b and c tie at -3).
    const parts = [
      positioned("a", -5),
      positioned("b", -3),
      positioned("c", -3),
    ];

    const record: SourceRecord = {
      ...RECORD,
      parts: new Map([["note", parts]]),
    };

    const notes = partsAttribute("note", {
      attributes: [fieldAttribute("text", F.noteText)],
      classId: NOTE,
      orderField: F.status,
      ownerField: F.noteOwner,
      type: "Note",
    });

    const itemsOf = (body: readonly object[]) => {
      const planned = planWrite({
        access: ALL_ACCESS,
        attributes: [notes],
        body: { note: body.map((item) => ({ ...item })) },
        current: { record, rendered: {}, renderedParts: new Map() },
        partAccess: () => ALL_ACCESS,
      });

      return Result.isSuccess(planned) ? planned.success.parts[0]?.items : [];
    };

    const same = itemsOf([
      { id: "a", text: "a" },
      { id: "b", text: "b" },
      { id: "c", text: "c" },
      { text: "d" },
    ]);

    expect(same?.map((item) => item.values.get(F.status))).toStrictEqual([
      undefined,
      undefined,
      undefined,
      -2,
    ]);

    const swapped = itemsOf([
      { id: "c", text: "c" },
      { id: "b", text: "b" },
    ]);

    expect(swapped?.map((item) => item.values.get(F.status))).toStrictEqual([
      0, 1,
    ]);

    // Readable but not writable, or writable but not readable: no reorder.
    for (const access of [
      { ...ALL_ACCESS, canName: (key: string) => key !== F.status },
      { ...ALL_ACCESS, canRead: (key: string) => key !== F.status },
    ]) {
      const refused = planWrite({
        access: ALL_ACCESS,
        attributes: [notes],
        body: {
          note: [
            { id: "c", text: "c" },
            { id: "a", text: "a" },
          ],
        },
        current: { record, rendered: {}, renderedParts: new Map() },
        partAccess: () => access,
      });

      expect(Result.isFailure(refused)).toBeTruthy();
    }
  });

  it("refuses a mapping whose item attribute writes the order field, or maps a name twice", () => {
    const notes = partsAttribute("note", {
      attributes: [
        fieldAttribute("text", F.noteText),
        fieldAttribute("position", F.status),
        fieldAttribute("text", F.json),
      ],
      classId: NOTE,
      orderField: F.status,
      ownerField: F.noteOwner,
      type: "Note",
    });

    expect(
      mappingProblems({
        basePath: "/tmf-api/test/v5",
        resources: [{ ...RESOURCE, attributes: [notes, notes] }],
        spec: "TMF621",
      })
    ).toStrictEqual([
      "TMF621 troubleTicket: attribute note is mapped twice",
      "TMF621 troubleTicket.note: attribute text is mapped twice",
      "TMF621 troubleTicket.note: attribute position writes the order field",
      "TMF621 troubleTicket.note: attribute text is mapped twice",
      "TMF621 troubleTicket.note: attribute position writes the order field",
    ]);
    expect(
      mappingProblems({
        basePath: "/tmf-api/test/v5",
        resources: [RESOURCE],
        spec: "TMF621",
      })
    ).toStrictEqual([]);
  });

  it("turns a patched resource into the equivalent merge-patch body", () => {
    expect(
      mergeBodyOf(
        { a: 1, b: [1], c: "x", id: "t" },
        { a: 1, b: [1, 2], d: true, id: "t" }
      )
    ).toStrictEqual({ b: [1, 2], c: null, d: true });
  });

  it("parses fields and sort over the attributes the caller knows", () => {
    const known = ["name", "severity", "note"];

    expect([
      parseTmfFields("severity,note.text,id", known),
      parseTmfFields("!severity", known),
      parseTmfFields("none", known),
      parseTmfFields("priority", known),
      parseTmfFields("name,!name", known),
      parseTmfSort("-name,+severity", known),
    ]).toStrictEqual([
      Result.succeed(new Set(["severity", "note"])),
      Result.succeed(new Set(["name", "note"])),
      Result.succeed(new Set()),
      Result.fail({ attribute: "priority", kind: "unknownAttribute" }),
      Result.fail({ attribute: "name", kind: "conflict" }),
      Result.succeed([
        { attribute: "name", descending: true },
        { attribute: "severity", descending: false },
      ]),
    ]);
  });

  it("answers only declared statuses", () => {
    const { patch } = RESOURCE.declaredStatuses;

    expect(tmfStatusFor("VersionConflict", 412, patch)).toBe(409);
    expect(tmfStatusFor("ValidationFailed", 422, patch)).toBe(400);
    expect(
      tmfStatusFor("NotFound", 404, RESOURCE.declaredStatuses.retrieve)
    ).toBe(404);
    expect(tmfStatusFor("SchemaBusy", 503, patch)).toBe(503);
  });

  it("gives the event types of a change: a status change only when a status source changed", () => {
    const before = RECORD.values;
    const after = new Map([...before, [F.holdReason, value("vendor")]]);
    const renamed = new Map([...before, [F.name, value("Other")]]);

    expect(types({ action: "update", after, before })).toStrictEqual([
      "TroubleTicketAttributeValueChangeEvent",
      "TroubleTicketStatusChangeEvent",
    ]);
    expect(types({ action: "update", after: renamed, before })).toStrictEqual([
      "TroubleTicketAttributeValueChangeEvent",
    ]);
    expect(types({ action: "create", after, before: ABSENT })).toStrictEqual([
      "TroubleTicketCreateEvent",
    ]);
  });
});
