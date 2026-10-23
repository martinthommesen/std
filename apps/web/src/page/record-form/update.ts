/**
 * A record's form page (plan Step 2, workstream 2B): create and edit, with
 * client validation by `recordSchema`, saves with `If-Match`, version
 * conflicts that keep the user's input, delete with confirmation,
 * reference pickers, related lists and the history panel.
 *
 * Revisions (Contracts 6.2, 6.4): the page keeps the revision its
 * metadata was built at and sends it with every request built from that
 * metadata. A response stating a newer revision, or a `NotAllowed`
 * refusal, refreshes the metadata in the background, keeping the edits
 * (they are keyed by field ID). A read refused with `SchemaChanged` is
 * asked again after the refresh; a save never is: the user saves again.
 */
import { Combobox, DatePicker, Dialog } from "@foldkit/ui";
import type { MetaRelatedList } from "@std/definitions/table-metadata";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import { Equal, Option, Record, pipe } from "effect";
import { AsyncData, Update } from "foldkit";
import type { CalendarDate } from "foldkit/calendar";
import { modifyFields } from "foldkit/struct";

import { fieldShowOf } from "../../domain/form-fields.ts";
import { FieldInput } from "../../domain/form-input.ts";
import { listColumns, listFieldsParameter } from "../../domain/list-columns.ts";
import type { MetaField, MetaTable } from "../../domain/metadata.ts";
import type { HistoryEntry } from "../../domain/record.ts";
import {
  isNewerRevision,
  parseSchemaRevision,
} from "../../domain/schema-revision.ts";
import type { SchemaRevision } from "../../domain/schema-revision.ts";
import {
  mergeChanges,
  mergeDropped,
  reconcileWithMetadata,
  reconcileWithRecord,
} from "../../domain/stale-edits.ts";
import type { Reconciled } from "../../domain/stale-edits.ts";
import {
  apiNameIn,
  collectionOf,
  defaultSelectionOf,
  wireFieldOf,
} from "../../domain/wire.ts";
import { calendarDateOf, isoDateOf } from "../../filter-builder/condition.ts";
import { recordRouter, tableListRouter } from "../../route.ts";
import type { StdApi } from "../../std-client.ts";
import { Metadata, TargetMetadata } from "../table-list/model.ts";
import type { MetaError, RecordPage } from "../table-list/model.ts";
import {
  CreateRecord,
  DeleteRecord,
  FocusField,
  LoadClassMetadata,
  LoadFormMetadata,
  LoadHistory,
  LoadHistoryLabels,
  LoadRecord,
  LoadRelatedMetadata,
  LoadRelatedRecords,
  LoadTarget,
  NavigateAway,
  ReadToday,
  SearchTargets,
  USER_NAME_FIELD,
  USER_TABLE,
  UpdateRecord,
} from "./command.ts";
import {
  checkForm,
  classMetaOf,
  controlIdOf,
  datePickerIdOf,
  editedRecordOf,
  errorsByFieldId,
  fieldOf,
  fieldsOf,
  inputOf,
  isCreating,
  isEmptyBody,
  isReady,
  metaOf,
  pickerIdOf,
  recordOf,
} from "./form.ts";
import { Message, OutMessage } from "./message.ts";
import type { ReadPurpose, SavedRecord, UnreadSavedRecord } from "./message.ts";
import {
  ClassMetadata,
  Deletion,
  FormMode,
  HistoryEntries,
  PickerResults,
  RelatedMetadata,
  RelatedRecords,
  StoredRecord,
  Submission,
  WriteError,
} from "./model.ts";
import type {
  HistoryEntries as HistoryEntriesState,
  HistoryError,
  Model,
  Picker,
  PickerError,
  PickerItem,
  RecordError,
  RelatedError,
  RelatedList,
  StoredRecord as StoredRecordState,
} from "./model.ts";
import {
  PickerFilter,
  displayFieldOf,
  pickerFilterOf,
  pickerSortOf,
} from "./picker-search.ts";

type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  StdApi
>;

type PlainReturn = Update.Return<Model, Message, StdApi>;

type Step = Update.Step<Model, Message, StdApi>;

/** The reference pickers' Combobox, over record IDs. */
export const ReferenceCombobox = Combobox.create();

/**
 * Changes one entry of a record, if it has the key.
 *
 * @param entries - The record.
 * @param key - The key.
 * @param change - The change.
 * @returns The record, changed at that key.
 */
const modifyEntry = <A>(
  entries: Readonly<Record<string, A>>,
  key: string,
  change: (entry: A) => A
): Readonly<Record<string, A>> =>
  Option.match(Record.get(entries, key), {
    onNone: () => entries,
    onSome: (entry) => Record.set(entries, key, change(entry)),
  });

/**
 * Runs steps one after the other, each on the Model the one before made.
 *
 * @param steps - The steps.
 * @returns One step.
 */
const inSequence =
  (steps: readonly Step[]): Step =>
  (model) => {
    const [first, ...rest] = steps;

    return first === undefined
      ? { model }
      : Update.combine(model, [first, inSequence(rest)]);
  };

/** The calendar's today until the page has read it (never shown in practice). */
const FALLBACK_TODAY: CalendarDate = { day: 1, month: 1, year: 2000 };

/** The element ID of the delete confirmation. */
export const DELETE_DIALOG_ID = "record-delete-dialog";

// INIT

/** What a form page opens with. */
export interface InitConfig {
  /** The page's number among the pages the app opens. */
  readonly id: number;
  /** The endpoint table, from the route. */
  readonly table: string;
  /** Create, or edit the record with this ID. */
  readonly mode: FormMode;
  /** The latest revision the app has seen, sent with the first request. */
  readonly maybeAppRevision: Option.Option<SchemaRevision>;
}

/**
 * Opens a form: loads the endpoint's metadata (then the record, when
 * editing), and reads today's date for the Date Pickers.
 *
 * @param config - The table, the mode and the app's revision.
 * @returns The page, loading.
 */
export const init = (config: InitConfig): UpdateReturn => ({
  commands: [
    LoadFormMetadata({
      maybeRevision: config.maybeAppRevision,
      table: config.table,
    }),
    ReadToday(),
  ],
  model: {
    classMetadata: ClassMetadata.Idle(),
    datePickers: {},
    deleteDialog: Dialog.init({ id: DELETE_DIALOG_ID }),
    deletion: Deletion.Idle(),
    droppedEdits: [],
    edits: {},
    generation: 0,
    history: {
      entries: HistoryEntries.Idle(),
      failedLabelTables: [],
      generation: 0,
      isOpen: false,
      labels: {},
    },
    id: config.id,
    isShowingProblems: false,
    maybeAppRevision: config.maybeAppRevision,
    maybeEditsFrom: Option.none(),
    maybeRecordRevision: Option.none(),
    maybeToday: Option.none(),
    metadata: Metadata.Loading(),
    mode: config.mode,
    nextRelatedListId: 1,
    nextTargetRequest: 1,
    pickers: {},
    reconciledFields: [],
    record: StoredRecord.Idle(),
    relatedLists: [],
    serverErrors: {},
    staleChanges: [],
    submission: Submission.Idle(),
    table: config.table,
    targetRequests: {},
    targets: {},
  },
});

// CONTROLS

const todayOf = (model: Model): CalendarDate =>
  Option.getOrElse(model.maybeToday, () => FALLBACK_TODAY);

const dateOfInput = (input: FieldInput): Option.Option<string> =>
  FieldInput.guards.Day(input) || FieldInput.guards.Instant(input)
    ? input.maybeDate
    : Option.none();

const newDatePicker = (model: Model, field: MetaField): DatePicker.Model =>
  DatePicker.init({
    id: datePickerIdOf(field.id),
    today: todayOf(model),
    ...Option.match(
      Option.flatMap(dateOfInput(inputOf(model, field)), calendarDateOf),
      {
        onNone: () => ({}),
        onSome: (initialViewDate) => ({ initialViewDate }),
      }
    ),
  });

/**
 * The text a reference picker's input rests on: the label, else the ID.
 *
 * @param input - The field's input.
 * @returns The text, `""` when empty.
 */
export const restingLabelOf = (input: FieldInput): string =>
  FieldInput.guards.Reference(input)
    ? Option.getOrElse(
        Option.orElse(input.maybeLabel, () => input.maybeId),
        () => ""
      )
    : "";

const newPicker = (model: Model, field: MetaField): Picker => ({
  combobox: modifyFields(
    Combobox.init({ id: pickerIdOf(field.id), nullable: true }),
    { inputValue: () => restingLabelOf(inputOf(model, field)) }
  ),
  generation: 0,
  maybeNextCursor: Option.none(),
  maybeRefusedAt: Option.none(),
  query: "",
  results: PickerResults.Idle(),
});

/**
 * The fields the form offers an input for.
 *
 * @param model - The page.
 * @returns Those fields; none before the form is ready.
 */
export const editableFieldsOf = (model: Model): readonly MetaField[] => {
  if (!isReady(model)) {
    return [];
  }

  const maybeRecord = editedRecordOf(model);

  return fieldsOf(model).filter(
    (field) => fieldShowOf(field, maybeRecord)._tag === "Editable"
  );
};

const keepExisting = <A>(existing: A): A => existing;

/**
 * Asks for a reference target's metadata (decision 0020, review round 3,
 * Rule 2): the request gets the page's next request number, and only the
 * answer to a table's latest request counts, so an older answer arriving
 * after a newer one cannot replace it. Metadata already shown stays while
 * the new one loads.
 *
 * @param table - The target table.
 * @param revision - The form's revision.
 * @returns The step.
 */
const askForTarget =
  (table: string, revision: SchemaRevision): Step =>
  (model) => {
    const request = model.nextTargetRequest;

    return {
      commands: [LoadTarget({ request, revision, table })],
      model: modifyFields(model, {
        nextTargetRequest: (next) => next + 1,
        targetRequests: Record.set(table, request),
        targets: (known) =>
          Record.set(
            known,
            table,
            Option.match(
              Option.flatMap(Record.get(known, table), AsyncData.getData),
              {
                onNone: () => TargetMetadata.Loading(),
                onSome: (data) => TargetMetadata.Refreshing({ data }),
              }
            )
          ),
      }),
    };
  };

/**
 * Whether a target's answer is to the table's latest request.
 *
 * @param model - The page.
 * @param table - The target table.
 * @param request - The answered request's number.
 * @returns True for the awaited answer.
 */
const isLatestTargetAnswer = (
  model: Model,
  table: string,
  request: number
): boolean => Option.contains(Record.get(model.targetRequests, table), request);

/**
 * Creates the stateful controls the editable fields need and that the
 * page does not have yet: a Date Picker per date or date-time field, a
 * picker per reference field, and each picker target's metadata.
 *
 * @param model - The page.
 * @returns It, with the controls and the target requests.
 */
const setUpControls: Step = (model) =>
  Option.match(metaOf(model), {
    onNone: () => ({ model }),
    onSome: (meta) => {
      const editable = editableFieldsOf(model);

      const dateFields = editable.filter(
        (field) =>
          (field.type.kind === "date" || field.type.kind === "dateTime") &&
          !Record.has(model.datePickers, field.id)
      );

      const referenceFields = editable.filter(
        (field) =>
          field.type.kind === "reference" &&
          !Record.has(model.pickers, field.id)
      );

      const targets = [
        ...new Set(
          editable.flatMap((field) =>
            field.type.kind === "reference" &&
            field.type.target !== null &&
            !Record.has(model.targets, field.type.target)
              ? [field.type.target]
              : []
          )
        ),
      ];

      return inSequence(
        targets.map((table) => askForTarget(table, meta.revision))
      )(
        modifyFields(model, {
          datePickers: (pickers) =>
            Record.union(
              pickers,
              Record.fromIterableWith(dateFields, (field) => [
                field.id,
                newDatePicker(model, field),
              ]),
              keepExisting
            ),
          pickers: (pickers) =>
            Record.union(
              pickers,
              Record.fromIterableWith(referenceFields, (field) => [
                field.id,
                newPicker(model, field),
              ]),
              keepExisting
            ),
        })
      );
    },
  });

const restingPicker = (picker: Picker, text: string): Picker =>
  modifyFields(picker, {
    combobox: (combobox) => modifyFields(combobox, { inputValue: () => text }),
  });

/**
 * Puts each picker's input back on its field's current label, after the
 * stored record changed under it (a save or a reload).
 *
 * @param model - The page.
 * @returns It, with the pickers at rest.
 */
const resetPickerInputs = (model: Model): Model =>
  modifyFields(model, {
    pickers: Record.map((picker, fieldId) =>
      Option.match(fieldOf(model, fieldId), {
        onNone: () => picker,
        onSome: (field) =>
          restingPicker(picker, restingLabelOf(inputOf(model, field))),
      })
    ),
  });

// RELATED LISTS

/**
 * The name of a related list's entry: its table and reference field.
 *
 * @param entry - The related list.
 * @returns `table/field`.
 */
export const relatedKeyOf = (entry: MetaRelatedList): string =>
  `${entry.table}/${entry.field}`;

/**
 * A new, closed related list (decision 0020, review round 3, Rule 2): it
 * gets the page's next list ID, which no other list of the page ever had
 * or will have; its requests and answers carry that ID with their
 * generation, so an answer meant for a list that is gone, or for an
 * earlier list of the same name, reaches no list.
 *
 * @param id - Its ID.
 * @param entry - Its entry.
 * @returns The list.
 */
const closedRelatedList = (
  id: number,
  entry: MetaRelatedList
): RelatedList => ({
  cursors: [Option.none()],
  entry,
  generation: 0,
  id,
  isOpen: false,
  maybePendingCursors: Option.none(),
  metadata: RelatedMetadata.Idle(),
  metadataGeneration: 0,
  records: RelatedRecords.Idle(),
});

const isListOf =
  (entry: MetaRelatedList) =>
  (list: RelatedList): boolean =>
    relatedKeyOf(list.entry) === relatedKeyOf(entry);

/**
 * The list a new entry continues when no list has its name: after the
 * back-reference field was renamed, the one list of the same table whose
 * name went away, when that table has exactly one such list and one such
 * new entry (metadata gives related lists no ID, so anything less certain
 * starts afresh).
 *
 * @param lists - The lists before.
 * @param entries - The new metadata's entries.
 * @param entry - The new entry.
 * @returns The list it continues.
 */
const renamedListOf = (
  lists: readonly RelatedList[],
  entries: readonly MetaRelatedList[],
  entry: MetaRelatedList
): Option.Option<RelatedList> => {
  const newNames = new Set(entries.map(relatedKeyOf));

  const gone = lists.filter(
    (list) =>
      list.entry.table === entry.table &&
      !newNames.has(relatedKeyOf(list.entry))
  );

  const added = entries.filter(
    (candidate) =>
      candidate.table === entry.table && !lists.some(isListOf(candidate))
  );

  const [only] = gone;

  return gone.length === 1 && added.length === 1
    ? Option.fromNullishOr(only)
    : Option.none();
};

/**
 * The related lists of new metadata, in its order (decision 0020). Each
 * entry keeps its list (with the entry as the metadata now states it, so
 * requests use the field's current name), a renamed back-reference
 * continues its list, and a new entry gets a new list with the page's
 * next list ID; a list whose entry is gone is gone with its ID.
 *
 * @param model - The page.
 * @param table - The endpoint's new metadata.
 * @returns The page.
 */
const syncRelatedLists = (model: Model, table: MetaTable): Model => {
  if (isCreating(model)) {
    return model;
  }

  const before = model.relatedLists;

  const kept = table.relatedLists.map((entry) =>
    Option.map(
      Option.orElse(Option.fromNullishOr(before.find(isListOf(entry))), () =>
        renamedListOf(before, table.relatedLists, entry)
      ),
      (list) => modifyFields(list, { entry: () => entry })
    )
  );

  const created = kept.filter(Option.isNone).length;

  const lists = table.relatedLists.map((entry, index) =>
    Option.getOrElse(kept[index] ?? Option.none(), () =>
      closedRelatedList(
        model.nextRelatedListId +
          kept.slice(0, index).filter(Option.isNone).length,
        entry
      )
    )
  );

  return modifyFields(model, {
    nextRelatedListId: (next) => next + created,
    relatedLists: () => lists,
  });
};

const relatedListOf = (
  model: Model,
  listId: number
): Option.Option<RelatedList> =>
  Option.fromNullishOr(model.relatedLists.find((list) => list.id === listId));

const writeRelatedList = (
  model: Model,
  listId: number,
  change: (list: RelatedList) => RelatedList
): Model =>
  modifyFields(model, {
    relatedLists: (lists) =>
      lists.map((list) => (list.id === listId ? change(list) : list)),
  });

const relatedFilterOf = (
  list: RelatedList,
  related: MetaTable,
  recordId: string
): string =>
  `${apiNameIn(related.fields.map(wireFieldOf), list.entry.field)} = ${JSON.stringify(recordId)}`;

const reloadingRelated = (records: RelatedList["records"]) =>
  Option.match(AsyncData.getData(records), {
    onNone: () => RelatedRecords.Loading(),
    onSome: (data) => RelatedRecords.Refreshing({ data }),
  });

type CursorStack = readonly Option.Option<string>[];

const FIRST_PAGE: CursorStack = [Option.none()];

const loadingRelatedPage =
  (generation: number, cursors: CursorStack) =>
  (list: RelatedList): RelatedList =>
    modifyFields(list, {
      generation: () => generation,
      maybePendingCursors: () => Option.some(cursors),
      records: reloadingRelated,
    });

const relatedPageRequest = (
  model: Model,
  list: RelatedList,
  recordId: string,
  cursors: CursorStack
): PlainReturn =>
  Option.match(AsyncData.getData(list.metadata), {
    onNone: () => ({ model }),
    onSome: (meta) => {
      const generation = list.generation + 1;

      return {
        commands: [
          LoadRelatedRecords({
            columns: listColumns(meta.table).map(wireFieldOf),
            cursor: Option.flatten(Option.fromNullishOr(cursors.at(-1))),
            fields: listFieldsParameter(meta.table),
            filter: relatedFilterOf(list, meta.table, recordId),
            generation,
            listId: list.id,
            revision: meta.revision,
            table: list.entry.table,
          }),
        ],
        model: writeRelatedList(
          model,
          list.id,
          loadingRelatedPage(generation, cursors)
        ),
      };
    },
  });

/**
 * Asks for a page of a related list, once its table's metadata and the
 * record are known. The page's cursor stack becomes the list's only when
 * the page loads (`receiveRelatedRecords`).
 *
 * @param listId - The related list.
 * @param toCursors - The cursor stack of the page, from the list.
 * @returns The step.
 */
const requestRelatedPage =
  (listId: number, toCursors: (list: RelatedList) => CursorStack): Step =>
  (model) =>
    Option.match(Option.all([relatedListOf(model, listId), recordOf(model)]), {
      onNone: () => ({ model }),
      onSome: ([list, record]) =>
        relatedPageRequest(model, list, record.id, toCursors(list)),
    });

const firstRelatedPage = (listId: number): Step =>
  requestRelatedPage(listId, () => FIRST_PAGE);

const loadingRelatedMetadata =
  (generation: number) =>
  (list: RelatedList): RelatedList =>
    modifyFields(list, {
      metadata: (metadata) =>
        Option.match(AsyncData.getData(metadata), {
          onNone: () => RelatedMetadata.Loading(),
          onSome: (data) => RelatedMetadata.Refreshing({ data }),
        }),
      metadataGeneration: () => generation,
    });

const loadRelatedMetadata =
  (listId: number): Step =>
  (model) =>
    Option.match(Option.all([relatedListOf(model, listId), metaOf(model)]), {
      onNone: () => ({ model }),
      onSome: ([list, meta]) => {
        const generation = list.metadataGeneration + 1;

        return {
          commands: [
            LoadRelatedMetadata({
              generation,
              listId,
              revision: meta.revision,
              table: list.entry.table,
            }),
          ],
          model: writeRelatedList(
            model,
            listId,
            loadingRelatedMetadata(generation)
          ),
        };
      },
    });

const toggleRelatedList = (
  model: Model,
  listId: number,
  isOpen: boolean
): UpdateReturn => {
  const toggled = writeRelatedList(model, listId, (list) =>
    modifyFields(list, { isOpen: () => isOpen })
  );

  const isUnloaded = Option.exists(relatedListOf(model, listId), (list) =>
    AsyncData.isIdle(list.metadata)
  );

  return isOpen && isUnloaded
    ? loadRelatedMetadata(listId)(toggled)
    : { model: toggled };
};

const isRelatedPaging = (list: RelatedList): boolean =>
  AsyncData.isPending(list.records) || !AsyncData.hasData(list.records);

const pageRelated = (
  model: Model,
  listId: number,
  toCursors: (list: RelatedList) => Option.Option<CursorStack>
): UpdateReturn =>
  Option.match(
    pipe(
      relatedListOf(model, listId),
      Option.filter((list) => !isRelatedPaging(list)),
      Option.flatMap(toCursors)
    ),
    {
      onNone: () => ({ model }),
      onSome: (cursors) => requestRelatedPage(listId, () => cursors)(model),
    }
  );

const nextRelatedCursors = (list: RelatedList): Option.Option<CursorStack> =>
  Option.map(
    Option.flatMap(
      AsyncData.getData(list.records),
      (page) => page.maybeNextCursor
    ),
    (cursor) => [...list.cursors, Option.some(cursor)]
  );

const previousRelatedCursors = (
  list: RelatedList
): Option.Option<CursorStack> =>
  list.cursors.length > 1
    ? Option.some(list.cursors.slice(0, -1))
    : Option.none();

const NAME_REFUSALS: ReadonlySet<RelatedError> = new Set([
  "SchemaChanged",
  "UnknownField",
]);

/**
 * Whether a related list's page was refused because of its names: the
 * definitions changed (`SchemaChanged`), or the back-reference field is
 * unknown under its name (`UnknownField`, after a rename the form had not
 * seen). Both need the endpoint's metadata reloaded before asking again.
 *
 * @param list - The related list.
 * @returns True after such a refusal.
 */
const isRefusedRelatedPage = (list: RelatedList): boolean =>
  pipe(
    AsyncData.getError(list.records),
    Option.exists((reason) => NAME_REFUSALS.has(reason))
  );

/**
 * Whether the endpoint's metadata lets a related list ask for a page:
 * not while it reloads (its `relatedLists` may rename the back-reference),
 * and, after a refusal for the list's names, only once it reloaded
 * successfully (decision 0020): a failed reload leaves the old names.
 *
 * @param model - The page.
 * @param list - The related list.
 * @returns True when a request may be sent.
 */
const isParentReadyFor = (model: Model, list: RelatedList): boolean =>
  isRefusedRelatedPage(list)
    ? AsyncData.isSuccess(model.metadata)
    : !AsyncData.isPending(model.metadata);

/** A related list's answer: the list and the number of its request. */
interface RelatedAnswer {
  readonly listId: number;
  readonly generation: number;
}

const isMetadataAnswerOf = (list: RelatedList, answer: RelatedAnswer) =>
  list.id === answer.listId && list.metadataGeneration === answer.generation;

/**
 * A related list's table metadata arrived (for the list that asked, at
 * its latest request): its first page is asked for when the endpoint's
 * metadata allows (`isParentReadyFor`); otherwise the page is asked for
 * when that metadata arrives (`requestWaitingRelated`), and a refusal
 * stays on screen until then.
 *
 * @param model - The page.
 * @param answer - The list and the number of its request.
 * @param meta - The related table's metadata and its revision.
 * @returns The page.
 */
const receiveRelatedMetadata = (
  model: Model,
  answer: RelatedAnswer,
  meta: { readonly revision: SchemaRevision; readonly table: MetaTable }
): UpdateReturn => {
  const isAwaited = Option.exists(relatedListOf(model, answer.listId), (list) =>
    isMetadataAnswerOf(list, answer)
  );

  if (!isAwaited) {
    return { model };
  }

  const known = writeRelatedList(model, answer.listId, (list) =>
    modifyFields(list, {
      metadata: () => RelatedMetadata.Success({ data: meta }),
    })
  );

  const canAsk = Option.exists(relatedListOf(known, answer.listId), (list) =>
    isParentReadyFor(known, list)
  );

  return canAsk ? firstRelatedPage(answer.listId)(known) : { model: known };
};

const failRelatedMetadata = (
  model: Model,
  answer: RelatedAnswer,
  error: MetaError
): PlainReturn => ({
  model: writeRelatedList(model, answer.listId, (list) =>
    isMetadataAnswerOf(list, answer)
      ? modifyFields(list, {
          metadata: (metadata) =>
            Option.match(AsyncData.getData(metadata), {
              onNone: () => RelatedMetadata.Failure({ error }),
              onSome: (data) => RelatedMetadata.Stale({ data, error }),
            }),
        })
      : list
  ),
});

const receiveRelatedRecords = (
  model: Model,
  answer: RelatedAnswer,
  page: RecordPage
): PlainReturn => ({
  model: writeRelatedList(model, answer.listId, (list) =>
    list.generation === answer.generation
      ? modifyFields(list, {
          cursors: (cursors) =>
            Option.getOrElse(list.maybePendingCursors, () => cursors),
          maybePendingCursors: () => Option.none(),
          records: () => RelatedRecords.Success({ data: page }),
        })
      : list
  ),
});

const isCurrentRelated = (model: Model, answer: RelatedAnswer): boolean =>
  Option.exists(
    relatedListOf(model, answer.listId),
    (list) => list.generation === answer.generation
  );

const failRelatedRecords = (
  model: Model,
  answer: RelatedAnswer,
  error: RelatedError
): Model =>
  writeRelatedList(model, answer.listId, (list) =>
    list.generation === answer.generation
      ? modifyFields(list, {
          maybePendingCursors: () => Option.none(),
          records: (records) =>
            Option.match(AsyncData.getData(records), {
              onNone: () => RelatedRecords.Failure({ error }),
              onSome: (data) => RelatedRecords.Stale({ data, error }),
            }),
        })
      : list
  );

// HISTORY

const reloadingHistory = (entries: HistoryEntriesState): HistoryEntriesState =>
  Option.match(AsyncData.getData(entries), {
    onNone: () => HistoryEntries.Loading(),
    onSome: (data) => HistoryEntries.Refreshing({ data }),
  });

const failedHistory =
  (reason: HistoryError) =>
  (entries: HistoryEntriesState): HistoryEntriesState =>
    Option.match(AsyncData.getData(entries), {
      onNone: () => HistoryEntries.Failure({ error: reason }),
      onSome: (data) => HistoryEntries.Stale({ data, error: reason }),
    });

const requestHistory: Step = (model) =>
  Option.match(Option.all([metaOf(model), recordOf(model)]), {
    onNone: () => ({ model }),
    onSome: ([meta, record]) => {
      const generation = model.history.generation + 1;

      return {
        commands: [
          LoadHistory({
            generation,
            recordId: record.id,
            revision: meta.revision,
            table: model.table,
          }),
        ],
        model: modifyFields(model, {
          history: (history) =>
            modifyFields(history, {
              entries: reloadingHistory,
              generation: () => generation,
            }),
        }),
      };
    },
  });

const toggleHistory = (model: Model, isOpen: boolean): UpdateReturn => {
  const toggled = modifyFields(model, {
    history: (history) => modifyFields(history, { isOpen: () => isOpen }),
  });

  const needsLoad =
    AsyncData.isIdle(model.history.entries) ||
    AsyncData.isFailure(model.history.entries);

  return isOpen && needsLoad ? requestHistory(toggled) : { model: toggled };
};

/**
 * Reloads the history after a save, when it has been loaded.
 *
 * @param model - The page.
 * @returns It, reloading the history if shown before.
 */
const refreshHistory: Step = (model) =>
  AsyncData.isIdle(model.history.entries) ? { model } : requestHistory(model);

/**
 * The records a history names, by table: the users who made the changes
 * (`core.user`) and the old and new targets of every changed reference,
 * each table's IDs once, in the order they first appear.
 *
 * @param entries - The history's entries.
 * @returns The IDs, by table.
 */
export const historyRecordsOf = (
  entries: readonly HistoryEntry[]
): Readonly<Record<string, readonly string[]>> => {
  const named = entries.flatMap((entry) => [
    { id: entry.actor, table: USER_TABLE },
    ...Record.toEntries(entry.changes).flatMap(([name, change]) => {
      const field = entry.fields[name];

      if (field?.type.kind !== "reference" || !isJsonObject(change)) {
        return [];
      }

      const { target } = field.type;

      if (target === null) {
        return [];
      }

      return [change.before, change.after].flatMap((value) =>
        value !== undefined && isJsonString(value)
          ? [{ id: value, table: target }]
          : []
      );
    }),
  ]);

  const tables = [...new Set(named.map((record) => record.table))];

  return Object.fromEntries(
    tables.map((table) => [
      table,
      [
        ...new Set(
          named.flatMap((record) => (record.table === table ? [record.id] : []))
        ),
      ],
    ])
  );
};

/**
 * The API name of a table's display field, when the form knows it: the
 * users' `name`, or a reference target whose metadata the form loaded.
 *
 * @param model - The page.
 * @param table - The table.
 * @returns The API name, or none (the Command then reads the metadata).
 */
const displayFieldApiNameOf = (
  model: Model,
  table: string
): Option.Option<string> =>
  table === USER_TABLE
    ? Option.some(USER_NAME_FIELD)
    : pipe(
        Record.get(model.targets, table),
        Option.flatMap(AsyncData.getData),
        Option.flatMap((target) =>
          Option.fromNullishOr(
            target.fields.find((field) => field.name === target.displayField)
          )
        ),
        Option.map((field) => field.apiName)
      );

const receiveHistory = (
  model: Model,
  generation: number,
  entries: Parameters<typeof HistoryEntries.Success>[0]["data"]
): PlainReturn => {
  if (generation !== model.history.generation) {
    return { model };
  }

  const unknown = Record.toEntries(historyRecordsOf(entries)).flatMap(
    ([table, ids]) => {
      const known = Option.getOrElse(
        Record.get(model.history.labels, table),
        () => ({})
      );

      const missing = ids.filter((id) => !Record.has(known, id));

      return missing.length === 0 ? [] : [{ ids: missing, table }];
    }
  );

  const shown = modifyFields(model, {
    history: (history) =>
      modifyFields(history, {
        entries: () => HistoryEntries.Success({ data: entries }),
        failedLabelTables: () => [],
      }),
  });

  return Option.match(metaOf(model), {
    onNone: () => ({ model: shown }),
    onSome: (meta) => ({
      commands: unknown.map(({ ids, table }) =>
        LoadHistoryLabels({
          ids,
          maybeDisplayField: displayFieldApiNameOf(model, table),
          revision: meta.revision,
          table,
        })
      ),
      model: shown,
    }),
  });
};

/**
 * The history with the display values of one table's records added to
 * those it knows.
 *
 * @param history - The history panel.
 * @param table - The records' table.
 * @param labels - Their display values, by record ID.
 * @returns The panel.
 */
const withHistoryLabels = (
  history: Model["history"],
  table: string,
  labels: Readonly<Record<string, string>>
): Model["history"] => {
  const known = Option.getOrElse(Record.get(history.labels, table), () => ({}));

  return modifyFields(history, {
    labels: Record.set(table, Record.union(known, labels, keepExisting)),
  });
};

// REVISIONS

/**
 * Reloads the endpoint's metadata in the background (and the concrete
 * class's), keeping everything on screen and every edit: the hook stale
 * forms build on (workstream 2C).
 *
 * @param model - The page.
 * @returns The page, refreshing, and the requests.
 */
export const refreshMetadata: Step = (model) =>
  Option.match(metaOf(model), {
    onNone: () => ({ model }),
    onSome: (meta) =>
      AsyncData.isPending(model.metadata)
        ? { model }
        : {
            commands: [
              LoadFormMetadata({
                maybeRevision: Option.some(meta.revision),
                table: model.table,
              }),
            ],
            model: modifyFields(model, {
              metadata: () => Metadata.Refreshing({ data: meta }),
            }),
          },
  });

const refreshIfNewer =
  (maybeRevision: Option.Option<SchemaRevision>): Step =>
  (model) =>
    Option.match(Option.all([maybeRevision, metaOf(model)]), {
      onNone: () => ({ model }),
      onSome: ([revision, meta]) =>
        isNewerRevision(revision, meta.revision)
          ? refreshMetadata(model)
          : { model },
    });

const sawRevision = (
  result: Update.Return<Model, Message, StdApi>,
  maybeRevision: Option.Option<SchemaRevision>
): UpdateReturn =>
  Update.withOutMessage(
    result,
    Option.getOrUndefined(
      pipe(
        maybeRevision,
        Option.map((revision) => OutMessage.SawRevision({ revision }))
      )
    )
  );

// RELATED LISTS AFTER A REFRESH

/**
 * A related list's page that did not load; the cursor stays on the page
 * shown. Refused for its names (`SchemaChanged` or `UnknownField`,
 * decision 0020), the page reloads the endpoint's metadata (its
 * `relatedLists` name the back-reference field as it is now) and the
 * related table's, and asks for the first page once both loaded
 * (`receiveRelatedMetadata`, `requestWaitingRelated`).
 *
 * @param model - The page.
 * @param answer - The list and the number of the answered request.
 * @param error - Why it did not load.
 * @returns The page, reloading what the refusal needs.
 */
const failRelatedPage = (
  model: Model,
  answer: RelatedAnswer,
  error: RelatedError
): UpdateReturn => {
  if (!isCurrentRelated(model, answer)) {
    return { model };
  }

  const failed = failRelatedRecords(model, answer, error);

  return NAME_REFUSALS.has(error)
    ? Update.combine(failed, [
        refreshMetadata,
        loadRelatedMetadata(answer.listId),
      ])
    : { model: failed };
};

// NOTE: a page that failed for any reason is asked again once the
// endpoint's metadata arrives: "Try again" after a failed reload of that
// metadata leaves the page to it, and a read is safe to repeat.
const isWaitingForPage = (list: RelatedList): boolean => {
  const isUnasked =
    AsyncData.isIdle(list.records) || AsyncData.hasError(list.records);

  return list.isOpen && AsyncData.isSuccess(list.metadata) && isUnasked;
};

/**
 * Asks for the first page of each open related list that waits for one
 * (never loaded, or failed: refused for its names, or not answered) and
 * whose table's metadata is loaded, after the endpoint's metadata arrived.
 *
 * @param model - The page.
 * @returns It, with the requests.
 */
const requestWaitingRelated: Step = (model) =>
  inSequence(
    model.relatedLists.flatMap((list) =>
      isWaitingForPage(list) ? [firstRelatedPage(list.id)] : []
    )
  )(model);

/**
 * "Try again" on a related list: after a refusal for its names, or when
 * the endpoint's last metadata reload failed, both metadata are reloaded
 * (the first page follows once both loaded); when its table's metadata
 * did not load, that is reloaded; otherwise the page shown is asked for
 * again, with the back-reference's current name.
 *
 * @param model - The page.
 * @param listId - The related list.
 * @returns The page and its Commands.
 */
const retryRelatedList = (model: Model, listId: number): UpdateReturn =>
  Option.match(relatedListOf(model, listId), {
    onNone: () => ({ model }),
    onSome: (list) => {
      if (isRefusedRelatedPage(list) || AsyncData.isStale(model.metadata)) {
        return Update.combine(model, [
          refreshMetadata,
          loadRelatedMetadata(listId),
        ]);
      }

      return AsyncData.isSuccess(list.metadata)
        ? requestRelatedPage(listId, (current) => current.cursors)(model)
        : loadRelatedMetadata(listId)(model);
    },
  });

// HISTORY AFTER A REFRESH

/**
 * A history that did not load. Refused with `SchemaChanged`, the page
 * reloads its metadata, and the history is asked again once it arrives
 * (`receiveMetadata`), since repeating a read is safe (Contracts 6.4).
 *
 * @param model - The page.
 * @param generation - The answered request's number.
 * @param error - Why it did not load.
 * @returns The page.
 */
const failHistory = (
  model: Model,
  generation: number,
  error: HistoryError
): PlainReturn => {
  if (generation !== model.history.generation) {
    return { model };
  }

  const failed = modifyFields(model, {
    history: (history) =>
      modifyFields(history, { entries: failedHistory(error) }),
  });

  return error === "SchemaChanged"
    ? refreshMetadata(failed)
    : { model: failed };
};

/**
 * Asks for the history again after the metadata moved on, when its last
 * request was refused with `SchemaChanged`.
 *
 * @param model - The page.
 * @returns The page, reloading the history if it was refused.
 */
const retryRefusedHistory: Step = (model) =>
  Option.contains(AsyncData.getError(model.history.entries), "SchemaChanged")
    ? requestHistory(model)
    : { model };

// EDITS

const forgetServerErrors =
  (fieldId: string) =>
  (model: Model): Model =>
    modifyFields(model, {
      serverErrors: Record.remove(fieldId),
      submission: (submission) =>
        Submission.guards.Saved(submission) ||
        Submission.guards.Unchanged(submission)
          ? Submission.Idle()
          : submission,
    });

/**
 * Sets a field's input, when the form offers one for it.
 *
 * @param model - The page.
 * @param fieldId - The field.
 * @param toInput - The new input, from the field and its current input.
 * @returns The page.
 */
const editField = (
  model: Model,
  fieldId: string,
  toInput: (field: MetaField, current: FieldInput) => FieldInput
): PlainReturn =>
  Option.match(
    pipe(
      fieldOf(model, fieldId),
      Option.filter((field) =>
        editableFieldsOf(model).some((editable) => editable.id === field.id)
      )
    ),
    {
      onNone: () => ({ model }),
      onSome: (field) => ({
        model: forgetServerErrors(fieldId)(
          modifyFields(model, {
            edits: Record.set(fieldId, toInput(field, inputOf(model, field))),
          })
        ),
      }),
    }
  );

/**
 * Removes a field's edit: the field shows and keeps its stored value.
 *
 * @param model - The page.
 * @param fieldId - The field.
 * @returns The page.
 */
const forgetEdit = (model: Model, fieldId: string): PlainReturn => ({
  model: forgetServerErrors(fieldId)(
    modifyFields(model, { edits: Record.remove(fieldId) })
  ),
});

const MIDNIGHT = "00:00";

const timeWith = (maybeDate: Option.Option<string>, time: string): string => {
  if (Option.isNone(maybeDate)) {
    return "";
  }

  return time === "" ? MIDNIGHT : time;
};

const withDate =
  (maybeDate: Option.Option<string>) =>
  (_field: MetaField, current: FieldInput): FieldInput =>
    FieldInput.guards.Instant(current)
      ? FieldInput.Instant({
          maybeDate,
          time: timeWith(maybeDate, current.time),
        })
      : FieldInput.Day({ maybeDate });

const foldDatePicker = Update.foldChildAt({
  foldOutMessage: (fieldId: string) =>
    DatePicker.OutMessage.match<Step>({
      // oxlint-disable-next-line sonarjs/function-name -- an OutMessage.match case is keyed by its OutMessage's tag
      ChangedViewMonth: () => (model) => ({ model }),
      // oxlint-disable-next-line sonarjs/function-name -- an OutMessage.match case is keyed by its OutMessage's tag
      ClearedDate: () => (model) =>
        editField(model, fieldId, withDate(Option.none())),
      // oxlint-disable-next-line sonarjs/function-name -- an OutMessage.match case is keyed by its OutMessage's tag
      SelectedDate:
        ({ date }) =>
        (model) =>
          editField(model, fieldId, withDate(Option.some(isoDateOf(date)))),
    }),
  readAt: (model: Model, fieldId: string) =>
    Record.get(model.datePickers, fieldId),
  toParentMessage: (fieldId, message) =>
    Message.GotDatePickerMessage({ fieldId, message }),
  update: DatePicker.update,
  writeAt: (model: Model, fieldId: string, nextPicker: DatePicker.Model) =>
    modifyFields(model, {
      datePickers: Record.set(fieldId, nextPicker),
    }),
});

// PICKERS

const pickedItem = (
  model: Model,
  fieldId: string,
  id: string
): Option.Option<PickerItem> =>
  pipe(
    Record.get(model.pickers, fieldId),
    Option.flatMap((picker) => AsyncData.getData(picker.results)),
    Option.flatMap((items) =>
      Option.fromNullishOr(items.find((item) => item.id === id))
    )
  );

const selectTarget =
  (fieldId: string, id: string): Step =>
  (model) =>
    editField(model, fieldId, (_field, current) => {
      const isSelected =
        FieldInput.guards.Reference(current) &&
        Option.contains(current.maybeId, id);

      return isSelected
        ? FieldInput.Reference({
            maybeId: Option.none(),
            maybeLabel: Option.none(),
          })
        : FieldInput.Reference({
            maybeId: Option.some(id),
            maybeLabel: Option.map(
              pickedItem(model, fieldId, id),
              (item) => item.label
            ),
          });
    });

const clearTarget =
  (fieldId: string): Step =>
  (model) =>
    editField(model, fieldId, () =>
      FieldInput.Reference({
        maybeId: Option.none(),
        maybeLabel: Option.none(),
      })
    );

const writePicker = (
  model: Model,
  fieldId: string,
  change: (picker: Picker) => Picker
): Model =>
  modifyFields(model, {
    pickers: (pickers) => modifyEntry(pickers, fieldId, change),
  });

/**
 * The item a picker lists after its results when the server has more: it
 * is never a target, and choosing it loads the next page into the list.
 */
export const MORE_RESULTS_ITEM = "std:more-results";

/** The text of the "more results" item. */
export const MORE_RESULTS_TEXT = "Show more results";

const searchingPicker =
  (generation: number, query: string, isMore: boolean) =>
  (picker: Picker): Picker =>
    modifyFields(picker, {
      generation: () => generation,
      maybeNextCursor: (cursor) => (isMore ? cursor : Option.none()),
      maybeRefusedAt: () => Option.none(),
      query: () => query,
      results: (results) =>
        Option.match(AsyncData.getData(results), {
          onNone: () => PickerResults.Loading(),
          onSome: (data) => PickerResults.Refreshing({ data }),
        }),
    });

const targetOfField = (model: Model, fieldId: string): string | null =>
  Option.match(fieldOf(model, fieldId), {
    onNone: () => null,
    onSome: (field) =>
      field.type.kind === "reference" ? field.type.target : null,
  });

/**
 * The pickers waiting on a target whose metadata did not load: they cannot
 * search, and say so instead of waiting.
 *
 * @param model - The page.
 * @param table - The target table.
 * @returns The page.
 */
const failTargetPickers = (model: Model, table: string): PlainReturn => ({
  model: modifyFields(model, {
    pickers: Record.map((picker, fieldId) =>
      targetOfField(model, fieldId) === table &&
      AsyncData.isPending(picker.results)
        ? modifyFields(picker, {
            results: () => PickerResults.Failure({ error: "Unavailable" }),
          })
        : picker
    ),
  }),
});

/**
 * A picker that waits for its target's metadata: when that metadata did
 * not load because the server did not answer, it is asked for again (the
 * waiting search runs once it arrives, `receiveTarget`); a target the
 * caller cannot open stays failed, and its pickers say they cannot search.
 *
 * @param model - The page, its picker waiting.
 * @param target - The target table, if the caller knows it.
 * @param revision - The form's revision.
 * @returns The page, and the reload if one is needed.
 */
const reloadFailedTarget = (
  model: Model,
  target: string | null,
  revision: SchemaRevision
): PlainReturn => {
  const maybeError = pipe(
    Option.fromNullishOr(target),
    Option.flatMap((name) => Record.get(model.targets, name)),
    Option.flatMap(AsyncData.getError)
  );

  if (target === null || !Option.contains(maybeError, "Unavailable")) {
    return Option.isSome(maybeError) && target !== null
      ? failTargetPickers(model, target)
      : { model };
  }

  return askForTarget(target, revision)(model);
};

/** What one picker search asks for. */
interface PickerSearchRequest {
  readonly allowedFor: string;
  readonly cursor: Option.Option<string>;
  readonly fieldId: string;
  readonly generation: number;
  readonly query: string;
  readonly revision: SchemaRevision;
  readonly target: MetaTable;
}

const withNoResults = (picker: Picker): Picker =>
  modifyFields(picker, {
    results: () => PickerResults.Success({ data: [] }),
  });

/**
 * Sends a picker's search, or, for a text no target can match, shows no
 * results without asking.
 *
 * @param waiting - The page, its picker searching.
 * @param request - The search.
 * @returns The page and the request, if any.
 */
const searchOrNothing = (
  waiting: Model,
  request: PickerSearchRequest
): PlainReturn => {
  const filter = pickerFilterOf(request.target, request.query);

  if (PickerFilter.guards.NothingMatches(filter)) {
    return { model: writePicker(waiting, request.fieldId, withNoResults) };
  }

  return {
    commands: [
      SearchTargets({
        allowedFor: request.allowedFor,
        cursor: request.cursor,
        display: displayFieldOf(request.target),
        fieldId: request.fieldId,
        filter: filter.filter,
        generation: request.generation,
        revision: request.revision,
        sort: pickerSortOf(request.target),
        target: request.target.name,
      }),
    ],
    model: waiting,
  };
};

/**
 * Asks for a picker's targets (decision 0020): those the caller can see
 * that the field's allowed-records condition admits (`allowedFor`), whose
 * display field matches the text by an operation its type supports, or
 * whose ID it is (`picker-search.ts`), from `cursor` when the picker asks
 * for more. A text nothing can match asks nothing. Waits for the target's
 * metadata.
 *
 * @param fieldId - The reference field.
 * @param query - The typed text; `""` lists the first targets.
 * @param cursor - The next page's cursor, for "more results".
 * @returns The step.
 */
const searchTargets =
  (
    fieldId: string,
    query: string,
    cursor: Option.Option<string> = Option.none()
  ): Step =>
  (model) =>
    Option.match(Option.all([fieldOf(model, fieldId), metaOf(model)]), {
      onNone: () => ({ model }),
      onSome: ([field, meta]) => {
        const target =
          field.type.kind === "reference" ? field.type.target : null;

        const maybeTargetMeta = pipe(
          Option.fromNullishOr(target),
          Option.flatMap((name) => Record.get(model.targets, name)),
          Option.flatMap(AsyncData.getData)
        );

        const generation = Option.match(Record.get(model.pickers, fieldId), {
          onNone: () => 0,
          onSome: (picker) => picker.generation + 1,
        });

        const waiting = writePicker(
          model,
          fieldId,
          searchingPicker(generation, query, Option.isSome(cursor))
        );

        return Option.match(maybeTargetMeta, {
          onNone: () => reloadFailedTarget(waiting, target, meta.revision),
          onSome: (targetMeta) =>
            searchOrNothing(waiting, {
              allowedFor: `${collectionOf(model.table)}/${field.apiName}`,
              cursor,
              fieldId,
              generation,
              query,
              revision: meta.revision,
              target: targetMeta,
            }),
        });
      },
    });

/**
 * "Show more results": the next page of the picker's latest search,
 * added to its list.
 *
 * @param fieldId - The reference field.
 * @returns The step; nothing while a search runs or without a next page.
 */
const loadMoreTargets =
  (fieldId: string): Step =>
  (model) =>
    Option.match(
      pipe(
        Record.get(model.pickers, fieldId),
        Option.filter((picker) => !AsyncData.isPending(picker.results))
      ),
      {
        onNone: () => ({ model }),
        onSome: (picker) =>
          Option.match(picker.maybeNextCursor, {
            onNone: () => ({ model }),
            onSome: (cursor) =>
              searchTargets(fieldId, picker.query, Option.some(cursor))(model),
          }),
      }
    );

const foldPicker = Update.foldChildAt({
  foldOutMessage: (fieldId: string) =>
    Combobox.OutMessage.match<Step>({
      // oxlint-disable-next-line sonarjs/function-name -- an OutMessage.match case is keyed by its OutMessage's tag
      ClearedSelection: () => clearTarget(fieldId),
      // oxlint-disable-next-line sonarjs/function-name -- an OutMessage.match case is keyed by its OutMessage's tag
      Selected: ({ value }) => selectTarget(fieldId, value),
    }),
  readAt: (model: Model, fieldId: string) =>
    pipe(
      Record.get(model.pickers, fieldId),
      Option.map((picker) => picker.combobox)
    ),
  toParentMessage: (fieldId, message) =>
    Message.GotPickerMessage({ fieldId, message }),
  update: ReferenceCombobox.update,
  writeAt: (model: Model, fieldId: string, nextCombobox: Combobox.Model) =>
    writePicker(model, fieldId, (picker) =>
      modifyFields(picker, { combobox: () => nextCombobox })
    ),
});

/**
 * A picker's Message: choosing "Show more results" loads the next page
 * and leaves the Combobox open as it is (it is never a selection);
 * otherwise the Combobox's own update, then a search when the user opens
 * the list (the first targets) or types.
 *
 * @param model - The page.
 * @param fieldId - The reference field.
 * @param message - The Combobox's Message.
 * @returns The page and its Commands.
 */
const updatePicker = (
  model: Model,
  fieldId: string,
  message: Combobox.Message
): UpdateReturn => {
  if (message._tag === "SelectedItem" && message.item === MORE_RESULTS_ITEM) {
    return loadMoreTargets(fieldId)(model);
  }

  const folded = foldPicker(model, fieldId, message);

  if (message._tag === "UpdatedInputValue") {
    return Update.combine(folded.model, [
      () => folded,
      searchTargets(fieldId, message.value),
    ]);
  }

  // NOTE: the toggle button opens the Combobox without an `Opened`
  // Message, so its opening asks for the first targets too; otherwise a
  // field that already holds a value showed an empty, closed list.
  const isOpenedByButton =
    message._tag === "PressedToggleButton" &&
    !Option.exists(
      Record.get(model.pickers, fieldId),
      (picker) => picker.combobox.isOpen
    );

  return message._tag === "Opened" || isOpenedByButton
    ? Update.combine(folded.model, [() => folded, searchTargets(fieldId, "")])
    : folded;
};

/**
 * Searches again, as a new search of its text, each picker whose search
 * was refused with `SchemaChanged` (decision 0020), once the form's
 * metadata moved past the revision the search was sent at and its
 * target's metadata is loaded, neither of them still loading.
 *
 * @param model - The page.
 * @returns It, with the searches.
 */
const retryRefusedSearches: Step = (model) =>
  Option.match(
    pipe(
      metaOf(model),
      Option.filter(() => !AsyncData.isPending(model.metadata))
    ),
    {
      onNone: () => ({ model }),
      onSome: (meta) =>
        inSequence(
          Record.toEntries(model.pickers).flatMap(([fieldId, picker]) => {
            const isTargetLoaded = pipe(
              Option.fromNullishOr(targetOfField(model, fieldId)),
              Option.flatMap((table) => Record.get(model.targets, table)),
              Option.exists(AsyncData.isSuccess)
            );

            const isRefusedBefore = Option.exists(
              picker.maybeRefusedAt,
              (revision) => revision !== meta.revision
            );

            return isRefusedBefore && isTargetLoaded
              ? [searchTargets(fieldId, picker.query)]
              : [];
          })
        )(model),
    }
  );

const receiveTarget = (
  model: Model,
  target: MetaTable,
  request: number
): UpdateReturn => {
  if (!isLatestTargetAnswer(model, target.name, request)) {
    return { model };
  }

  const known = modifyFields(model, {
    targets: Record.set(target.name, TargetMetadata.Success({ data: target })),
  });

  const waiting = Record.toEntries(model.pickers).flatMap(
    ([fieldId, picker]) =>
      AsyncData.isLoading(picker.results) ||
      AsyncData.isRefreshing(picker.results)
        ? [searchTargets(fieldId, picker.query)]
        : []
  );

  return inSequence([...waiting, retryRefusedSearches])(known);
};

/**
 * A target whose metadata did not load: its pickers cannot search, and say
 * so instead of waiting.
 *
 * @param model - The page.
 * @param table - The target table.
 * @param request - The answered request's number.
 * @param reason - Why its metadata did not load.
 * @returns The page.
 */
const failTarget = (
  model: Model,
  table: string,
  request: number,
  reason: MetaError
): PlainReturn =>
  isLatestTargetAnswer(model, table, request)
    ? failTargetPickers(
        modifyFields(model, {
          targets: Record.set(table, TargetMetadata.Failure({ error: reason })),
        }),
        table
      )
    : { model };

/**
 * A picker's results: a new search's replace the list, "more results"
 * are added to it (a target listed already is not listed twice).
 *
 * @param model - The page.
 * @param fieldId - The reference field.
 * @param answer - The search's number, its cursor, the targets and the
 *   next page's cursor.
 * @returns The page.
 */
/** A picker search's answer. */
interface SearchAnswer {
  readonly cursor: Option.Option<string>;
  readonly generation: number;
  readonly items: readonly PickerItem[];
  readonly maybeNextCursor: Option.Option<string>;
}

const resultsWith = (
  results: Picker["results"],
  answer: SearchAnswer
): Picker["results"] => {
  const shown = Option.isSome(answer.cursor)
    ? Option.getOrElse(AsyncData.getData(results), () => [])
    : [];

  const shownIds = new Set(shown.map((item) => item.id));

  return PickerResults.Success({
    data: [...shown, ...answer.items.filter((item) => !shownIds.has(item.id))],
  });
};

const answeredPicker =
  (answer: SearchAnswer) =>
  (picker: Picker): Picker =>
    picker.generation === answer.generation
      ? modifyFields(picker, {
          maybeNextCursor: () => answer.maybeNextCursor,
          results: (results) => resultsWith(results, answer),
        })
      : picker;

const receiveSearch = (
  model: Model,
  fieldId: string,
  answer: SearchAnswer
): PlainReturn => ({
  model: writePicker(model, fieldId, answeredPicker(answer)),
});

/**
 * Reloads a target's metadata in the background, keeping it for the
 * pickers until the new one arrives.
 *
 * @param table - The target table.
 * @returns The step.
 */
const refreshTarget =
  (table: string | null): Step =>
  (model) =>
    Option.match(Option.all([Option.fromNullishOr(table), metaOf(model)]), {
      onNone: () => ({ model }),
      onSome: ([name, meta]) => askForTarget(name, meta.revision)(model),
    });

/**
 * A picker's search that did not answer. Refused with `SchemaChanged`
 * (decision 0020), the refusal is kept on the picker and the page reloads
 * the target's metadata (its display field may have changed) and its own
 * (the field's allowed records may have); the search runs again once both
 * arrived (`retryRefusedSearches`).
 *
 * @param model - The page.
 * @param fieldId - The reference field.
 * @param failure - The search's number, why it failed, the revision it was
 *   sent at and the refusal's current revision.
 * @returns The page, and what the app should know.
 */
const failSearch = (
  model: Model,
  fieldId: string,
  failure: {
    readonly error: PickerError;
    readonly generation: number;
    readonly maybeRevision: Option.Option<SchemaRevision>;
    readonly revision: SchemaRevision;
  }
): UpdateReturn => {
  const isCurrent = Option.exists(
    Record.get(model.pickers, fieldId),
    (picker) => picker.generation === failure.generation
  );

  if (!isCurrent) {
    return { model };
  }

  const failed = writePicker(model, fieldId, (picker) =>
    modifyFields(picker, {
      maybeRefusedAt: () =>
        failure.error === "SchemaChanged"
          ? Option.some(failure.revision)
          : Option.none(),
      results: (results) =>
        Option.match(AsyncData.getData(results), {
          onNone: () => PickerResults.Failure({ error: failure.error }),
          onSome: (data) => PickerResults.Stale({ data, error: failure.error }),
        }),
    })
  );

  if (failure.error !== "SchemaChanged") {
    return { model: failed };
  }

  return Update.withOutMessage(
    Update.combine(failed, [
      refreshTarget(targetOfField(model, fieldId)),
      refreshMetadata,
    ]),
    Option.getOrUndefined(
      pipe(
        failure.maybeRevision,
        Option.map((revision) => OutMessage.SawCurrentRevision({ revision }))
      )
    )
  );
};

// THE RECORD

const reloadingRecord = (record: StoredRecordState): StoredRecordState =>
  Option.match(AsyncData.getData(record), {
    onNone: () => StoredRecord.Loading(),
    onSome: (data) => StoredRecord.Refreshing({ data }),
  });

const requestRecord =
  (purpose: ReadPurpose): Step =>
  (model) =>
    Option.match(metaOf(model), {
      onNone: () => ({ model }),
      onSome: (meta) =>
        FormMode.guards.Edit(model.mode)
          ? {
              commands: [
                LoadRecord({
                  generation: model.generation + 1,
                  purpose,
                  recordId: model.mode.recordId,
                  revision: meta.revision,
                  selected: defaultSelectionOf(meta.table),
                  table: model.table,
                }),
              ],
              model: modifyFields(model, {
                generation: (generation) => generation + 1,
                record: reloadingRecord,
              }),
            }
          : { model },
    });

/**
 * Loads the concrete class's metadata when the record's class is not the
 * endpoint's (and the page does not have it at this revision).
 *
 * @param model - The page, with the record.
 * @returns It, loading the class's metadata if needed.
 */
const requestClassMetadata: Step = (model) =>
  Option.match(Option.all([metaOf(model), recordOf(model)]), {
    onNone: () => ({ model }),
    onSome: ([meta, record]) => {
      const isOther = record.class !== meta.table.resourceType;

      const isCurrent = Option.exists(
        classMetaOf(model),
        (concrete) => concrete.resourceType === record.class
      );

      return isOther && !isCurrent && !AsyncData.isPending(model.classMetadata)
        ? {
            commands: [
              LoadClassMetadata({
                resourceType: record.class,
                revision: meta.revision,
              }),
            ],
            model: modifyFields(model, {
              classMetadata: () => ClassMetadata.Loading(),
            }),
          }
        : { model };
    },
  });

/**
 * Whether the last save was refused with `SchemaChanged`: once the
 * metadata moved on, the user can save again (the changed fields stay
 * marked through `staleChanges`).
 *
 * @param submission - Where saving stands.
 * @returns True after a `SchemaChanged` refusal.
 */
const isRefusedAsStale = (submission: Submission): boolean =>
  Submission.guards.Failed(submission) &&
  WriteError.guards.SchemaChanged(submission.error);

/**
 * Applies a reconciliation of the edits (decision 0020): keeps the edits
 * that still apply, notes the dropped ones, and forgets the server's
 * errors of dropped fields.
 *
 * @param model - The page.
 * @param reconciled - What reconciling found.
 * @returns The page.
 */
const withReconciled = (model: Model, reconciled: Reconciled): Model =>
  reconciled.dropped.length === 0
    ? model
    : modifyFields(model, {
        droppedEdits: (notes) => mergeDropped(notes, reconciled.dropped),
        edits: () => reconciled.edits,
        serverErrors: Record.filter(
          (_texts, fieldId) =>
            !reconciled.dropped.some((note) => note.fieldId === fieldId)
        ),
      });

/**
 * Whether the record on screen was read under other definitions than the
 * form's metadata (its reread after a metadata change did not load): its
 * values may carry old field names, so a save waits until it is read
 * again (decision 0020).
 *
 * @param model - The page.
 * @returns True while the record is not the metadata's.
 */
export const isRecordOutdated = (model: Model): boolean =>
  !isCreating(model) &&
  Option.isSome(recordOf(model)) &&
  !Option.exists(metaOf(model), (meta) =>
    Option.contains(model.maybeRecordRevision, meta.revision)
  );

/**
 * Whether the page may judge the edits against its record now: on a
 * create (no record) always; when editing, only with a record read (or
 * saved) at the metadata's revision. Otherwise the record names its
 * fields as other definitions do, and comparing by name would drop edits
 * it seems not to deliver.
 *
 * @param model - The page.
 * @returns True when the edits may be reconciled.
 */
const canReconcile = (model: Model): boolean =>
  isCreating(model) ||
  (Option.isSome(recordOf(model)) && !isRecordOutdated(model));

/**
 * The one reconciliation of the edits (decision 0020, review round 3,
 * Rule 1): every arrival that may change what the form can send (its
 * metadata, the concrete class's, a read of the record, a save's answer,
 * a create turning into an edit) goes through here. Behind a gate: while
 * the record is not the metadata's (`canReconcile`), nothing is judged;
 * the arrival is stored, and the next read under the current metadata
 * runs this once with everything that arrived. Otherwise the edits are
 * judged against the definitions they were last judged with
 * (`reconciledFields`, so a dropped field keeps the label the user saw)
 * and the definitions now, then against the record as those show it;
 * what can no longer be sent is dropped with a note.
 *
 * @param model - The page, with whatever just arrived stored.
 * @returns It, with the edits reconciled, or unchanged behind the gate.
 */
const reconcileEdits = (model: Model): Model => {
  if (!canReconcile(model)) {
    return model;
  }

  const fields = fieldsOf(model);

  const byDefinitions = withReconciled(
    model,
    reconcileWithMetadata(
      model.edits,
      model.reconciledFields,
      fields,
      isCreating(model)
    )
  );

  const byRecord = isCreating(byDefinitions)
    ? byDefinitions
    : withReconciled(
        byDefinitions,
        reconcileWithRecord(byDefinitions.edits, fields, (field) =>
          fieldShowOf(field, editedRecordOf(byDefinitions))
        )
      );

  return modifyFields(byRecord, { reconciledFields: () => fields });
};

/**
 * Whether an answer about the concrete class's metadata is the one the
 * page waits for: for the record's class, asked at the metadata's current
 * revision (review round 2). An answer to a request made before the
 * metadata moved on (a rename) is ignored: the request at the new
 * revision follows it, and the older answer must not replace it.
 *
 * @param model - The page.
 * @param resourceType - The class the answer is about (its `@type`).
 * @param revision - The revision the request was made at.
 * @returns True for the awaited answer.
 */
const isClassAnswerFor = (
  model: Model,
  resourceType: string,
  revision: SchemaRevision
): boolean =>
  Option.exists(recordOf(model), (record) => record.class === resourceType) &&
  Option.exists(metaOf(model), (meta) => meta.revision === revision);

/**
 * The concrete class's metadata arrived (decision 0020): the form now
 * describes the fields by it, so the edits are reconciled again, with the
 * class's definitions and with the record as they show it. An edit the
 * class makes read-only (or no longer offers) is dropped with a note,
 * whether the record's reread came before or after.
 *
 * @param model - The page.
 * @param table - The class's metadata.
 * @returns The page, with the controls the class's fields need.
 */
const receiveClassMetadata = (model: Model, table: MetaTable): UpdateReturn => {
  if (
    !Option.exists(
      recordOf(model),
      (record) => record.class === table.resourceType
    )
  ) {
    return { model };
  }

  return setUpControls(
    reconcileEdits(
      modifyFields(model, {
        classMetadata: () => ClassMetadata.Success({ data: table }),
      })
    )
  );
};

/**
 * What new metadata asks of the record: the first read (or the one a
 * `SchemaChanged` refusal stopped); a reread when the metadata moved to
 * another revision, so the record's names are the metadata's (a rename
 * changes them); else only the concrete class's metadata, reloaded.
 *
 * @param isFirstRead - Whether the record was never read at a revision.
 * @param isOtherRevision - Whether the metadata's revision changed.
 * @returns The step.
 */
const nextRecordStep = (
  isFirstRead: boolean,
  isOtherRevision: boolean
): Step => {
  if (isFirstRead) {
    return requestRecord("Open");
  }

  return isOtherRevision
    ? (model) =>
        Update.combine(model, [requestRecord("Refresh"), requestClassMetadata])
    : requestClassMetadata;
};

const receiveMetadata = (
  model: Model,
  table: MetaTable,
  revision: SchemaRevision
): UpdateReturn => {
  if (table.name !== model.table) {
    return { model };
  }

  const isFirstLoad = Option.isNone(metaOf(model));

  const isOtherRevision = Option.exists(
    metaOf(model),
    (meta) => meta.revision !== revision
  );

  const hadRecordRefused = Option.exists(
    AsyncData.getError(model.record),
    (reason) => reason === "SchemaChanged"
  );

  // NOTE: on another revision the record on screen is not the metadata's
  // until it is read again, so the gate holds the reconciliation back
  // until that read (`reconcileEdits`); a create has no record, and is
  // reconciled at once.
  const reconcileIfMoved = (stepModel: Model): Model =>
    isFirstLoad || isOtherRevision ? reconcileEdits(stepModel) : stepModel;

  const loaded = reconcileIfMoved(
    syncRelatedLists(
      modifyFields(model, {
        classMetadata: (classMetadata) =>
          isFirstLoad ? classMetadata : ClassMetadata.Idle(),
        metadata: () => Metadata.Success({ data: { revision, table } }),
        submission: (submission) =>
          isOtherRevision && isRefusedAsStale(submission)
            ? Submission.Outdated()
            : submission,
      }),
      table
    )
  );

  const next = Update.combine(loaded, [
    nextRecordStep(isFirstLoad || hadRecordRefused, isOtherRevision),
    setUpControls,
    isOtherRevision
      ? retryRefusedHistory
      : (stepModel) => ({ model: stepModel }),
    requestWaitingRelated,
    retryRefusedSearches,
  ]);

  return sawRevision(next, Option.some(revision));
};

const failMetadata = (model: Model, error: MetaError): UpdateReturn => ({
  model: modifyFields(model, {
    metadata: (metadata) =>
      Option.match(AsyncData.getData(metadata), {
        onNone: () => Metadata.Failure({ error }),
        onSome: (data) =>
          error === "UnknownTable"
            ? Metadata.Failure({ error })
            : Metadata.Stale({ data, error }),
      }),
  }),
});

/**
 * The version a save committed whose record could not be read back.
 *
 * @param submission - Where saving stands.
 * @returns The version, while the form waits to read it.
 */
const unreadSaveVersionOf = (submission: Submission): Option.Option<number> =>
  Submission.guards.SavedUnread(submission)
    ? Option.some(submission.version)
    : Option.none();

const receiveRecord = (
  model: Model,
  generation: number,
  record: Parameters<typeof StoredRecord.Success>[0]["data"],
  purpose: ReadPurpose,
  maybeRevision: Option.Option<SchemaRevision>
): UpdateReturn => {
  // NOTE: a reread that left before a save and arrives after it holds an
  // older version than the saved record; it is not shown. After a save
  // whose record could not be read back, the version it committed is the
  // floor: an older read is from before that save.
  const maybeUnreadVersion = unreadSaveVersionOf(model.submission);

  const isOlder =
    Option.exists(
      recordOf(model),
      (current) => current.id === record.id && current.version > record.version
    ) || Option.exists(maybeUnreadVersion, (saved) => record.version < saved);

  if (generation !== model.generation || isOlder) {
    return { model };
  }

  const afterConflict = purpose === "ReloadAfterConflict";
  const afterUnreadSave = Option.isSome(maybeUnreadVersion);

  // NOTE: after a save whose record could not be read back, exactly the
  // version it committed is this page's own save; a later one is someone
  // else's change, marked under the edits as after any reread (decision
  // 0020), against the record the page showed before the save.
  const isOwnSave = Option.contains(maybeUnreadVersion, record.version);

  const isChangedUnderEdits =
    purpose !== "Open" &&
    !isOwnSave &&
    !Record.isEmptyRecord(model.edits) &&
    Option.exists(
      recordOf(model),
      (before) => before.version !== record.version
    );

  const read = modifyFields(model, {
    deletion: (deletion) => (afterConflict ? Deletion.Idle() : deletion),
    maybeEditsFrom: (editsFrom) =>
      isChangedUnderEdits
        ? Option.orElse(editsFrom, () => recordOf(model))
        : editsFrom,
    // NOTE: every change of the metadata's revision asks for the record
    // again (a newer `generation`), so a read answered here was sent at
    // the metadata's current revision.
    maybeRecordRevision: () =>
      Option.map(metaOf(model), (meta) => meta.revision),
    record: () => StoredRecord.Success({ data: record }),
    submission: (submission) => {
      if (afterUnreadSave) {
        return Submission.Saved({ isVisible: true });
      }

      return afterConflict ? Submission.Idle() : submission;
    },
  });

  const shown = reconcileEdits(read);

  return sawRevision(
    Update.combine(resetPickerInputs(shown), [
      requestClassMetadata,
      setUpControls,
      refreshIfNewer(maybeRevision),
    ]),
    maybeRevision
  );
};

const failRecord = (
  model: Model,
  generation: number,
  error: RecordError,
  maybeRevision: Option.Option<SchemaRevision>
): UpdateReturn => {
  if (generation !== model.generation) {
    return { model };
  }

  const refused = modifyFields(model, {
    record: (record) =>
      Option.match(AsyncData.getData(record), {
        onNone: () => StoredRecord.Failure({ error }),
        onSome: (data) =>
          error === "NotFound"
            ? StoredRecord.Failure({ error })
            : StoredRecord.Stale({ data, error }),
      }),
  });

  if (error !== "SchemaChanged") {
    return { model: refused };
  }

  return Update.withOutMessage(
    refreshMetadata(refused),
    Option.getOrUndefined(
      pipe(
        maybeRevision,
        Option.map((revision) => OutMessage.SawCurrentRevision({ revision }))
      )
    )
  );
};

// SAVE

/**
 * Whether the page is rereading its definitions or the record: a save
 * waits, so it is never built from new metadata and an old record (whose
 * value names may be the old ones) or the other way round.
 *
 * @param model - The page.
 * @returns True while the metadata or the record is reloading.
 */
export const isReloading = (model: Model): boolean =>
  AsyncData.isRefreshing(model.metadata) ||
  (!isCreating(model) && AsyncData.isRefreshing(model.record));

const firstProblemField = (
  model: Model,
  problems: Readonly<Record<string, readonly string[]>>
): Option.Option<MetaField> =>
  Option.fromNullishOr(
    fieldsOf(model).find((field) => Record.has(problems, field.id))
  );

const focusFirst = (
  model: Model,
  problems: Readonly<Record<string, readonly string[]>>
) =>
  Option.match(firstProblemField(model, problems), {
    onNone: () => [],
    onSome: (field) => [FocusField({ elementId: controlIdOf(field) })],
  });

/**
 * Whether the last save is not over for the form: in flight, or its
 * record not read back yet.
 *
 * @param submission - Where saving stands.
 * @returns True for `Saving` and `SavedUnread`.
 */
const isAwaitingSave = (submission: Submission): boolean =>
  Submission.guards.Saving(submission) ||
  Submission.guards.SavedUnread(submission);

/**
 * Whether a click on Save does nothing now: a save is in flight, a save's
 * record could not be read back, the form is not loaded, its definitions
 * or record are reloading, or the record is not the metadata's.
 *
 * @param model - The page.
 * @returns True when Save is held back.
 */
const isSaveHeld = (model: Model): boolean =>
  isAwaitingSave(model.submission) ||
  !isReady(model) ||
  isReloading(model) ||
  isRecordOutdated(model);

/**
 * "Save": judges the edits with `recordSchema`; with problems, shows them
 * and moves focus to the first; with nothing changed on an existing
 * record, says so; otherwise sends the create or the update (only the
 * changed fields, Contracts 6.7) at the form's revision. A save in flight
 * makes another click do nothing.
 *
 * @param model - The page.
 * @returns The page and its Commands.
 */
const save = (model: Model): UpdateReturn => {
  if (isSaveHeld(model)) {
    return { model };
  }

  const check = checkForm(model);

  if (!Record.isEmptyRecord(check.problems)) {
    return {
      commands: focusFirst(model, check.problems),
      model: modifyFields(model, {
        isShowingProblems: () => true,
        submission: () => Submission.Idle(),
      }),
    };
  }

  if (!isCreating(model) && isEmptyBody(check.body)) {
    return {
      model: modifyFields(model, { submission: () => Submission.Unchanged() }),
    };
  }

  const generation = model.generation + 1;

  return Option.match(metaOf(model), {
    onNone: () => ({ model }),
    onSome: (meta) => {
      const command = Option.match(recordOf(model), {
        onNone: () =>
          CreateRecord({
            fields: meta.table.fields.map(wireFieldOf),
            generation,
            revision: meta.revision,
            secrets: check.body.secrets,
            selected: defaultSelectionOf(meta.table),
            table: model.table,
            values: check.body.values,
          }),
        onSome: (record) =>
          UpdateRecord({
            fields: meta.table.fields.map(wireFieldOf),
            generation,
            isDefinitionTable: meta.table.definitionTable === true,
            recordId: record.id,
            revision: meta.revision,
            secrets: check.body.secrets,
            selected: defaultSelectionOf(meta.table),
            table: model.table,
            values: check.body.values,
            version: record.version,
          }),
      });

      return {
        commands: [command],
        model: modifyFields(model, {
          generation: () => generation,
          isShowingProblems: () => false,
          submission: () =>
            Submission.Saving({
              generation,
              revision: meta.revision,
              sentEdits: model.edits,
            }),
        }),
      };
    },
  });
};

const isVisibleRecord = (
  saved: SavedRecord
): saved is Parameters<typeof StoredRecord.Success>[0]["data"] =>
  "values" in saved;

const isUnreadRecord = (
  saved: SavedRecord
): saved is typeof UnreadSavedRecord.Type => "_tag" in saved;

/**
 * The labels the saved record shows: the label the user picked for each
 * reference that changed, the label read before for each unchanged one.
 *
 * @param model - The page before the save.
 * @param saved - The record as the save returned it.
 * @returns Its labels.
 */
const labelsAfterSave = (
  model: Model,
  saved: Parameters<typeof StoredRecord.Success>[0]["data"]
): Readonly<Record<string, string>> =>
  Record.fromIterableWith(
    fieldsOf(model).flatMap((field) => {
      const input = inputOf(model, field);

      const value = saved.values[field.name];

      const label =
        FieldInput.guards.Reference(input) &&
        value !== undefined &&
        Option.contains(input.maybeId, value)
          ? input.maybeLabel
          : Option.none();

      return Option.match(label, {
        onNone: () => [],
        onSome: (text) => [{ name: field.name, text }],
      });
    }),
    ({ name, text }) => [name, text] as const
  );

/**
 * The edits made while a save was in flight (decision 0020): those that
 * differ from what the save was built from. They stay, on top of the
 * saved record.
 *
 * @param edits - The edits now.
 * @param sentEdits - The edits the save was built from.
 * @returns The later edits.
 */
export const editsAfterSave = (
  edits: Readonly<Record<string, FieldInput>>,
  sentEdits: Readonly<Record<string, FieldInput>>
): Readonly<Record<string, FieldInput>> =>
  pipe(
    edits,
    Record.filter(
      (input, fieldId) =>
        !Option.exists(Record.get(sentEdits, fieldId), (sent) =>
          Equal.equals(sent, input)
        )
    )
  );

/**
 * A save that succeeded but whose record could not be read back
 * (decision 0031): the edits it sent are saved, the later ones stay, and
 * the record on screen is kept as stale (or, after a create, fails to
 * show) until the user reads it again; Save waits for that read.
 *
 * @param editing - The page, editing the saved record.
 * @param sentEdits - The edits the save was built from.
 * @param version - The version the save committed.
 * @returns The page.
 */
const markUnreadSave = (
  editing: Model,
  sentEdits: Readonly<Record<string, FieldInput>>,
  version: number
): Model =>
  modifyFields(editing, {
    droppedEdits: () => [],
    edits: (edits) => editsAfterSave(edits, sentEdits),
    maybeEditsFrom: () => Option.none(),
    record: (record) =>
      Option.match(AsyncData.getData(record), {
        onNone: () => StoredRecord.Failure({ error: "Unavailable" }),
        onSome: (data) => StoredRecord.Stale({ data, error: "Unavailable" }),
      }),
    serverErrors: () => ({}),
    staleChanges: () => [],
    submission: () => Submission.SavedUnread({ version }),
  });

const receiveSave = (
  model: Model,
  generation: number,
  saved: SavedRecord,
  maybeRevision: Option.Option<SchemaRevision>
): UpdateReturn => {
  const { submission } = model;

  if (
    !Submission.guards.Saving(submission) ||
    submission.generation !== generation
  ) {
    return { model };
  }

  const wasCreating = isCreating(model);

  // NOTE: after a create the page becomes the new record's form (decision
  // 0020): the address it moves to names this record, so the app keeps
  // the page, and the edits made while the create was in flight with it.
  const navigation = wasCreating
    ? [
        NavigateAway({
          url: recordRouter({ id: saved.id, table: model.table }),
        }),
      ]
    : [];

  const editing = modifyFields(model, {
    mode: () => FormMode.Edit({ recordId: saved.id }),
  });

  if (isUnreadRecord(saved)) {
    return sawRevision(
      {
        commands: navigation,
        model: markUnreadSave(editing, submission.sentEdits, saved.version),
      },
      maybeRevision
    );
  }

  if (!isVisibleRecord(saved)) {
    return sawRevision(
      {
        commands: navigation,
        model: modifyFields(editing, {
          edits: () => ({}),
          record: () => StoredRecord.Failure({ error: "NotFound" }),
          submission: () => Submission.Saved({ isVisible: false }),
        }),
      },
      maybeRevision
    );
  }

  // NOTE: the saved record names its fields as the revision the save was
  // sent at. When the metadata moved on meanwhile (a rename, review round
  // 2), nothing is compared by name with it: the later edits stay as they
  // are (by field ID), the record is read again under the current
  // metadata, and that read reconciles them (`receiveRecord`); Save waits
  // for it (`isRecordOutdated`).
  const isAtFormRevision = Option.exists(
    metaOf(model),
    (meta) => meta.revision === submission.revision
  );

  const withLabels = isAtFormRevision
    ? {
        ...saved,
        labels: labelsAfterSave(
          modifyFields(model, { edits: () => submission.sentEdits }),
          saved
        ),
      }
    : saved;

  const stored = modifyFields(editing, {
    droppedEdits: () => [],
    edits: (edits) => editsAfterSave(edits, submission.sentEdits),
    maybeEditsFrom: () => Option.none(),
    maybeRecordRevision: () => Option.some(submission.revision),
    record: () => StoredRecord.Success({ data: withLabels }),
    serverErrors: () => ({}),
    staleChanges: () => [],
    submission: () => Submission.Saved({ isVisible: true }),
  });

  // NOTE: the later edits now apply to the saved record (after a create,
  // under the update limits): one it withholds or shows read-only is
  // dropped with a note, as after any read. At another revision than the
  // metadata's the gate holds this back until the reread.
  const rebased = reconcileEdits(stored);

  const shown = Option.match(metaOf(rebased), {
    onNone: () => rebased,
    onSome: (meta) =>
      wasCreating ? syncRelatedLists(rebased, meta.table) : rebased,
  });

  return sawRevision(
    Update.combine(resetPickerInputs(shown), [
      (stepModel) => ({ commands: navigation, model: stepModel }),
      isAtFormRevision
        ? (stepModel) => ({ model: stepModel })
        : requestRecord("Refresh"),
      refreshHistory,
      requestClassMetadata,
      setUpControls,
      refreshIfNewer(maybeRevision),
    ]),
    maybeRevision
  );
};

const INVALID_REFERENCE_TEXT =
  "The chosen record is not available here: it does not exist, you cannot see it, or this field does not allow it.";

const UNKNOWN_FIELD_TEXT =
  "The server does not know this field for you any more. Reload the definition.";

const fieldIdByName = (model: Model, name: string): Option.Option<string> =>
  Option.fromNullishOr(
    fieldsOf(model).find((field) => field.name === name)?.id
  );

const serverErrorsOf = (
  model: Model,
  error: WriteError
): Readonly<Record<string, readonly string[]>> => {
  if (WriteError.guards.ValidationFailed(error)) {
    return errorsByFieldId(fieldsOf(model), error.errors);
  }

  if (WriteError.guards.InvalidReference(error)) {
    return Option.match(fieldIdByName(model, error.field), {
      onNone: () => ({}),
      onSome: (fieldId) => ({ [fieldId]: [INVALID_REFERENCE_TEXT] }),
    });
  }

  return WriteError.guards.UnknownField(error)
    ? Option.match(fieldIdByName(model, error.field), {
        onNone: () => ({}),
        onSome: (fieldId) => ({ [fieldId]: [UNKNOWN_FIELD_TEXT] }),
      })
    : {};
};

/**
 * After a save refused with `SchemaChanged` (Contracts 6.4): reloads the
 * metadata by itself (the record follows, `receiveMetadata`), keeping the
 * input; the save is never sent again by itself. When a background
 * refresh already brought the form to the refusal's current revision, the
 * form is outdated at once.
 *
 * @param model - The page, refused.
 * @param maybeCurrent - The refusal's current revision.
 * @returns The page, reloading or waiting for the user.
 */
const reloadAfterSchemaChanged = (
  model: Model,
  maybeCurrent: Option.Option<SchemaRevision>
): PlainReturn => {
  const isAlreadyCurrent =
    !AsyncData.isPending(model.metadata) &&
    Option.exists(
      Option.all([maybeCurrent, metaOf(model)]),
      ([current, meta]) => !isNewerRevision(current, meta.revision)
    );

  return isAlreadyCurrent
    ? {
        model: modifyFields(model, { submission: () => Submission.Outdated() }),
      }
    : refreshMetadata(model);
};

const failSave = (
  model: Model,
  generation: number,
  error: WriteError,
  maybeRevision: Option.Option<SchemaRevision>
): UpdateReturn => {
  const isCurrent =
    Submission.guards.Saving(model.submission) &&
    model.submission.generation === generation;

  if (!isCurrent) {
    return { model };
  }

  const serverErrors = serverErrorsOf(model, error);

  const refused = modifyFields(model, {
    isShowingProblems: () => true,
    serverErrors: () => serverErrors,
    staleChanges: (changes) =>
      WriteError.guards.SchemaChanged(error)
        ? mergeChanges(changes, error.changes)
        : changes,
    submission: () => Submission.Failed({ error }),
  });

  const focused = {
    commands: focusFirst(model, serverErrors),
    model: refused,
  };

  if (WriteError.guards.NotAllowed(error)) {
    return Update.combine(refused, [() => focused, refreshMetadata]);
  }

  const sawCurrent = Option.getOrUndefined(
    pipe(
      maybeRevision,
      Option.map((revision) => OutMessage.SawCurrentRevision({ revision }))
    )
  );

  if (!WriteError.guards.SchemaChanged(error)) {
    return Update.withOutMessage(focused, sawCurrent);
  }

  return Update.withOutMessage(
    reloadAfterSchemaChanged(refused, maybeRevision),
    sawCurrent
  );
};

// DELETE

const ignoreDialogOutMessage = Dialog.OutMessage.match<Step>({
  // oxlint-disable-next-line sonarjs/function-name -- an OutMessage.match case is keyed by its OutMessage's tag
  Closed: () => (model) => ({ model }),
  // oxlint-disable-next-line sonarjs/function-name -- an OutMessage.match case is keyed by its OutMessage's tag
  Opened: () => (model) => ({ model }),
});

const foldDeleteDialog = Update.foldChild({
  foldOutMessage: ignoreDialogOutMessage,
  read: (model: Model) => Option.some(model.deleteDialog),
  toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
  update: (dialog: Dialog.Model, message: Dialog.Message) =>
    Dialog.update(dialog, message),
  write: (model: Model, nextDialog: Dialog.Model) =>
    modifyFields(model, { deleteDialog: () => nextDialog }),
});

const openDeleteDialog = Update.foldChildStep({
  foldOutMessage: ignoreDialogOutMessage,
  read: (model: Model) => Option.some(model.deleteDialog),
  toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
  update: Dialog.open,
  write: (model: Model, nextDialog: Dialog.Model) =>
    modifyFields(model, { deleteDialog: () => nextDialog }),
});

const closeDeleteDialog = Update.foldChildStep({
  foldOutMessage: ignoreDialogOutMessage,
  read: (model: Model) => Option.some(model.deleteDialog),
  toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
  update: Dialog.close,
  write: (model: Model, nextDialog: Dialog.Model) =>
    modifyFields(model, { deleteDialog: () => nextDialog }),
});

const confirmDelete = (model: Model): UpdateReturn => {
  if (Deletion.guards.Deleting(model.deletion)) {
    return { model };
  }

  return Option.match(Option.all([metaOf(model), recordOf(model)]), {
    onNone: () => closeDeleteDialog(model),
    onSome: ([meta, record]) =>
      Update.combine(
        modifyFields(model, { deletion: () => Deletion.Deleting() }),
        [
          closeDeleteDialog,
          (stepModel) => ({
            commands: [
              DeleteRecord({
                recordId: record.id,
                revision: meta.revision,
                table: model.table,
                version: record.version,
              }),
            ],
            model: stepModel,
          }),
        ]
      ),
  });
};

/**
 * A refused delete. `NotAllowed` and `SchemaChanged` refresh the metadata
 * in the background, as for a save (Contracts 6.4); the delete is never
 * sent again by itself.
 *
 * @param model - The page.
 * @param error - Why it was refused.
 * @returns The page, and what the app should know.
 */
const failDelete = (model: Model, error: WriteError): UpdateReturn => {
  const refused = modifyFields(model, {
    deletion: () => Deletion.Failed({ error }),
  });

  if (WriteError.guards.NotAllowed(error)) {
    return refreshMetadata(refused);
  }

  return WriteError.guards.SchemaChanged(error)
    ? Update.withOutMessage(
        refreshMetadata(refused),
        Option.getOrUndefined(
          Option.map(parseSchemaRevision(error.currentRevision), (revision) =>
            OutMessage.SawCurrentRevision({ revision })
          )
        )
      )
    : { model: refused };
};

const listUrlOf = (table: string): string =>
  tableListRouter({
    filter: Option.none(),
    limit: Option.none(),
    sort: Option.none(),
    table,
  });

// RETRY

/**
 * "Try again": the metadata when the page has none, a refresh when it is
 * stale, else the record (reread keeping the edits when the page has one,
 * such as a record not read under the current metadata).
 *
 * @param model - The page.
 * @returns The page and its Commands.
 */
const retry = (model: Model): UpdateReturn => {
  if (Option.isNone(metaOf(model))) {
    return {
      commands: [
        LoadFormMetadata({
          maybeRevision: model.maybeAppRevision,
          table: model.table,
        }),
      ],
      model: modifyFields(model, { metadata: () => Metadata.Loading() }),
    };
  }

  if (AsyncData.isStale(model.metadata)) {
    return refreshMetadata(model);
  }

  return Option.isSome(recordOf(model))
    ? requestRecord("Refresh")(model)
    : requestRecord("Open")(model);
};

// UPDATE

/**
 * The form page's update.
 *
 * @param model - The page.
 * @param message - What happened.
 * @returns The next page, its Commands, and what the app should know.
 */
export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedClearDate: ({ fieldId }) =>
      editField(model, fieldId, withDate(Option.none())),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedClearSecret: ({ fieldId }) =>
      editField(model, fieldId, () =>
        FieldInput.WriteOnly({ maybeValue: Option.none() })
      ),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedConfirmDelete: () => confirmDelete(model),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedDelete: () =>
      Deletion.guards.Deleting(model.deletion)
        ? { model }
        : openDeleteDialog(
            modifyFields(model, { deletion: () => Deletion.Idle() })
          ),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedKeepSecret: ({ fieldId }) => forgetEdit(model, fieldId),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedNextRelatedPage: ({ listId }) =>
      pageRelated(model, listId, nextRelatedCursors),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedPreviousRelatedPage: ({ listId }) =>
      pageRelated(model, listId, previousRelatedCursors),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedReloadDefinition: () => refreshMetadata(model),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedReloadRecord: () =>
      Submission.guards.Saving(model.submission)
        ? { model }
        : requestRecord("ReloadAfterConflict")(model),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedRetry: () => retry(model),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedRetryRelatedList: ({ listId }) => retryRelatedList(model, listId),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedSave: () => save(model),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    CompletedFocusField: () => ({ model }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    CompletedNavigateAway: () => ({ model }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    CompletedReadToday: ({ today }) => ({
      model: modifyFields(model, { maybeToday: () => Option.some(today) }),
    }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedAuthentication: () => ({
      model,
      outMessage: OutMessage.SessionEnded(),
    }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedDeleteRecord: ({ error }) => failDelete(model, error),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadClassMetadata: ({ error, resourceType, revision }) => ({
      model: isClassAnswerFor(model, resourceType, revision)
        ? modifyFields(model, {
            classMetadata: () => ClassMetadata.Failure({ error }),
          })
        : model,
    }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadFormMetadata: ({ error }) => failMetadata(model, error),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadHistory: ({ error, generation }) =>
      failHistory(model, generation, error),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadHistoryLabels: ({ table }) => ({
      model: modifyFields(model, {
        history: (history) =>
          modifyFields(history, {
            failedLabelTables: (tables) =>
              tables.includes(table) ? tables : [...tables, table],
          }),
      }),
    }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadRecord: ({ error, generation, maybeRevision }) =>
      failRecord(model, generation, error, maybeRevision),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadRelatedMetadata: ({ error, generation, listId }) =>
      failRelatedMetadata(model, { generation, listId }, error),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadRelatedRecords: ({ error, generation, listId }) =>
      failRelatedPage(model, { generation, listId }, error),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadTarget: ({ error, request, table }) =>
      failTarget(model, table, request, error),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedSaveRecord: ({ error, generation, maybeRevision }) =>
      failSave(model, generation, error, maybeRevision),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedSearchTargets: ({ fieldId, ...failure }) =>
      failSearch(model, fieldId, failure),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    GotDatePickerMessage: ({ fieldId, message: pickerMessage }) =>
      foldDatePicker(model, fieldId, pickerMessage),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    GotDeleteDialogMessage: ({ message: dialogMessage }) =>
      foldDeleteDialog(model, dialogMessage),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    GotPickerMessage: ({ fieldId, message: pickerMessage }) =>
      updatePicker(model, fieldId, pickerMessage),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    PressedSaveShortcut: () => save(model),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SelectedChoice: ({ fieldId, key }) =>
      editField(model, fieldId, () => FieldInput.Choice({ key })),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededDeleteRecord: ({ maybeRevision }) =>
      sawRevision(
        {
          commands: [NavigateAway({ url: listUrlOf(model.table) })],
          model: modifyFields(model, { deletion: () => Deletion.Idle() }),
        },
        maybeRevision
      ),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadClassMetadata: ({ revision, table }) =>
      isClassAnswerFor(model, table.resourceType, revision)
        ? receiveClassMetadata(model, table)
        : { model },
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadFormMetadata: ({ revision, table }) =>
      receiveMetadata(model, table, revision),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadHistory: ({ entries, generation, maybeRevision }) =>
      sawRevision(
        Update.combine(model, [
          (stepModel) => receiveHistory(stepModel, generation, entries),
          refreshIfNewer(maybeRevision),
        ]),
        maybeRevision
      ),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadHistoryLabels: ({ labels, table }) => ({
      model: modifyFields(model, {
        history: (history) => withHistoryLabels(history, table, labels),
      }),
    }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadRecord: ({ generation, maybeRevision, purpose, record }) =>
      receiveRecord(model, generation, record, purpose, maybeRevision),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadRelatedMetadata: ({ generation, listId, revision, table }) =>
      receiveRelatedMetadata(
        model,
        { generation, listId },
        { revision, table }
      ),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadRelatedRecords: ({
      generation,
      listId,
      maybeRevision,
      page,
    }) =>
      sawRevision(
        Update.combine(model, [
          (stepModel) =>
            receiveRelatedRecords(stepModel, { generation, listId }, page),
          refreshIfNewer(maybeRevision),
        ]),
        maybeRevision
      ),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadTarget: ({ request, table }) =>
      receiveTarget(model, table, request),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededSaveRecord: ({ generation, maybeRevision, saved }) =>
      receiveSave(model, generation, saved, maybeRevision),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededSearchTargets: ({ fieldId, maybeRevision, ...answer }) =>
      sawRevision(
        Update.combine(model, [
          (stepModel) => receiveSearch(stepModel, fieldId, answer),
          refreshIfNewer(maybeRevision),
        ]),
        maybeRevision
      ),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ToggledFlag: ({ fieldId, isChecked }) =>
      editField(model, fieldId, () => FieldInput.Flag({ isChecked })),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ToggledHistory: ({ isOpen }) => toggleHistory(model, isOpen),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ToggledRelatedList: ({ isOpen, listId }) =>
      toggleRelatedList(model, listId, isOpen),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    UpdatedText: ({ fieldId, text }) =>
      editField(model, fieldId, () => FieldInput.Text({ text })),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    UpdatedTime: ({ fieldId, time }) =>
      editField(model, fieldId, (_field, current) =>
        FieldInput.Instant({
          maybeDate: FieldInput.guards.Instant(current)
            ? current.maybeDate
            : Option.none(),
          time,
        })
      ),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    UpdatedWriteOnly: ({ fieldId, maybeValue }) =>
      Option.isNone(maybeValue)
        ? forgetEdit(model, fieldId)
        : editField(model, fieldId, () => FieldInput.WriteOnly({ maybeValue })),
  });
