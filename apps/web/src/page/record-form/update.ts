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
import type { Expr } from "@std/conditions/ast";
import type {
  MetaField,
  MetaRelatedList,
  MetaTable,
} from "@std/definitions/table-metadata";
import { Option, Record, Result, pipe } from "effect";
import { AsyncData, Update } from "foldkit";
import type { CalendarDate } from "foldkit/calendar";
import { modifyFields } from "foldkit/struct";

import { fieldShowOf, formFieldsOf } from "../../domain/form-fields.ts";
import { FieldInput } from "../../domain/form-input.ts";
import { listColumns } from "../../domain/list-columns.ts";
import { filterParameter } from "../../domain/list-query.ts";
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
  PickerItem,
  RecordError,
  RelatedError,
  RelatedList,
  StoredRecord as StoredRecordState,
} from "./model.ts";

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
  metadata: RelatedMetadata.Idle(),
  records: RelatedRecords.Idle(),
});

const syncRelatedLists = (model: Model, table: MetaTable): Model =>
  isCreating(model)
    ? model
    : modifyFields(model, {
        relatedLists: (lists) =>
          Record.fromIterableWith(table.relatedLists, (entry) => {
            const key = relatedKeyOf(entry);

            return [
              key,
              Option.getOrElse(Record.get(lists, key), () =>
                closedRelatedList(entry)
              ),
            ];
          }),
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

const columnNamesOf = (table: MetaTable): string =>
  listColumns(table)
    .map((field) => field.name)
    .join(",");

const loadingRelatedPage =
  (generation: number) =>
  (list: RelatedList): RelatedList =>
    modifyFields(list, {
      generation: () => generation,
      records: reloadingRelated,
    });

const relatedPageRequest = (
  model: Model,
  key: string,
  list: RelatedList,
  recordId: string
): PlainReturn =>
  Option.match(AsyncData.getData(list.metadata), {
    onNone: () => ({ model }),
    onSome: (meta) => {
      const generation = list.generation + 1;

      return {
        commands: [
          LoadRelatedRecords({
            cursor: Option.flatten(Option.fromNullishOr(list.cursors.at(-1))),
            fields: columnNamesOf(meta.table),
            filter: relatedFilterOf(list, recordId),
            generation,
            key,
            revision: meta.revision,
            table: list.entry.table,
          }),
        ],
        model: writeRelatedList(model, key, loadingRelatedPage(generation)),
      };
    },
  });

/**
 * Asks for a related list's current page, once its table's metadata and
 * the record are known.
 *
 * @param key - The related list.
 * @returns The step.
 */
const requestRelatedPage =
  (key: string): Step =>
  (model) =>
    Option.match(
      Option.all([Record.get(model.relatedLists, key), recordOf(model)]),
      {
        onNone: () => ({ model }),
        onSome: ([list, record]) =>
          relatedPageRequest(model, key, list, record.id),
      }
    );

const loadingRelatedMetadata = (list: RelatedList): RelatedList =>
  modifyFields(list, {
    cursors: () => [Option.none()],
    metadata: () => RelatedMetadata.Loading(),
    records: () => RelatedRecords.Idle(),
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
  toCursors: (
    list: RelatedList
  ) => Option.Option<readonly Option.Option<string>[]>
): UpdateReturn =>
  Option.match(
    pipe(
      Record.get(model.relatedLists, key),
      Option.filter((list) => !isRelatedPaging(list)),
      Option.flatMap(toCursors)
    ),
    {
      onNone: () => ({ model }),
      onSome: (cursors) =>
        requestRelatedPage(key)(
          writeRelatedList(model, key, (list) =>
            modifyFields(list, { cursors: () => cursors })
          )
        ),
    }
  );

const nextRelatedCursors = (
  list: RelatedList
): Option.Option<readonly Option.Option<string>[]> =>
  Option.map(
    Option.flatMap(
      AsyncData.getData(list.records),
      (page) => page.maybeNextCursor
    ),
    (cursor) => [...list.cursors, Option.some(cursor)]
  );

const previousRelatedCursors = (
  list: RelatedList
): Option.Option<readonly Option.Option<string>[]> =>
  list.cursors.length > 1
    ? Option.some(list.cursors.slice(0, -1))
    : Option.none();

const receiveRelatedMetadata = (
  model: Model,
  key: string,
  meta: { readonly revision: SchemaRevision; readonly table: MetaTable }
): UpdateReturn =>
  requestRelatedPage(key)(
    writeRelatedList(model, key, (list) =>
      modifyFields(list, {
        metadata: () => RelatedMetadata.Success({ data: meta }),
      })
    )
  );

const failRelatedMetadata = (
  model: Model,
  key: string,
  error: MetaError
): PlainReturn => ({
  model: writeRelatedList(model, key, (list) =>
    modifyFields(list, {
      metadata: () => RelatedMetadata.Failure({ error }),
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
          records: () => RelatedRecords.Success({ data: page }),
        })
      : list
  ),
});

const failRelatedRecords = (
  model: Model,
  key: string,
  generation: number,
  error: RelatedError
): PlainReturn => ({
  model: writeRelatedList(model, key, (list) =>
    list.generation === generation
      ? modifyFields(list, {
          records: (records) =>
            Option.match(AsyncData.getData(records), {
              onNone: () => RelatedRecords.Failure({ error }),
              onSome: (data) => RelatedRecords.Stale({ data, error }),
            }),
        })
      : list
  ),
});

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
 * The search a picker sends: the target's display field contains the
 * typed text, printed with the target's names.
 *
 * @param target - The target table's metadata.
 * @param text - The typed text.
 * @returns The `filter` parameter; none for an empty text, or when the
 *   caller cannot read the target's display field.
 */
const pickerFilterOf = (
  target: MetaTable,
  text: string
): Option.Option<string> => {
  const needle = text.trim();

  const maybeDisplay = Option.flatMap(
    Option.fromNullishOr(target.displayField),
    (name) =>
      Option.fromNullishOr(target.fields.find((field) => field.name === name))
  );

  return pipe(
    maybeDisplay,
    Option.filter(() => needle !== ""),
    Option.flatMap((display) => {
      const condition: Expr = {
        left: { path: [display.id] },
        op: "contains",
        right: needle,
      };

      return Result.getSuccess(
        filterParameter(
          condition,
          target.name,
          new Map([[target.name, target]])
        )
      );
    })
  );
};

const searchingPicker =
  (generation: number, query: string) =>
  (picker: Picker): Picker =>
    modifyFields(picker, {
      generation: () => generation,
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

/**
 * Asks for a picker's targets: those the caller can see that the field's
 * allowed-records condition admits (`allowedFor`), whose display field
 * contains the text. Waits for the target's metadata.
 *
 * @param fieldId - The reference field.
 * @param query - The typed text; `""` lists the first targets.
 * @returns The step.
 */
const searchTargets =
  (fieldId: string, query: string): Step =>
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
          searchingPicker(generation, query)
        );

        return Option.match(maybeTargetMeta, {
          onNone: () => reloadFailedTarget(waiting, target, meta.revision),
          onSome: (targetMeta) => ({
            commands: [
              SearchTargets({
                allowedFor: `${model.table}/${field.name}`,
                displayField: Option.fromNullishOr(targetMeta.displayField),
                fieldId,
                filter: pickerFilterOf(targetMeta, query),
                generation,
                revision: meta.revision,
                target: targetMeta.name,
              }),
            ],
            model: waiting,
          }),
        });
      },
    });

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
 * A picker's Message: the Combobox's own update, then a search when the
 * user opens the list (the first targets) or types (targets containing
 * the text).
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

  return inSequence(waiting)(known);
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

const receiveSearch = (
  model: Model,
  fieldId: string,
  generation: number,
  items: readonly PickerItem[]
): PlainReturn => ({
  model: writePicker(model, fieldId, (picker) =>
    picker.generation === generation
      ? modifyFields(picker, {
          results: () => PickerResults.Success({ data: items }),
        })
      : picker
  ),
});

const failSearch = (
  model: Model,
  fieldId: string,
  generation: number
): PlainReturn => ({
  model: writePicker(model, fieldId, (picker) =>
    picker.generation === generation
      ? modifyFields(picker, {
          results: () => PickerResults.Failure({ error: "Unavailable" }),
        })
      : picker
  ),
});

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
    isReloading(model)
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
          submission: () => Submission.Saving({ generation }),
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

const receiveSave = (
  model: Model,
  generation: number,
  saved: SavedRecord,
  maybeRevision: Option.Option<SchemaRevision>
): UpdateReturn => {
  if (
    !Option.contains(
      Submission.guards.Saving(model.submission)
        ? Option.some(model.submission.generation)
        : Option.none(),
      generation
    )
  ) {
    return { model };
  }

  if (isCreating(model)) {
    return sawRevision(
      {
        commands: [
          NavigateAway({
            url: recordRouter({ id: saved.id, table: model.table }),
          }),
        ],
        model: modifyFields(model, {
          edits: () => ({}),
          submission: () => Submission.Saved({ isVisible: true }),
        }),
      },
      maybeRevision
    );
  }

  if (!isVisibleRecord(saved)) {
    return sawRevision(
      {
        model: modifyFields(model, {
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
    labels: labelsAfterSave(model, saved),
  };

  const stored = modifyFields(model, {
    droppedEdits: () => [],
    edits: () => ({}),
    maybeEditsFrom: () => Option.none(),
    record: () => StoredRecord.Success({ data: withLabels }),
    serverErrors: () => ({}),
    staleChanges: () => [],
    submission: () => Submission.Saved({ isVisible: true }),
  });

  return sawRevision(
    Update.combine(resetPickerInputs(stored), [
      refreshHistory,
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
 * stale, else the record.
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

  return AsyncData.isStale(model.metadata)
    ? refreshMetadata(model)
    : requestRecord("Open")(model);
};

const retryRelatedList = (model: Model, key: string): UpdateReturn =>
  Option.match(Record.get(model.relatedLists, key), {
    onNone: () => ({ model }),
    onSome: (list) =>
      AsyncData.hasData(list.metadata) &&
      !Option.exists(
        AsyncData.getError(list.records),
        (reason) => reason === "SchemaChanged"
      )
        ? requestRelatedPage(key)(model)
        : loadRelatedMetadata(key)(model),
  });

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
      failRelatedRecords(model, key, generation, error),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadTarget: ({ error, table }) => failTarget(model, table, error),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedSaveRecord: ({ error, generation, maybeRevision }) =>
      failSave(model, generation, error, maybeRevision),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedSearchTargets: ({ fieldId, generation }) =>
      failSearch(model, fieldId, generation),
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
    SucceededLoadClassMetadata: ({ table }) => ({
      model: Option.exists(
        recordOf(model),
        (record) => record.class === table.name
      )
        ? modifyFields(model, {
            classMetadata: () => ClassMetadata.Success({ data: table }),
          })
        : model,
    }),
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
    SucceededSearchTargets: ({ fieldId, generation, items, maybeRevision }) =>
      sawRevision(
        Update.combine(model, [
          (stepModel) => receiveSearch(stepModel, fieldId, generation, items),
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
