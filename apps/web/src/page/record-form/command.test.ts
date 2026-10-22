/**
 * The form page's Commands against a fake server, through the real typed
 * client: what each request sends (revision, `If-Match`, query, body with
 * the password unwrapped only there) and what each answer becomes.
 */
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { toWriteOnlyValue } from "../../domain/form-input.ts";
import { fakeStdApi } from "../../fake-std-api.ts";
import type { FakeAnswer } from "../../fake-std-api.ts";
import {
  REVISION_5,
  REVISION_6,
  TICKET,
  TICKET_ID,
  ticketRecord,
} from "../../form-fixture.ts";
import {
  CreateRecord,
  DeleteRecord,
  LoadHistory,
  LoadRecord,
  SearchTargets,
  UpdateRecord,
} from "./command.ts";
import { Message } from "./message.ts";
import { WriteError } from "./model.ts";

const RECORD_PATH = `/api/v1/tables/${TICKET}/records/${TICKET_ID}`;

const REVISION_HEADER = { "std-schema-revision": REVISION_6 };

const updateCommand = UpdateRecord({
  generation: 7,
  recordId: TICKET_ID,
  revision: REVISION_5,
  secrets: { pin: toWriteOnlyValue("n3w-pin") },
  table: TICKET,
  values: { description: null, short_description: "Mine" },
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
      table: TICKET,
    }).effect.pipe(Effect.provide(api.layer))
  );

  return { result, seen: api.seen };
};

const failedSave = (
  error: WriteError,
  maybeRevision = Option.none<typeof REVISION_6>()
) => Message.FailedSaveRecord({ error, generation: 7, maybeRevision });

const changes = [
  {
    field: "summary",
    fieldId: "f1",
    kind: "fieldRenamed" as const,
    revision: 6,
    table: TICKET,
  },
];

const REFUSALS = [
  {
    answer: {
      body: { _tag: "VersionConflict", currentVersion: 4 },
      status: 409,
    },
    expected: failedSave(WriteError.VersionConflict({ currentVersion: 4 })),
    name: "VersionConflict",
  },
  {
    answer: {
      body: {
        _tag: "SchemaChanged",
        changes,
        currentRevision: REVISION_6,
        requestRevision: REVISION_5,
      },
      status: 409,
    },
    expected: failedSave(
      WriteError.SchemaChanged({ changes, currentRevision: REVISION_6 }),
      Option.some(REVISION_6)
    ),
    name: "SchemaChanged",
  },
  {
    answer: {
      body: {
        _tag: "ValidationFailed",
        errors: [{ _tag: "Required", field: "status" }],
      },
      status: 422,
    },
    expected: failedSave(
      WriteError.ValidationFailed({
        errors: [{ _tag: "Required", field: "status" }],
      })
    ),
    name: "ValidationFailed",
  },
  {
    answer: {
      body: { _tag: "InvalidReference", field: "assignee" },
      status: 422,
    },
    expected: failedSave(WriteError.InvalidReference({ field: "assignee" })),
    name: "InvalidReference",
  },
  {
    answer: { body: { _tag: "NotAllowed" }, status: 403 },
    expected: failedSave(WriteError.NotAllowed()),
    name: "NotAllowed",
  },
  {
    answer: { body: { _tag: "Unauthenticated" }, status: 401 },
    expected: Message.FailedAuthentication(),
    name: "Unauthenticated",
  },
  {
    answer: { status: 500 },
    expected: failedSave(WriteError.Unavailable()),
    name: "no answer",
  },
] as const;

describe("form Commands against the server", () => {
  it("an update sends If-Match, the form's revision and the body, the password unwrapped only there", async () => {
    const { result, seen } = await runUpdate({
      body: { record: { ...ticketRecord, version: 4 }, schemaRevision: 6 },
      headers: REVISION_HEADER,
      status: 200,
    });

    const [request] = seen;

    expect(result).toStrictEqual(
      Message.SucceededSaveRecord({
        generation: 7,
        maybeRevision: Option.some(REVISION_6),
        saved: { ...ticketRecord, version: 4 },
      })
    );
    expect({
      client: request?.headers["std-client"],
      ifMatch: request?.headers["if-match"],
      method: request?.method,
      revision: request?.headers["std-schema-revision"],
    }).toStrictEqual({
      client: "web",
      ifMatch: '"3"',
      method: "PATCH",
      revision: REVISION_5,
    });
    expect(JSON.parse(request?.body ?? "")).toStrictEqual({
      description: null,
      pin: "n3w-pin",
      short_description: "Mine",
    });
    expect(JSON.stringify(updateCommand.args)).not.toContain("n3w-pin");
  });

  it.each(REFUSALS)(
    "an update refused with $name becomes what the form shows",
    async ({ answer, expected }) => {
      const { result } = await runUpdate({
        ...answer,
        headers: REVISION_HEADER,
      });

      expect(result).toStrictEqual(expected);
    }
  );

  it("a definition change set's refusal is shown with its message", async () => {
    const { result } = await runUpdate({
      body: {
        _tag: "DefinitionInvalid",
        problems: [
          {
            code: "unsupportedChange",
            definitionId: "f1",
            message: "type cannot change",
          },
        ],
      },
      status: 422,
    });

    expect(
      result._tag === "FailedSaveRecord" ? result.error._tag : result._tag
    ).toBe("Refused");
  });

  it("a create posts the body without If-Match", async () => {
    const api = fakeStdApi({
      [`/api/v1/tables/${TICKET}/records`]: {
        body: { record: ticketRecord, schemaRevision: 5 },
        headers: { "std-schema-revision": REVISION_5 },
        status: 201,
      },
    });

    const result = await Effect.runPromise(
      CreateRecord({
        generation: 1,
        revision: REVISION_5,
        secrets: {},
        table: TICKET,
        values: { short_description: "New" },
      }).effect.pipe(Effect.provide(api.layer))
    );

    const [request] = api.seen;

    expect(result._tag).toBe("SucceededSaveRecord");
    expect({
      body: request?.body,
      hasIfMatch: request !== undefined && "if-match" in request.headers,
      method: request?.method,
    }).toStrictEqual({
      body: '{"short_description":"New"}',
      hasIfMatch: false,
      method: "POST",
    });
  });

  it("a delete sends If-Match; Referenced is its own refusal", async () => {
    const api = fakeStdApi({
      [RECORD_PATH]: { body: { _tag: "Referenced" }, status: 409 },
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
      api.seen[0]?.headers["if-match"],
    ]).toStrictEqual(["DELETE", '"3"']);
  });

  it("a picker's search asks for the target with allowedFor, the filter and the display field", async () => {
    const api = fakeStdApi({
      "/api/v1/tables/core.user/records": {
        body: {
          nextCursor: null,
          records: [
            {
              class: "core.user",
              id: "u1",
              values: { name: "Alex Agent" },
              version: 1,
            },
            { class: "core.user", id: "u2", values: { name: "" }, version: 1 },
          ],
          schemaRevision: 5,
        },
        status: 200,
      },
    });

    const result = await Effect.runPromise(
      SearchTargets({
        allowedFor: `${TICKET}/assignee`,
        displayField: Option.some("name"),
        fieldId: "f",
        filter: Option.some('name contains "Al"'),
        generation: 3,
        revision: REVISION_5,
        target: "core.user",
      }).effect.pipe(Effect.provide(api.layer))
    );

    expect(result).toStrictEqual(
      Message.SucceededSearchTargets({
        fieldId: "f",
        generation: 3,
        items: [
          { id: "u1", label: "Alex Agent" },
          { id: "u2", label: "u2" },
        ],
        maybeRevision: Option.none(),
      })
    );
    expect(api.seen[0]?.query).toStrictEqual({
      allowedFor: `${TICKET}/assignee`,
      fields: "name",
      filter: 'name contains "Al"',
      limit: "10",
      sort: "name",
    });
    expect(api.seen[0]?.headers["std-schema-revision"]).toBe(REVISION_5);
  });

  it("a record read asks for labels", async () => {
    const found = await readRecord({
      body: { record: ticketRecord, schemaRevision: 5 },
      status: 200,
    });

    expect(found.seen[0]?.query).toStrictEqual({ labels: "true" });
    expect(found.result._tag).toBe("SucceededLoadRecord");
  });

  it("a record read tells NotFound and SchemaChanged apart", async () => {
    const missing = await readRecord({
      body: { _tag: "NotFound" },
      status: 404,
    });

    const stale = await readRecord({
      body: {
        _tag: "SchemaChanged",
        changes: [],
        currentRevision: REVISION_6,
        requestRevision: REVISION_5,
      },
      status: 409,
    });

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

  it("the history is read at the form's revision", async () => {
    const api = fakeStdApi({
      [`${RECORD_PATH}/history`]: {
        body: { entries: [], schemaRevision: 5 },
        headers: { "std-schema-revision": REVISION_5 },
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
        entries: [],
        generation: 2,
        maybeRevision: Option.some(REVISION_5),
      })
    );
    expect(api.seen[0]?.headers["std-schema-revision"]).toBe(REVISION_5);
  });
});
