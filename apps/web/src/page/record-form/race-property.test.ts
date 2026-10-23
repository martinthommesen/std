import { Option, Schema, pipe } from "effect";
import {
  array as arrayOf,
  assert as assertProperty,
  constant,
  constantFrom,
  nat,
  oneof,
  property,
  record as recordOf,
} from "fast-check";
import type { Arbitrary } from "fast-check";
import { AsyncData } from "foldkit";
import { describe, expect, it } from "vitest";

import { FieldInput } from "../../domain/form-input.ts";
import type { MetaTable } from "../../domain/metadata.ts";
/**
 * Races between renames and the form's requests in flight (decision 0020,
 * review round 3), as a property: random interleavings of a save answered
 * at an old revision, the form's and the concrete class's metadata at old
 * and new revisions (a rename of the edited field, and a back-reference
 * renamed, removed and made again), record rereads, and related-list
 * answers. Whatever the order:
 *
 * - the user's later edit is never dropped (nothing in these definitions
 *   warrants dropping it, so not even with a note);
 * - a related list's answer is taken only by the list instance that asked.
 */
import type { RecordJson } from "../../domain/record.ts";
import { SchemaRevision } from "../../domain/schema-revision.ts";
import {
  INCIDENT_ID,
  REVISION_5,
  REVISION_6,
  TICKET,
  TICKET_FIELDS,
  incidentRecord,
  incidentTable,
  ticketTable,
} from "../../form-fixture.ts";
import { REVISION_3, revision } from "../../table-fixture.ts";
import { Message, ReadPurpose } from "./message.ts";
import { FormMode } from "./model.ts";
import type { Model, RelatedList } from "./model.ts";
import { init, update } from "./update.ts";

/** The revisions the definitions go through. */
type Step = 5 | 6 | 7 | 8;

const STEPS: readonly Step[] = [5, 6, 7, 8];

const REVISIONS: Readonly<Record<Step, SchemaRevision>> = {
  5: REVISION_5,
  6: REVISION_6,
  7: revision("7.00000000-0000-4000-8000-000000000c07"),
  8: revision("8.00000000-0000-4000-8000-000000000c08"),
};

const stepOf = (at: SchemaRevision): Step =>
  STEPS.find((step) => REVISIONS[step] === at) ?? 8;

/** From revision 6 on, `short_description` is `summary`. */
const RENAMED_FROM: Step = 6;

const renamedFrom = (step: Step, table: MetaTable): MetaTable =>
  step < RENAMED_FROM
    ? table
    : {
        ...table,
        fields: table.fields.map((field) =>
          field.id === TICKET_FIELDS.shortDescription
            ? { ...field, apiName: "summary", name: "summary" }
            : field
        ),
      };

const tasksBy = (field: string): MetaTable["relatedLists"][number] => ({
  field,
  fieldLabel: field,
  label: "Task",
  table: "help.task",
});

/** The tasks' back-reference: `parent`, renamed, removed, and `parent` again. */
const RELATED_LISTS: Readonly<Record<Step, MetaTable["relatedLists"]>> = {
  5: [tasksBy("parent")],
  6: [tasksBy("parent_ticket")],
  7: [],
  8: [tasksBy("parent")],
};

const ticketAt = (step: Step): MetaTable => ({
  ...renamedFrom(step, ticketTable),
  relatedLists: RELATED_LISTS[step],
});

const incidentAt = (step: Step): MetaTable => renamedFrom(step, incidentTable);

const TASKS: MetaTable = { ...ticketTable, label: "Task", name: "help.task" };

/**
 * The incident as a read at a revision names it, after the save of "A".
 *
 * @param step - The revision.
 * @returns The record.
 */
const savedAt = (step: Step): RecordJson => ({
  ...incidentRecord,
  values: Object.fromEntries(
    Object.entries({ ...incidentRecord.values, short_description: "A" }).map(
      ([name, value]) => [
        name === "short_description" && step >= RENAMED_FROM ? "summary" : name,
        value,
      ]
    )
  ),
  version: 4,
});

/** What can happen next. */
type Event =
  | { readonly kind: "metadata"; readonly step: Step }
  | { readonly kind: "classMetadata"; readonly step: Step }
  | { readonly kind: "saveSucceeded" }
  | { readonly kind: "reread" }
  | { readonly kind: "openLists" }
  | { readonly kind: "relatedMetadata"; readonly index: number }
  | { readonly kind: "relatedPage"; readonly index: number };

const steps: Arbitrary<Step> = constantFrom(...STEPS);

// NOTE: weighted towards the related lists' events, whose races need
// longer sequences (ask, remove, make again, ask, answer late).
const event: Arbitrary<Event> = oneof(
  {
    arbitrary: recordOf({ kind: constant("metadata" as const), step: steps }),
    weight: 3,
  },
  {
    arbitrary: recordOf({
      kind: constant("classMetadata" as const),
      step: steps,
    }),
    weight: 2,
  },
  {
    arbitrary: recordOf({ kind: constant("saveSucceeded" as const) }),
    weight: 1,
  },
  { arbitrary: recordOf({ kind: constant("reread" as const) }), weight: 2 },
  { arbitrary: recordOf({ kind: constant("openLists" as const) }), weight: 3 },
  {
    arbitrary: recordOf({
      index: nat(2),
      kind: constant("relatedMetadata" as const),
    }),
    weight: 3,
  },
  {
    arbitrary: recordOf({
      index: nat(2),
      kind: constant("relatedPage" as const),
    }),
    weight: 3,
  }
);

/** A related list's request: the list and the request's number. */
const AskedSchema = Schema.Struct({
  generation: Schema.Int,
  listId: Schema.Int,
});

type Asked = typeof AskedSchema.Type;

const decodeAsked = Schema.decodeUnknownOption(AskedSchema);

/** A record read the page asked for. */
const ReadSchema = Schema.Struct({
  generation: Schema.Int,
  purpose: ReadPurpose,
  revision: SchemaRevision,
});

type Read = typeof ReadSchema.Type;

const decodeRead = Schema.decodeUnknownOption(ReadSchema);

/** A page request, with the list instance (as the harness tells them apart) that sent it. */
interface Issued extends Asked {
  readonly instance: number;
}

/** The harness: the page, the list instances it saw, and what it asked for. */
interface Run {
  readonly model: Model;
  readonly instances: ReadonlyMap<number, number>;
  readonly nextInstance: number;
  readonly pages: readonly Issued[];
  readonly metadataRequests: readonly Asked[];
  readonly maybeLastRead: Option.Option<Read>;
}

const after = (start: Model, ...messages: readonly Message[]): Model => {
  const [first, ...rest] = messages;

  return first === undefined
    ? start
    : after(update(start, first).model, ...rest);
};

/**
 * The incident's form at revision 5: the class's metadata loaded, "A"
 * saved and in flight, "AB" typed since.
 *
 * @returns The page.
 */
const start = (): Model =>
  after(
    init({
      id: 1,
      maybeAppRevision: Option.some(REVISION_3),
      mode: FormMode.Edit({ recordId: INCIDENT_ID }),
      table: TICKET,
    }).model,
    Message.SucceededLoadFormMetadata({
      revision: REVISION_5,
      table: ticketAt(5),
    }),
    Message.SucceededLoadRecord({
      generation: 1,
      maybeRevision: Option.some(REVISION_5),
      purpose: "Open",
      record: incidentRecord,
    }),
    Message.SucceededLoadClassMetadata({
      revision: REVISION_5,
      table: incidentAt(5),
    }),
    Message.UpdatedText({ fieldId: TICKET_FIELDS.shortDescription, text: "A" }),
    Message.ClickedSave(),
    Message.UpdatedText({ fieldId: TICKET_FIELDS.shortDescription, text: "AB" })
  );

/** Marks a related page's answer, so the harness knows which list took it. */
const MARK = 1000;

const markOf = (list: RelatedList): Option.Option<number> =>
  Option.flatMap(AsyncData.getData(list.records), (page) => page.maybeCount);

/**
 * The list instances after a step: a list ID the page did not have before
 * is a new instance.
 *
 * @param run - The harness before the step's lists were seen.
 * @param before - The page before the step.
 * @returns The harness, every list of the page with its instance.
 */
const seeInstances = (run: Run, before: readonly RelatedList[]): Run => {
  const known = new Set(before.map((list) => list.id));

  const fresh = run.model.relatedLists.filter(
    (list) => !known.has(list.id) || !run.instances.has(list.id)
  );

  return {
    ...run,
    instances: new Map([
      ...run.instances,
      ...fresh.map(
        (list, index) => [list.id, run.nextInstance + index] as const
      ),
    ]),
    nextInstance: run.nextInstance + fresh.length,
  };
};

const seeCommand = (
  current: Run,
  command: { readonly name: string; readonly args?: unknown }
): Run => {
  if (command.name === "LoadRelatedRecords") {
    return Option.match(decodeAsked(command.args), {
      onNone: () => current,
      onSome: (asked) => ({
        ...current,
        pages: [
          ...current.pages,
          { ...asked, instance: current.instances.get(asked.listId) ?? -1 },
        ],
      }),
    });
  }

  if (command.name === "LoadRelatedMetadata") {
    return Option.match(decodeAsked(command.args), {
      onNone: () => current,
      onSome: (asked) => ({
        ...current,
        metadataRequests: [...current.metadataRequests, asked],
      }),
    });
  }

  return command.name === "LoadRecord"
    ? { ...current, maybeLastRead: decodeRead(command.args) }
    : current;
};

const seeCommands = (
  run: Run,
  commands: readonly { readonly name: string; readonly args?: unknown }[]
): Run => {
  let current = run;

  for (const command of commands) {
    current = seeCommand(current, command);
  }

  return current;
};

const pick = <A>(items: readonly A[], index: number): Option.Option<A> =>
  Option.fromNullishOr(items[index % Math.max(1, items.length)]);

const messageOf = (run: Run, next: Event): Option.Option<Message> => {
  switch (next.kind) {
    case "metadata": {
      return Option.some(
        Message.SucceededLoadFormMetadata({
          revision: REVISIONS[next.step],
          table: ticketAt(next.step),
        })
      );
    }

    case "classMetadata": {
      return Option.some(
        Message.SucceededLoadClassMetadata({
          revision: REVISIONS[next.step],
          table: incidentAt(next.step),
        })
      );
    }

    case "saveSucceeded": {
      return Option.some(
        Message.SucceededSaveRecord({
          generation: 2,
          maybeRevision: Option.some(REVISION_5),
          saved: savedAt(5),
        })
      );
    }

    case "reread": {
      return pipe(
        run.maybeLastRead,
        Option.map((asked) =>
          Message.SucceededLoadRecord({
            generation: asked.generation,
            maybeRevision: Option.some(asked.revision),
            purpose: asked.purpose,
            record: savedAt(stepOf(asked.revision)),
          })
        )
      );
    }

    case "openLists": {
      return Option.map(
        Option.fromNullishOr(
          run.model.relatedLists.find((list) => !list.isOpen)
        ),
        (list) => Message.ToggledRelatedList({ isOpen: true, listId: list.id })
      );
    }

    case "relatedMetadata": {
      return Option.map(pick(run.metadataRequests, next.index), (asked) =>
        Message.SucceededLoadRelatedMetadata({
          ...asked,
          revision: REVISION_5,
          table: TASKS,
        })
      );
    }

    case "relatedPage": {
      const index = next.index % Math.max(1, run.pages.length);

      return Option.map(pick(run.pages, next.index), (asked) =>
        Message.SucceededLoadRelatedRecords({
          generation: asked.generation,
          listId: asked.listId,
          maybeRevision: Option.none(),
          page: {
            maybeCount: Option.some(MARK + index),
            maybeNextCursor: Option.none(),
            records: [],
          },
        })
      );
    }

    default: {
      return Option.none();
    }
  }
};

/**
 * Checks that a related page's answer was taken, if at all, only by the
 * list instance that asked for it.
 *
 * @param run - The harness after the step.
 * @param before - The page's lists before the step.
 * @param index - The answered request.
 */
const expectTakenByItsList = (
  run: Run,
  before: readonly RelatedList[],
  index: number
): void => {
  const mark = MARK + index;

  const takers = run.model.relatedLists.filter(
    (list) =>
      Option.contains(markOf(list), mark) &&
      !before.some(
        (earlier) =>
          earlier.id === list.id && Option.contains(markOf(earlier), mark)
      )
  );

  for (const list of takers) {
    expect(run.instances.get(list.id)).toBe(run.pages[index]?.instance);
  }
};

/**
 * Runs the events and checks both rules after each.
 *
 * @param events - What happens, in order.
 */
const runRace = (events: readonly Event[]): void => {
  const first: Run = {
    instances: new Map(),
    maybeLastRead: Option.none(),
    metadataRequests: [],
    model: start(),
    nextInstance: 0,
    pages: [],
  };

  let run = seeInstances(first, []);

  for (const next of events) {
    const maybeMessage = messageOf(run, next);

    if (Option.isSome(maybeMessage)) {
      const before = run.model.relatedLists;
      const result = update(run.model, maybeMessage.value);

      const seen = seeCommands(
        seeInstances({ ...run, model: result.model }, before),
        result.commands ?? []
      );

      expect(seen.model.edits[TICKET_FIELDS.shortDescription]).toStrictEqual(
        FieldInput.Text({ text: "AB" })
      );

      if (next.kind === "relatedPage") {
        expectTakenByItsList(
          seen,
          before,
          next.index % Math.max(1, run.pages.length)
        );
      }

      run = seen;
    }
  }
};

/**
 * Runs enough to meet the rarer race (a list removed and made again
 * between a request and its answer) every time. [judgment]
 */
const RUNS = 10_000;

const TIMEOUT_MS = 60_000;

describe("renames racing the form's requests", () => {
  it(
    "never drop a later edit, and never give an answer to another list",
    () => {
      expect(() => {
        assertProperty(
          property(arrayOf(event, { maxLength: 14 }), (events) => {
            runRace(events);
          }),
          { numRuns: RUNS }
        );
      }).not.toThrow();
    },
    TIMEOUT_MS
  );
});
