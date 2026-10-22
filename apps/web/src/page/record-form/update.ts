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
import type {
  MetaField,
  MetaRelatedList,
  MetaTable,
} from "@std/definitions/table-metadata";
import { Equal, Option, Record, pipe } from "effect";
import { AsyncData, Update } from "foldkit";
import type { CalendarDate } from "foldkit/calendar";
import { modifyFields } from "foldkit/struct";

import { fieldShowOf, formFieldsOf } from "../../domain/form-fields.ts";
import { FieldInput } from "../../domain/form-input.ts";
import { listFieldsParameter } from "../../domain/list-columns.ts";
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
import { calendarDateOf, isoDateOf } from "../../filter-builder/condition.ts";
import { recordRouter, tableListRouter } from "../../route.ts";
import type { StdApi } from "../../std-client.ts";
import { Metadata, TargetMetadata } from "../table-list/model.ts";
import type { MetaError, RecordPage } from "../table-list/model.ts";
import {
  CreateRecord,
  DeleteRecord,
  FocusField,
  LoadActorNames,
  LoadClassMetadata,
  LoadFormMetadata,
  LoadHistory,
  LoadRecord,
  LoadRelatedMetadata,
  LoadRelatedRecords,
  LoadTarget,
  NavigateAway,
  ReadToday,
  SearchTargets,
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
import type { ReadPurpose, SavedRecord } from "./message.ts";
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
      actorNames: {},
      entries: HistoryEntries.Idle(),
      generation: 0,
      isOpen: false,
    },
    id: config.id,
    isShowingProblems: false,
    maybeAppRevision: config.maybeAppRevision,
    maybeEditsFrom: Option.none(),
    maybeRecordRevision: Option.none(),
    maybeToday: Option.none(),
    metadata: Metadata.Loading(),
    mode: config.mode,
    pickers: {},
    record: StoredRecord.Idle(),
    relatedLists: {},
    serverErrors: {},
    staleChanges: [],
    submission: Submission.Idle(),
    table: config.table,
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

      return {
        commands: targets.map((table) =>
          LoadTarget({ revision: meta.revision, table })
        ),
        model: modifyFields(model, {
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
          targets: (known) =>
            Record.union(
              known,
              Record.fromIterableWith(targets, (table) => [
                table,
                TargetMetadata.Loading(),
              ]),
              keepExisting
            ),
        }),
      };
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
 * The key of a related list: its table and reference field.
 *
 * @param entry - The related list.
 * @returns `table/field`.
 */
export const relatedKeyOf = (entry: MetaRelatedList): string =>
  `${entry.table}/${entry.field}`;

const closedRelatedList = (entry: MetaRelatedList): RelatedList => ({
  cursors: [Option.none()],
  entry,
  generation: 0,
  isOpen: false,
  maybePendingCursors: Option.none(),
  metadata: RelatedMetadata.Idle(),
  records: RelatedRecords.Idle(),
});

/**
 * The list a new entry continues when its key is new: after the
 * back-reference field was renamed, the one list of the same table whose
 * key went away, when that table has exactly one such list and one such
 * new entry (related lists carry no IDs, so anything less certain starts
 * afresh).
 *
 * @param lists - The lists before.
 * @param entries - The new metadata's entries.
 * @param entry - The new entry.
 * @returns The list it continues.
 */
const renamedListOf = (
  lists: Readonly<Record<string, RelatedList>>,
  entries: readonly MetaRelatedList[],
  entry: MetaRelatedList
): Option.Option<RelatedList> => {
  const newKeys = new Set(entries.map(relatedKeyOf));

  const gone = Record.values(lists).filter(
    (list) =>
      list.entry.table === entry.table && !newKeys.has(relatedKeyOf(list.entry))
  );

  const added = entries.filter(
    (candidate) =>
      candidate.table === entry.table &&
      !Record.has(lists, relatedKeyOf(candidate))
  );

  const [only] = gone;

  return gone.length === 1 && added.length === 1
    ? Option.fromNullishOr(only)
    : Option.none();
};

const listOfEntry = (
  lists: Readonly<Record<string, RelatedList>>,
  entries: readonly MetaRelatedList[],
  entry: MetaRelatedList
): RelatedList =>
  Option.match(
    Option.orElse(Record.get(lists, relatedKeyOf(entry)), () =>
      renamedListOf(lists, entries, entry)
    ),
    {
      onNone: () => closedRelatedList(entry),
      onSome: (list) => modifyFields(list, { entry: () => entry }),
    }
  );

/**
 * The related lists of new metadata: each entry keeps its list (with the
 * entry as the metadata now states it, so requests use the field's current
 * name), a renamed back-reference continues its list, and a new entry gets
 * a closed one.
 *
 * @param model - The page.
 * @param table - The endpoint's new metadata.
 * @returns The page.
 */
const syncRelatedLists = (model: Model, table: MetaTable): Model =>
  isCreating(model)
    ? model
    : modifyFields(model, {
        relatedLists: (lists) =>
          Record.fromIterableWith(table.relatedLists, (entry) => [
            relatedKeyOf(entry),
            listOfEntry(lists, table.relatedLists, entry),
          ]),
      });

const writeRelatedList = (
  model: Model,
  key: string,
  change: (list: RelatedList) => RelatedList
): Model =>
  modifyFields(model, {
    relatedLists: (lists) => modifyEntry(lists, key, change),
  });

const relatedFilterOf = (list: RelatedList, recordId: string): string =>
  `${list.entry.field} = ${JSON.stringify(recordId)}`;

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
  key: string,
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
            cursor: Option.flatten(Option.fromNullishOr(cursors.at(-1))),
            fields: listFieldsParameter(meta.table),
            filter: relatedFilterOf(list, recordId),
            generation,
            key,
            revision: meta.revision,
            table: list.entry.table,
          }),
        ],
        model: writeRelatedList(
          model,
          key,
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
 * @param key - The related list.
 * @param toCursors - The cursor stack of the page, from the list.
 * @returns The step.
 */
const requestRelatedPage =
  (key: string, toCursors: (list: RelatedList) => CursorStack): Step =>
  (model) =>
    Option.match(
      Option.all([Record.get(model.relatedLists, key), recordOf(model)]),
      {
        onNone: () => ({ model }),
        onSome: ([list, record]) =>
          relatedPageRequest(model, key, list, record.id, toCursors(list)),
      }
    );

const firstRelatedPage = (key: string): Step =>
  requestRelatedPage(key, () => FIRST_PAGE);

const loadingRelatedMetadata = (list: RelatedList): RelatedList =>
  modifyFields(list, {
    metadata: (metadata) =>
      Option.match(AsyncData.getData(metadata), {
        onNone: () => RelatedMetadata.Loading(),
        onSome: (data) => RelatedMetadata.Refreshing({ data }),
      }),
  });

const loadRelatedMetadata =
  (key: string): Step =>
  (model) =>
    Option.match(
      Option.all([Record.get(model.relatedLists, key), metaOf(model)]),
      {
        onNone: () => ({ model }),
        onSome: ([list, meta]) => ({
          commands: [
            LoadRelatedMetadata({
              key,
              revision: meta.revision,
              table: list.entry.table,
            }),
          ],
          model: writeRelatedList(model, key, loadingRelatedMetadata),
        }),
      }
    );

const toggleRelatedList = (
  model: Model,
  key: string,
  isOpen: boolean
): UpdateReturn => {
  const toggled = writeRelatedList(model, key, (list) =>
    modifyFields(list, { isOpen: () => isOpen })
  );

  const isUnloaded = Option.exists(
    Record.get(model.relatedLists, key),
    (list) => AsyncData.isIdle(list.metadata)
  );

  return isOpen && isUnloaded
    ? loadRelatedMetadata(key)(toggled)
    : { model: toggled };
};

const isRelatedPaging = (list: RelatedList): boolean =>
  AsyncData.isPending(list.records) || !AsyncData.hasData(list.records);

const pageRelated = (
  model: Model,
  key: string,
  toCursors: (list: RelatedList) => Option.Option<CursorStack>
): UpdateReturn =>
  Option.match(
    pipe(
      Record.get(model.relatedLists, key),
      Option.filter((list) => !isRelatedPaging(list)),
      Option.flatMap(toCursors)
    ),
    {
      onNone: () => ({ model }),
      onSome: (cursors) => requestRelatedPage(key, () => cursors)(model),
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

/**
 * A related list's table metadata arrived: its first page is asked for,
 * unless the endpoint's own metadata is reloading (its `relatedLists` may
 * rename the back-reference); the page is then asked for when that
 * arrives (`requestWaitingRelated`).
 *
 * @param model - The page.
 * @param key - The related list.
 * @param meta - The related table's metadata and its revision.
 * @returns The page.
 */
const receiveRelatedMetadata = (
  model: Model,
  key: string,
  meta: { readonly revision: SchemaRevision; readonly table: MetaTable }
): UpdateReturn => {
  const known = writeRelatedList(model, key, (list) =>
    modifyFields(list, {
      metadata: () => RelatedMetadata.Success({ data: meta }),
    })
  );

  return AsyncData.isPending(model.metadata)
    ? { model: known }
    : firstRelatedPage(key)(known);
};

const failRelatedMetadata = (
  model: Model,
  key: string,
  error: MetaError
): PlainReturn => ({
  model: writeRelatedList(model, key, (list) =>
    modifyFields(list, {
      metadata: (metadata) =>
        Option.match(AsyncData.getData(metadata), {
          onNone: () => RelatedMetadata.Failure({ error }),
          onSome: (data) => RelatedMetadata.Stale({ data, error }),
        }),
    })
  ),
});

const receiveRelatedRecords = (
  model: Model,
  key: string,
  generation: number,
  page: RecordPage
): PlainReturn => ({
  model: writeRelatedList(model, key, (list) =>
    list.generation === generation
      ? modifyFields(list, {
          cursors: (cursors) =>
            Option.getOrElse(list.maybePendingCursors, () => cursors),
          maybePendingCursors: () => Option.none(),
          records: () => RelatedRecords.Success({ data: page }),
        })
      : list
  ),
});

const isCurrentRelated = (
  model: Model,
  key: string,
  generation: number
): boolean =>
  Option.exists(
    Record.get(model.relatedLists, key),
    (list) => list.generation === generation
  );

const failRelatedRecords = (
  model: Model,
  key: string,
  generation: number,
  error: RelatedError
): Model =>
  writeRelatedList(model, key, (list) =>
    list.generation === generation
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

const receiveHistory = (
  model: Model,
  generation: number,
  entries: Parameters<typeof HistoryEntries.Success>[0]["data"]
): PlainReturn => {
  if (generation !== model.history.generation) {
    return { model };
  }

  const unknownActors = [
    ...new Set(entries.map((entry) => entry.actor)),
  ].filter((actor) => !Record.has(model.history.actorNames, actor));

  const shown = modifyFields(model, {
    history: (history) =>
      modifyFields(history, {
        entries: () => HistoryEntries.Success({ data: entries }),
      }),
  });

  return Option.match(metaOf(model), {
    onNone: () => ({ model: shown }),
    onSome: (meta) =>
      unknownActors.length === 0
        ? { model: shown }
        : {
            commands: [
              LoadActorNames({
                revision: meta.revision,
                userIds: unknownActors,
              }),
            ],
            model: shown,
          },
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

const isRefusedRelatedPage = (list: RelatedList): boolean =>
  Option.contains(AsyncData.getError(list.records), "SchemaChanged");

/**
 * A related list's page that did not load; the cursor stays on the page
 * shown. Refused with `SchemaChanged` (decision 0020), the page reloads
 * the endpoint's metadata (its `relatedLists` name the back-reference
 * field as it is now) and the related table's, and asks for the first page
 * once both arrived (`receiveRelatedMetadata`, `requestWaitingRelated`).
 *
 * @param model - The page.
 * @param key - The related list.
 * @param generation - The answered request's number.
 * @param error - Why it did not load.
 * @returns The page, reloading what the refusal needs.
 */
const failRelatedPage = (
  model: Model,
  key: string,
  generation: number,
  error: RelatedError
): UpdateReturn => {
  if (!isCurrentRelated(model, key, generation)) {
    return { model };
  }

  const failed = failRelatedRecords(model, key, generation, error);

  return error === "SchemaChanged"
    ? Update.combine(failed, [refreshMetadata, loadRelatedMetadata(key)])
    : { model: failed };
};

const isWaitingForPage = (list: RelatedList): boolean => {
  const isUnasked =
    AsyncData.isIdle(list.records) || isRefusedRelatedPage(list);

  return list.isOpen && AsyncData.isSuccess(list.metadata) && isUnasked;
};

/**
 * Asks for the first page of each open related list that waits for one
 * (never loaded, or refused with `SchemaChanged`) and whose table's
 * metadata is loaded, after the endpoint's metadata arrived.
 *
 * @param model - The page.
 * @returns It, with the requests.
 */
const requestWaitingRelated: Step = (model) =>
  inSequence(
    Record.toEntries(model.relatedLists).flatMap(([key, list]) =>
      isWaitingForPage(list) ? [firstRelatedPage(key)] : []
    )
  )(model);

/**
 * "Try again" on a related list: after a `SchemaChanged` refusal, or when
 * its table's metadata did not load, both metadata are reloaded (the first
 * page follows); otherwise the page shown is asked for again, with the
 * back-reference's current name.
 *
 * @param model - The page.
 * @param key - The related list.
 * @returns The page and its Commands.
 */
const retryRelatedList = (model: Model, key: string): UpdateReturn =>
  Option.match(Record.get(model.relatedLists, key), {
    onNone: () => ({ model }),
    onSome: (list) => {
      if (isRefusedRelatedPage(list)) {
        return Update.combine(model, [
          refreshMetadata,
          loadRelatedMetadata(key),
        ]);
      }

      return AsyncData.isSuccess(list.metadata)
        ? requestRelatedPage(key, (current) => current.cursors)(model)
        : loadRelatedMetadata(key)(model);
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

  return {
    commands: [LoadTarget({ revision, table: target })],
    model: modifyFields(model, {
      targets: Record.set(target, TargetMetadata.Loading()),
    }),
  };
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
              allowedFor: `${model.table}/${field.name}`,
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

  return message._tag === "Opened"
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

const receiveTarget = (model: Model, target: MetaTable): UpdateReturn => {
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
 * @param reason - Why its metadata did not load.
 * @returns The page.
 */
const failTarget = (
  model: Model,
  table: string,
  reason: MetaError
): PlainReturn =>
  failTargetPickers(
    modifyFields(model, {
      targets: Record.set(table, TargetMetadata.Failure({ error: reason })),
    }),
    table
  );

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

const reloadingTarget = (
  known: Model["targets"],
  name: string
): Model["targets"][string] =>
  Option.match(Option.flatMap(Record.get(known, name), AsyncData.getData), {
    onNone: () => TargetMetadata.Loading(),
    onSome: (data) => TargetMetadata.Refreshing({ data }),
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
      onSome: ([name, meta]) => ({
        commands: [LoadTarget({ revision: meta.revision, table: name })],
        model: modifyFields(model, {
          targets: (known) =>
            Record.set(known, name, reloadingTarget(known, name)),
        }),
      }),
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
      const isOther = record.class !== meta.table.name;

      const isCurrent = Option.exists(
        classMetaOf(model),
        (concrete) => concrete.name === record.class
      );

      return isOther && !isCurrent && !AsyncData.isPending(model.classMetadata)
        ? {
            commands: [
              LoadClassMetadata({
                revision: meta.revision,
                table: record.class,
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
    !Option.exists(recordOf(model), (record) => record.class === table.name)
  ) {
    return { model };
  }

  const loaded = modifyFields(model, {
    classMetadata: () => ClassMetadata.Success({ data: table }),
  });

  const byDefinitions = withReconciled(
    loaded,
    reconcileWithMetadata(
      loaded.edits,
      fieldsOf(model),
      fieldsOf(loaded),
      isCreating(loaded)
    )
  );

  const byRecord = withReconciled(
    byDefinitions,
    reconcileWithRecord(byDefinitions.edits, fieldsOf(byDefinitions), (field) =>
      fieldShowOf(field, editedRecordOf(byDefinitions))
    )
  );

  return setUpControls(byRecord);
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

  // NOTE: edits are reconciled with the endpoint's new fields only; the
  // concrete class's metadata and the record follow, and the record's
  // reread reconciles again (`receiveRecord`).
  const reconciled = isOtherRevision
    ? reconcileWithMetadata(
        model.edits,
        fieldsOf(model),
        formFieldsOf(table, Option.none()),
        isCreating(model)
      )
    : { dropped: [], edits: model.edits };

  const loaded = syncRelatedLists(
    withReconciled(
      modifyFields(model, {
        classMetadata: (classMetadata) =>
          isFirstLoad ? classMetadata : ClassMetadata.Idle(),
        metadata: () => Metadata.Success({ data: { revision, table } }),
        submission: (submission) =>
          isOtherRevision && isRefusedAsStale(submission)
            ? Submission.Outdated()
            : submission,
      }),
      reconciled
    ),
    table
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

const receiveRecord = (
  model: Model,
  generation: number,
  record: Parameters<typeof StoredRecord.Success>[0]["data"],
  purpose: ReadPurpose,
  maybeRevision: Option.Option<SchemaRevision>
): UpdateReturn => {
  // NOTE: a reread that left before a save and arrives after it holds an
  // older version than the saved record; it is not shown.
  const isOlder = Option.exists(
    recordOf(model),
    (current) => current.id === record.id && current.version > record.version
  );

  if (generation !== model.generation || isOlder) {
    return { model };
  }

  const afterConflict = purpose === "ReloadAfterConflict";

  const isChangedUnderEdits =
    purpose !== "Open" &&
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
    submission: (submission) =>
      afterConflict ? Submission.Idle() : submission,
  });

  const shown =
    purpose === "Open"
      ? read
      : withReconciled(
          read,
          reconcileWithRecord(read.edits, fieldsOf(read), (field) =>
            fieldShowOf(field, Option.some(record))
          )
        );

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
  if (
    Submission.guards.Saving(model.submission) ||
    !isReady(model) ||
    isReloading(model) ||
    isRecordOutdated(model)
  ) {
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
            generation,
            revision: meta.revision,
            secrets: check.body.secrets,
            table: model.table,
            values: check.body.values,
          }),
        onSome: (record) =>
          UpdateRecord({
            generation,
            recordId: record.id,
            revision: meta.revision,
            secrets: check.body.secrets,
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

  const withLabels = {
    ...saved,
    labels: labelsAfterSave(
      modifyFields(model, { edits: () => submission.sentEdits }),
      saved
    ),
  };

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

  // NOTE: after a create, the later edits now judge by the update limits
  // (a field writable only on create drops its edit with a note).
  const asUpdate = wasCreating
    ? withReconciled(
        stored,
        reconcileWithMetadata(
          stored.edits,
          fieldsOf(model),
          fieldsOf(stored),
          false
        )
      )
    : stored;

  // NOTE: the later edits now apply to the saved record; one it withholds
  // or shows read-only is dropped with a note, as after any reread.
  const rebased = withReconciled(
    asUpdate,
    reconcileWithRecord(asUpdate.edits, fieldsOf(asUpdate), (field) =>
      fieldShowOf(field, Option.some(withLabels))
    )
  );

  const shown = Option.match(metaOf(rebased), {
    onNone: () => rebased,
    onSome: (meta) =>
      wasCreating ? syncRelatedLists(rebased, meta.table) : rebased,
  });

  return sawRevision(
    Update.combine(resetPickerInputs(shown), [
      (stepModel) => ({ commands: navigation, model: stepModel }),
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
    ClickedNextRelatedPage: ({ key }) =>
      pageRelated(model, key, nextRelatedCursors),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedPreviousRelatedPage: ({ key }) =>
      pageRelated(model, key, previousRelatedCursors),
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
    ClickedRetryRelatedList: ({ key }) => retryRelatedList(model, key),
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
    FailedLoadActorNames: () => ({ model }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadClassMetadata: ({ error, table }) => ({
      model: Option.exists(recordOf(model), (record) => record.class === table)
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
    FailedLoadRecord: ({ error, generation, maybeRevision }) =>
      failRecord(model, generation, error, maybeRevision),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadRelatedMetadata: ({ error, key }) =>
      failRelatedMetadata(model, key, error),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadRelatedRecords: ({ error, generation, key }) =>
      failRelatedPage(model, key, generation, error),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadTarget: ({ error, table }) => failTarget(model, table, error),
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
    SucceededLoadActorNames: ({ names }) => ({
      model: modifyFields(model, {
        history: (history) =>
          modifyFields(history, {
            actorNames: (known) => Record.union(known, names, keepExisting),
          }),
      }),
    }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadClassMetadata: ({ table }) =>
      receiveClassMetadata(model, table),
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
    SucceededLoadRecord: ({ generation, maybeRevision, purpose, record }) =>
      receiveRecord(model, generation, record, purpose, maybeRevision),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadRelatedMetadata: ({ key, revision, table }) =>
      receiveRelatedMetadata(model, key, { revision, table }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadRelatedRecords: ({ generation, key, maybeRevision, page }) =>
      sawRevision(
        Update.combine(model, [
          (stepModel) =>
            receiveRelatedRecords(stepModel, key, generation, page),
          refreshIfNewer(maybeRevision),
        ]),
        maybeRevision
      ),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadTarget: ({ table }) => receiveTarget(model, table),
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
    ToggledRelatedList: ({ isOpen, key }) =>
      toggleRelatedList(model, key, isOpen),
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
