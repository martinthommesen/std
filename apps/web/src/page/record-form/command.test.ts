/**
 * The form page's Commands against a fake server, through the real typed
 * client: what each request sends (revision, `If-Match`, query, body with
 * API names and the password unwrapped only there) and what each answer
 * becomes, read back by field name (`wire.ts`).
 */
import type { Schema } from "effect";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { toWriteOnlyValue } from "../../domain/form-input.ts";
import type { MetaField } from "../../domain/metadata.ts";
import type { RecordJson } from "../../domain/record.ts";
import { fakeStdApi, tmfError } from "../../fake-std-api.ts";
import type { FakeAnswer } from "../../fake-std-api.ts";
import {
  REVISION_5,
  REVISION_6,
  TICKET,
  TICKET_FIELDS,
  TICKET_ID,
  TICKET_SELECTION,
  TICKET_WIRE,
  USERS,
  ticketRecord,
} from "../../form-fixture.ts";
import { userTable } from "../../table-fixture.ts";
import {
  CreateRecord,
  DeleteRecord,
  LoadHistoryLabels,
  LoadHistory,
  LoadRecord,
  SearchTargets,
  UpdateRecord,
} from "./command.ts";
import { Message, UnreadSavedRecord } from "./message.ts";
import { WriteError } from "./model.ts";

const COLLECTION = "/api/v1/helpTicket";

const RECORD_PATH = `${COLLECTION}/${TICKET_ID}`;

const USERS_PATH = "/api/v1/coreUser";

/**
 * A value the test knows is there.
 *
 * @param value - The value, or undefined.
 * @returns The value.
 */
const present = <A>(value: A | undefined): A => {
  if (value === undefined) {
    throw new RangeError("the fixture lacks a value the test needs");
  }

  return value;
};

const NAME = present(userTable.fields.find((field) => field.name === "name"));

/** An integer display field, for labels that are not text. */
const BADGE: MetaField = {
  ...NAME,
  apiName: "badgeNumber",
  id: "00000000-0000-4000-8000-00000000b0b0",
  label: "Badge",
  name: "badge_number",
  type: { kind: "integer" },
};

/** The ticket as the API serves it: API names, the assignee an EntityRef. */
const ticketResource = {
  "@schemaLocation":
    "http://std.test/api/v1/tableMetadata/helpTicket/schema.json",
  "@type": "HelpTicket",
  assignee: {
    "@referredType": "CoreUser",
    "@type": "CoreUserRef",
    id: USERS.alex,
    name: "Alex Agent",
  },
  customerEmail: "jo@example.com",
  description: "The screen is black.",
  due: "2026-11-01",
  escalated: false,
  href: `http://std.test${RECORD_PATH}`,
  id: TICKET_ID,
  internalCost: "120.00",
  number: "TKT0000001",
  openedAt: "2026-10-20T08:15:00.000Z",
  pin: { set: true },
  points: 3,
  revision: 3,
  shortDescription: "Laptop will not boot",
  status: "on_hold",
  token: { set: true },
  tracking: { source: "mail" },
};

/** The ticket as the app holds it after a read without `fields`. */
const readTicket: RecordJson = {
  ...ticketRecord,
  values: Object.fromEntries(
    Object.entries(ticketRecord.values).filter(
      ([name]) => name !== "legacy_code"
    )
  ),
};

const searchArgs = (
  overrides: Partial<Parameters<typeof SearchTargets>[0]> = {}
): Parameters<typeof SearchTargets>[0] => ({
  allowedFor: "helpTicket/assignee",
  cursor: Option.none(),
  display: Option.some(NAME),
  fieldId: "f",
  filter: Option.none(),
  generation: 3,
  revision: REVISION_5,
  sort: Option.some("name"),
  target: "core.user",
  ...overrides,
});

const REVISION_HEADER = { "std-schema-revision": REVISION_6 };

const updateCommand = UpdateRecord({
  fields: TICKET_WIRE,
  generation: 7,
  isDefinitionTable: false,
  recordId: TICKET_ID,
  revision: REVISION_5,
  secrets: { pin: toWriteOnlyValue("n3w-pin") },
  selected: TICKET_SELECTION,
  table: TICKET,
  values: {
    assignee: USERS.sam,
    description: null,
    short_description: "Mine",
    tracking: { source: "phone" },
  },
  version: 3,
});

const runUpdate = async (answer: FakeAnswer) => {
  const api = fakeStdApi({ [RECORD_PATH]: answer });

  const result = await Effect.runPromise(
    updateCommand.effect.pipe(Effect.provide(api.layer))
  );

  return { result, seen: api.seen };
};

const readRecord = async (answer: FakeAnswer) => {
  const api = fakeStdApi({ [RECORD_PATH]: answer });

  const result = await Effect.runPromise(
    LoadRecord({
      generation: 1,
      purpose: "Open",
      recordId: TICKET_ID,
      revision: REVISION_5,
      selected: TICKET_SELECTION,
      table: TICKET,
    }).effect.pipe(Effect.provide(api.layer))
  );

  return { result, seen: api.seen };
};

const failedSave = (
  error: WriteError,
  maybeRevision = Option.none<typeof REVISION_6>()
) => Message.FailedSaveRecord({ error, generation: 7, maybeRevision });

const REFUSALS = [
  {
    answer: tmfError("VersionConflict", 412, { currentVersion: 4 }),
    expected: failedSave(WriteError.VersionConflict({ currentVersion: 4 })),
    name: "VersionConflict",
  },
  {
    answer: tmfError("SchemaChanged", 409, {
      changes: [
        {
          field: "shortDescription",
          fieldId: TICKET_FIELDS.shortDescription,
          kind: "fieldRenamed",
          revision: 6,
          table: TICKET,
        },
      ],
      currentRevision: REVISION_6,
      requestRevision: REVISION_5,
    }),
    expected: failedSave(
      WriteError.SchemaChanged({
        changes: [
          {
            field: "short_description",
            fieldId: TICKET_FIELDS.shortDescription,
            kind: "fieldRenamed",
            revision: 6,
            table: TICKET,
          },
        ],
        currentRevision: REVISION_6,
      }),
      Option.some(REVISION_6)
    ),
    name: "SchemaChanged",
  },
  {
    answer: tmfError("ValidationFailed", 422, {
      fieldErrors: [
        { _tag: "Required", field: "status" },
        { _tag: "ReadOnlyField", field: "internalCost" },
      ],
    }),
    expected: failedSave(
      WriteError.ValidationFailed({
        errors: [
          { _tag: "Required", field: "status" },
          { _tag: "ReadOnlyField", field: "internal_cost" },
        ],
      })
    ),
    name: "ValidationFailed",
  },
  {
    answer: tmfError("InvalidReference", 422, { field: "assignee" }),
    expected: failedSave(WriteError.InvalidReference({ field: "assignee" })),
    name: "InvalidReference",
  },
  {
    answer: tmfError("UnknownField", 400, { field: "customerEmail" }),
    expected: failedSave(WriteError.UnknownField({ field: "customer_email" })),
    name: "UnknownField",
  },
  {
    answer: tmfError("NotAllowed", 403),
    expected: failedSave(WriteError.NotAllowed()),
    name: "NotAllowed",
  },
  {
    answer: tmfError("Unauthenticated", 401),
    expected: Message.FailedAuthentication(),
    name: "Unauthenticated",
  },
  {
    answer: tmfError("RuleRefused", 422, { message: "Close the tasks first." }),
    expected: failedSave(
      WriteError.Refused({
        message: "Close the tasks first.",
        problems: [],
        tag: "RuleRefused",
      })
    ),
    name: "RuleRefused",
  },
  {
    answer: { status: 500 },
    expected: failedSave(WriteError.Unavailable()),
    name: "no answer",
  },
] as const;

describe("form Commands against the server", () => {
  it("an update sends If-Match, the form's revision and a JSON Patch with API names, the password unwrapped only there", async () => {
    const { result, seen } = await runUpdate({
      body: { ...ticketResource, revision: 4 },
      headers: REVISION_HEADER,
      status: 200,
    });

    const [request] = seen;

    expect(result).toStrictEqual(
      Message.SucceededSaveRecord({
        generation: 7,
        maybeRevision: Option.some(REVISION_6),
        saved: { ...readTicket, version: 4 },
      })
    );
    expect({
      client: request?.headers["std-client"],
      contentType: request?.headers["content-type"],
      ifMatch: request?.headers["if-match"],
      method: request?.method,
      path: request?.path,
      revision: request?.headers["std-schema-revision"],
    }).toStrictEqual({
      client: "web",
      contentType: "application/json-patch+json",
      ifMatch: '"3"',
      method: "PATCH",
      path: RECORD_PATH,
      revision: REVISION_5,
    });
    expect(JSON.parse(request?.body ?? "")).toStrictEqual([
      { op: "add", path: "/assignee", value: { id: USERS.sam } },
      { op: "add", path: "/description", value: null },
      { op: "add", path: "/shortDescription", value: "Mine" },
      { op: "add", path: "/tracking", value: { source: "phone" } },
      { op: "add", path: "/pin", value: "n3w-pin" },
    ]);
    expect(JSON.stringify(updateCommand.args)).not.toContain("n3w-pin");
  });

  it.each(REFUSALS)(
    "an update refused with $name becomes what the form shows, named as the form names its fields",
    async ({ answer, expected }) => {
      const { result } = await runUpdate({
        ...answer,
        headers: REVISION_HEADER,
      });

      expect(result).toStrictEqual(expected);
    }
  );

  it("a definition change set's refusal is shown with its message and every problem", async () => {
    const { result } = await runUpdate(
      tmfError("DefinitionInvalid", 422, {
        message: "The definitions are invalid; nothing was applied",
        problems: [
          {
            code: "unsupportedChange",
            definitionId: "f1",
            message: "type cannot change",
          },
        ],
      })
    );

    expect(result).toStrictEqual(
      failedSave(
        WriteError.Refused({
          message: "The definitions are invalid; nothing was applied",
          problems: [
            {
              code: "unsupportedChange",
              definitionId: "f1",
              message: "type cannot change",
            },
          ],
          tag: "DefinitionInvalid",
        })
      )
    );
  });

  it("an update of a definition table sends a merge patch, whose json values replace the stored ones", async () => {
    const api = fakeStdApi({
      [`/api/v1/coreAccessRule/${TICKET_ID}`]: {
        body: { ...ticketResource, "@type": "CoreAccessRule", revision: 4 },
        status: 200,
      },
    });

    const result = await Effect.runPromise(
      UpdateRecord({
        fields: TICKET_WIRE,
        generation: 7,
        isDefinitionTable: true,
        recordId: TICKET_ID,
        revision: REVISION_5,
        secrets: {},
        selected: TICKET_SELECTION,
        table: "core.access_rule",
        values: { assignee: USERS.sam, tracking: { source: "phone" } },
        version: 3,
      }).effect.pipe(Effect.provide(api.layer))
    );

    const [request] = api.seen;

    expect(result._tag).toBe("SucceededSaveRecord");
    expect([
      request?.headers["content-type"],
      JSON.parse(request?.body ?? ""),
    ]).toStrictEqual([
      "application/merge-patch+json",
      { assignee: { id: USERS.sam }, tracking: { source: "phone" } },
    ]);
  });

  it("a create posts the body with API names and without If-Match", async () => {
    const api = fakeStdApi({
      [COLLECTION]: {
        body: ticketResource,
        headers: { "std-schema-revision": REVISION_5 },
        status: 201,
      },
    });

    const result = await Effect.runPromise(
      CreateRecord({
        fields: TICKET_WIRE,
        generation: 1,
        revision: REVISION_5,
        secrets: {},
        selected: TICKET_SELECTION,
        table: TICKET,
        values: { assignee: USERS.alex, short_description: "New" },
      }).effect.pipe(Effect.provide(api.layer))
    );

    const [request] = api.seen;

    expect(result).toStrictEqual(
      Message.SucceededSaveRecord({
        generation: 1,
        maybeRevision: Option.some(REVISION_5),
        saved: readTicket,
      })
    );
    expect(JSON.parse(request?.body ?? "")).toStrictEqual({
      assignee: { id: USERS.alex },
      shortDescription: "New",
    });
    expect({
      hasIfMatch: request !== undefined && "if-match" in request.headers,
      method: request?.method,
    }).toStrictEqual({ hasIfMatch: false, method: "POST" });
  });

  it("a create answered with the record's identity only reads it again, and NotFound means it is no longer visible", async () => {
    const identity = {
      "@type": "HelpTicket",
      href: `http://std.test${RECORD_PATH}`,
      id: TICKET_ID,
      revision: 1,
    };

    const api = fakeStdApi({
      [`GET ${RECORD_PATH}`]: tmfError("NotFound", 404),
      [`POST ${COLLECTION}`]: { body: identity, status: 201 },
    });

    const result = await Effect.runPromise(
      CreateRecord({
        fields: TICKET_WIRE,
        generation: 1,
        revision: REVISION_5,
        secrets: {},
        selected: TICKET_SELECTION,
        table: TICKET,
        values: { short_description: "Theirs now" },
      }).effect.pipe(Effect.provide(api.layer))
    );

    expect(result).toStrictEqual(
      Message.SucceededSaveRecord({
        generation: 1,
        maybeRevision: Option.none(),
        saved: { id: TICKET_ID, version: 1 },
      })
    );
    expect(
      api.seen.map((seen) => [
        seen.method,
        seen.path,
        seen.headers["std-schema-revision"],
      ])
    ).toStrictEqual([
      ["POST", COLLECTION, REVISION_5],
      ["GET", RECORD_PATH, REVISION_5],
    ]);
  });

  /**
   * Runs a create whose answer is `created`, with `reread` answering the
   * read after it.
   *
   * @param created - The create's answer body.
   * @param reread - The read's answer.
   * @returns The Command's Message and the requests sent.
   */
  const createThenRead = async (
    created: Readonly<Record<string, Schema.Json>>,
    reread: FakeAnswer
  ) => {
    const api = fakeStdApi({
      [`GET ${RECORD_PATH}`]: reread,
      [`POST ${COLLECTION}`]: { body: created, status: 201 },
    });

    const result = await Effect.runPromise(
      CreateRecord({
        fields: TICKET_WIRE,
        generation: 1,
        revision: REVISION_5,
        secrets: {},
        selected: TICKET_SELECTION,
        table: TICKET,
        values: { short_description: "Mine" },
      }).effect.pipe(Effect.provide(api.layer))
    );

    return { result, seen: api.seen };
  };

  const identityOnly = {
    "@type": "HelpTicket",
    href: `http://std.test${RECORD_PATH}`,
    id: TICKET_ID,
    revision: 1,
  };

  const unread = Message.SucceededSaveRecord({
    generation: 1,
    maybeRevision: Option.none(),
    saved: UnreadSavedRecord.make({ id: TICKET_ID, version: 1 }),
  });

  it("a save whose record cannot be read back succeeds with its state unknown, never as an empty record", async () => {
    const failed = await createThenRead(identityOnly, { status: 599 });

    const newer = await createThenRead(identityOnly, {
      body: { ...ticketResource, revision: 2 },
      status: 200,
    });

    expect([failed.result, newer.result]).toStrictEqual([unread, unread]);
  });

  it("a save whose read back finds the session ended sends the user to sign in", async () => {
    const ended = await createThenRead(
      identityOnly,
      tmfError("Unauthenticated", 401)
    );

    expect(ended.result).toStrictEqual(Message.FailedAuthentication());
  });

  it("a save answered with a child class's representation reads the record again with the endpoint's fields named", async () => {
    const child = await createThenRead(
      { ...ticketResource, "@type": "HelpIncident", revision: 1 },
      {
        body: { ...ticketResource, revision: 1, withheld: ["customerEmail"] },
        status: 200,
      }
    );

    const [, read] = child.seen;

    expect(read?.query).toStrictEqual({
      fields: TICKET_SELECTION.map((field) => field.apiName).join(","),
    });
    expect(
      child.result._tag === "SucceededSaveRecord" &&
        "class" in child.result.saved
        ? child.result.saved.withheld
        : []
    ).toStrictEqual(["customer_email"]);
  });

  it("a delete sends If-Match; Referenced is its own refusal", async () => {
    const api = fakeStdApi({
      [RECORD_PATH]: tmfError("Referenced", 409),
    });

    const result = await Effect.runPromise(
      DeleteRecord({
        recordId: TICKET_ID,
        revision: REVISION_5,
        table: TICKET,
        version: 3,
      }).effect.pipe(Effect.provide(api.layer))
    );

    expect(result).toStrictEqual(
      Message.FailedDeleteRecord({ error: WriteError.Referenced() })
    );
    expect([
      api.seen[0]?.method,
      api.seen[0]?.path,
      api.seen[0]?.headers["if-match"],
    ]).toStrictEqual(["DELETE", RECORD_PATH, '"3"']);
  });

  it("a picker's search asks for the target with allowedFor, the condition and the display field", async () => {
    const api = fakeStdApi({
      [USERS_PATH]: {
        body: [
          {
            "@type": "CoreUser",
            href: `http://std.test${USERS_PATH}/u1`,
            id: "u1",
            name: "Alex Agent",
            revision: 1,
          },
          {
            "@type": "CoreUser",
            href: `http://std.test${USERS_PATH}/u2`,
            id: "u2",
            revision: 1,
          },
        ],
        status: 200,
      },
    });

    const result = await Effect.runPromise(
      SearchTargets(
        searchArgs({ filter: Option.some('name contains "Al"') })
      ).effect.pipe(Effect.provide(api.layer))
    );

    expect(result).toStrictEqual(
      Message.SucceededSearchTargets({
        cursor: Option.none(),
        fieldId: "f",
        generation: 3,
        items: [
          { id: "u1", label: "Alex Agent" },
          { id: "u2", label: "u2" },
        ],
        maybeNextCursor: Option.none(),
        maybeRevision: Option.none(),
      })
    );
    expect(api.seen[0]?.query).toStrictEqual({
      allowedFor: "helpTicket/assignee",
      condition: 'name contains "Al"',
      fields: "name",
      limit: "10",
      sort: "name",
    });
    expect(api.seen[0]?.headers["std-schema-revision"]).toBe(REVISION_5);
  });

  it("a picker asks for more from the cursor, and labels a target by a numeric display field's value", async () => {
    const api = fakeStdApi({
      [USERS_PATH]: {
        body: [
          {
            "@type": "CoreUser",
            badgeNumber: 42,
            href: `http://std.test${USERS_PATH}/u3`,
            id: "u3",
          },
          {
            "@type": "CoreUser",
            href: `http://std.test${USERS_PATH}/u4`,
            id: "u4",
          },
        ],
        headers: {
          link: `<http://std.test${USERS_PATH}?after=c2>; rel="self", <http://std.test${USERS_PATH}?after=c3>; rel="next"`,
        },
        status: 200,
      },
    });

    const result = await Effect.runPromise(
      SearchTargets(
        searchArgs({
          cursor: Option.some("c2"),
          display: Option.some(BADGE),
          filter: Option.some("badgeNumber = 42"),
          sort: Option.some("badgeNumber"),
        })
      ).effect.pipe(Effect.provide(api.layer))
    );

    expect(result).toStrictEqual(
      Message.SucceededSearchTargets({
        cursor: Option.some("c2"),
        fieldId: "f",
        generation: 3,
        items: [
          { id: "u3", label: "42" },
          { id: "u4", label: "u4" },
        ],
        maybeNextCursor: Option.some("c3"),
        maybeRevision: Option.none(),
      })
    );
    expect(api.seen[0]?.query).toStrictEqual({
      after: "c2",
      allowedFor: "helpTicket/assignee",
      condition: "badgeNumber = 42",
      fields: "badgeNumber",
      limit: "10",
      sort: "badgeNumber",
    });
  });

  it("a picker's search tells a SchemaChanged refusal apart, with the revision it was sent at", async () => {
    const api = fakeStdApi({
      [USERS_PATH]: tmfError("SchemaChanged", 409, {
        changes: [],
        currentRevision: REVISION_6,
        requestRevision: REVISION_5,
      }),
    });

    const result = await Effect.runPromise(
      SearchTargets(searchArgs()).effect.pipe(Effect.provide(api.layer))
    );

    expect(result).toStrictEqual(
      Message.FailedSearchTargets({
        error: "SchemaChanged",
        fieldId: "f",
        generation: 3,
        maybeRevision: Option.some(REVISION_6),
        revision: REVISION_5,
      })
    );
  });

  it("a record read is read back by field name: an empty attribute as null, a withheld one apart, the reference's label kept", async () => {
    const withheld = Object.fromEntries(
      Object.entries(ticketResource).filter(
        ([name]) => name !== "customerEmail" && name !== "due"
      )
    );

    const found = await readRecord({
      body: { ...withheld, withheld: ["customerEmail"] },
      status: 200,
    });

    expect(found.seen[0]?.query).toStrictEqual({
      fields: TICKET_SELECTION.map((field) => field.apiName).join(","),
    });
    expect(found.result).toStrictEqual(
      Message.SucceededLoadRecord({
        generation: 1,
        maybeRevision: Option.none(),
        purpose: "Open",
        record: {
          ...readTicket,
          values: Object.fromEntries(
            Object.entries({ ...readTicket.values, due: null }).filter(
              ([name]) => name !== "customer_email"
            )
          ),
          withheld: ["customer_email"],
        },
      })
    );
  });

  it("a record read tells NotFound and SchemaChanged apart", async () => {
    const missing = await readRecord(tmfError("NotFound", 404));

    const stale = await readRecord(
      tmfError("SchemaChanged", 409, {
        changes: [],
        currentRevision: REVISION_6,
        requestRevision: REVISION_5,
      })
    );

    expect([missing.result, stale.result]).toStrictEqual([
      Message.FailedLoadRecord({
        error: "NotFound",
        generation: 1,
        maybeRevision: Option.none(),
      }),
      Message.FailedLoadRecord({
        error: "SchemaChanged",
        generation: 1,
        maybeRevision: Option.some(REVISION_6),
      }),
    ]);
  });

  it("the history is read at the form's revision, as entries the panel reads", async () => {
    const api = fakeStdApi({
      [`${RECORD_PATH}/history`]: {
        body: [
          {
            "@baseType": "History",
            "@type": "ChangeEntry",
            action: "updated",
            actor: { "@type": "CoreUserRef", id: USERS.alex },
            cause: null,
            changes: { shortDescription: { new: "B", old: "A" } },
            creationDate: "2026-10-22T08:00:00.000Z",
            fields: {
              shortDescription: {
                choices: null,
                label: "Short description",
                type: { kind: "text" },
              },
            },
            href: `http://std.test${RECORD_PATH}/history/c1`,
            id: "c1",
            kind: "update",
            occurredAt: "2026-10-22T08:00:00.000Z",
            operationId: "o1",
            revision: 2,
            schemaRevision: 5,
          },
        ],
        headers: { "std-schema-revision": REVISION_5, "x-total-count": "1" },
        status: 200,
      },
    });

    const result = await Effect.runPromise(
      LoadHistory({
        generation: 2,
        recordId: TICKET_ID,
        revision: REVISION_5,
        table: TICKET,
      }).effect.pipe(Effect.provide(api.layer))
    );

    expect(result).toStrictEqual(
      Message.SucceededLoadHistory({
        entries: [
          {
            actor: USERS.alex,
            cause: null,
            changeId: "c1",
            changes: { shortDescription: { new: "B", old: "A" } },
            fields: {
              shortDescription: {
                choices: null,
                label: "Short description",
                type: { kind: "text" },
              },
            },
            kind: "update",
            occurredAt: "2026-10-22T08:00:00.000Z",
            operationId: "o1",
            schemaRevision: 5,
            version: 2,
          },
        ],
        generation: 2,
        maybeRevision: Option.some(REVISION_5),
      })
    );
    expect(api.seen[0]?.headers["std-schema-revision"]).toBe(REVISION_5);
    expect(api.seen[0]?.query).toStrictEqual({ limit: "1000", offset: "0" });
  });

  it("a history longer than a page is read page by page", async () => {
    const entry = {
      "@baseType": "History",
      "@type": "ChangeEntry",
      actor: { id: USERS.alex },
      cause: null,
      changes: {},
      fields: {},
      id: "c1",
      kind: "update",
      occurredAt: "2026-10-22T08:00:00.000Z",
      operationId: "o",
      revision: 1,
      schemaRevision: 5,
    };

    const api = fakeStdApi({
      [`${RECORD_PATH}/history`]: {
        body: [entry],
        headers: { "std-schema-revision": REVISION_5, "x-total-count": "2001" },
        status: 200,
      },
    });

    const result = await Effect.runPromise(
      LoadHistory({
        generation: 2,
        recordId: TICKET_ID,
        revision: REVISION_5,
        table: TICKET,
      }).effect.pipe(Effect.provide(api.layer))
    );

    expect(result._tag).toBe("SucceededLoadHistory");
    expect(api.seen.map((seen) => seen.query.offset)).toStrictEqual([
      "0",
      "1000",
      "2000",
    ]);
  });

  it("the actors' names come from one list of users", async () => {
    const api = fakeStdApi({
      [USERS_PATH]: {
        body: [
          {
            "@type": "CoreUser",
            href: `http://std.test${USERS_PATH}/${USERS.alex}`,
            id: USERS.alex,
            name: "Alex Agent",
          },
        ],
        status: 200,
      },
    });

    const result = await Effect.runPromise(
      LoadHistoryLabels({
        ids: [USERS.alex, USERS.sam],
        maybeDisplayField: Option.some("name"),
        revision: REVISION_5,
        table: "core.user",
      }).effect.pipe(Effect.provide(api.layer))
    );

    expect(result).toStrictEqual(
      Message.SucceededLoadHistoryLabels({
        labels: { [USERS.alex]: "Alex Agent" },
        table: "core.user",
      })
    );
    expect(api.seen).toHaveLength(1);
    expect(api.seen[0]?.query).toStrictEqual({
      condition: `id in ("${USERS.alex}", "${USERS.sam}")`,
      fields: "name",
      limit: "2",
    });
  });

  it("a referenced table the form has no metadata for: its display field is read from its metadata, then its records in one list", async () => {
    const LOCATIONS_PATH = "/api/v1/helpLocation";

    const one = "019a0000-0000-7000-8000-0000000a0001";

    const two = "019a0000-0000-7000-8000-0000000a0002";

    const api = fakeStdApi({
      "/api/v1/tableMetadata/helpLocation": {
        body: {
          ...userTable,
          displayField: "title",
          fields: [
            {
              ...NAME,
              apiName: "title",
              id: "00000000-0000-4000-8000-00000000a0a1",
              label: "Title",
              name: "title",
            },
          ],
          id: "helpLocation",
          name: "help.location",
          resourceType: "HelpLocation",
        },
        headers: REVISION_HEADER,
        status: 200,
      },
      [LOCATIONS_PATH]: {
        body: [
          {
            "@type": "HelpLocation",
            href: `http://std.test${LOCATIONS_PATH}/${one}`,
            id: one,
            title: "Floor 3",
          },
          {
            "@type": "HelpLocation",
            href: `http://std.test${LOCATIONS_PATH}/${two}`,
            id: two,
            title: "Floor 4",
          },
        ],
        status: 200,
      },
    });

    const result = await Effect.runPromise(
      LoadHistoryLabels({
        ids: [one, two],
        maybeDisplayField: Option.none(),
        revision: REVISION_5,
        table: "help.location",
      }).effect.pipe(Effect.provide(api.layer))
    );

    expect(result).toStrictEqual(
      Message.SucceededLoadHistoryLabels({
        labels: { [one]: "Floor 3", [two]: "Floor 4" },
        table: "help.location",
      })
    );
    expect(api.seen.map((request) => request.path)).toStrictEqual([
      "/api/v1/tableMetadata/helpLocation",
      LOCATIONS_PATH,
    ]);
    expect(api.seen[1]?.query).toStrictEqual({
      condition: `id in ("${one}", "${two}")`,
      fields: "title",
      limit: "2",
    });
  });

  it("a failed list of display values is reported for its table", async () => {
    // NOTE: the fake server answers no path it was not given with 599.
    const api = fakeStdApi({});

    const result = await Effect.runPromise(
      LoadHistoryLabels({
        ids: [USERS.alex],
        maybeDisplayField: Option.some("name"),
        revision: REVISION_5,
        table: "core.user",
      }).effect.pipe(Effect.provide(api.layer))
    );

    expect(result).toStrictEqual(
      Message.FailedLoadHistoryLabels({ table: "core.user" })
    );
  });
});
