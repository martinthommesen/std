/**
 * The point-and-click filter builder (plan Step 2): a Submodel over the
 * condition AST (Contracts 5.2) in the filter profile (5.10). It edits a
 * draft; "Apply" converts it to an AST and hands it to the page as an
 * OutMessage, and a draft whose values do not convert shows each
 * condition's problem instead.
 *
 * The builder reads metadata, never fetches it: the page passes the tables
 * it holds (`ConditionScope`) to `update` and `view`, and the builder asks
 * for a reference's target table with `RequestedTable` when the user picks
 * that reference, so that the target's fields can be offered for a path.
 */
import { DatePicker } from "@foldkit/ui";
import { ExprSchema } from "@std/conditions/ast";
import type { Expr } from "@std/conditions/ast";
import { Effect, Option, Result, Schema } from "effect";
import { Command, Dom, Update } from "foldkit";
import type { CalendarDate } from "foldkit/calendar";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import type { MetaField } from "../domain/metadata.ts";
import {
  isEmptyFilter,
  isFilterable,
  loadCondition,
  pickerIdOf,
  resolvePath,
  targetOf,
  toCondition,
} from "./condition.ts";
import type { ConditionScope, LoadProblem } from "./condition.ts";
import {
  Condition,
  FilterOperator,
  Group,
  Junction,
  NowUnit,
  Operand,
  PeriodUnit,
  TodayUnit,
  ValueSource,
} from "./model.ts";
import type { FilterNode, Model } from "./model.ts";
import {
  defaultOperand,
  operandFits,
  operandForSource,
  operatorsFor,
} from "./operators.ts";
import {
  appendTo,
  emptyRoot,
  findCondition,
  removeNode,
  replaceCondition,
  replaceNode,
  toggleNegation,
} from "./tree.ts";

// MESSAGE

/** What happens in the builder. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Message = defineMessageUnion({
  ClickedAddCondition: { groupId: Schema.Int },
  ClickedAddGroup: { groupId: Schema.Int },
  ClickedApply: {},
  ClickedClear: {},
  ClickedRemoveNode: { nodeId: Schema.Int },
  CompletedFocusProblem: {},
  GotDatePickerMessage: {
    conditionId: Schema.Int,
    message: DatePicker.Message,
  },
  SelectedChoice: {
    conditionId: Schema.Int,
    maybeKey: Schema.Option(Schema.String),
  },
  SelectedField: { conditionId: Schema.Int, fieldId: Schema.String },
  SelectedJunction: { groupId: Schema.Int, junction: Junction },
  SelectedOperator: { conditionId: Schema.Int, operator: FilterOperator },
  SelectedTargetField: {
    conditionId: Schema.Int,
    maybeFieldId: Schema.Option(Schema.String),
  },
  SelectedUnit: { conditionId: Schema.Int, unit: Schema.String },
  SelectedValueSource: { conditionId: Schema.Int, source: ValueSource },
  ToggledChoice: {
    conditionId: Schema.Int,
    isChecked: Schema.Boolean,
    key: Schema.String,
  },
  ToggledFlag: { conditionId: Schema.Int, isChecked: Schema.Boolean },
  ToggledNegation: { nodeId: Schema.Int },
  UpdatedOffset: { conditionId: Schema.Int, offset: Schema.String },
  UpdatedText: { conditionId: Schema.Int, text: Schema.String },
  UpdatedTime: { conditionId: Schema.Int, time: Schema.String },
});

/** What happens in the builder. */
export type Message = typeof Message.Type;

// OUT MESSAGE

/**
 * What the builder tells the page.
 *
 * - `RequestedTable`: the user picked a reference whose target table the
 *   page has no metadata for; the page loads it (once) if it can.
 * - `SubmittedFilter`: the user applied the draft (or cleared it); `None`
 *   is no filter.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const OutMessage = defineMessageUnion({
  RequestedTable: { table: Schema.String },
  SubmittedFilter: { maybeCondition: Schema.Option(ExprSchema) },
});

/** What the builder tells the page. */
export type OutMessage = typeof OutMessage.Type;

// INIT

const ROOT_ID = 0;

/** The calendar's today until the page has read it (never shown in practice). */
const FALLBACK_TODAY: CalendarDate = { day: 1, month: 1, year: 2000 };

/**
 * An empty builder.
 *
 * @param id - The prefix of its element IDs.
 * @returns The builder with no filter.
 */
export const init = (id: string): Model => ({
  id,
  isShowingProblems: false,
  maybeToday: Option.none(),
  nextNodeId: ROOT_ID + 1,
  root: emptyRoot(ROOT_ID),
});

/**
 * Sets the calendar's today, which the page reads in UTC.
 *
 * @param model - The builder.
 * @param today - Today.
 * @returns The builder.
 */
export const withToday = (model: Model, today: CalendarDate): Model =>
  modifyFields(model, { maybeToday: () => Option.some(today) });

/**
 * Loads a stored condition into the builder, replacing the draft.
 *
 * @param model - The builder.
 * @param maybeCondition - The condition; `None` is no filter.
 * @param scope - The tables the browser holds.
 * @returns The builder, or why the condition cannot be shown.
 */
export const load = (
  model: Model,
  maybeCondition: Option.Option<Expr>,
  scope: ConditionScope
): Result.Result<Model, LoadProblem> =>
  Option.match(maybeCondition, {
    onNone: () =>
      Result.succeed(
        modifyFields(model, {
          isShowingProblems: () => false,
          nextNodeId: (next) => next + 1,
          root: () => emptyRoot(model.nextNodeId),
        })
      ),
    onSome: (expr) =>
      Result.map(
        loadCondition(expr, {
          ...scope,
          builderId: model.id,
          firstNodeId: model.nextNodeId,
          today: Option.getOrElse(model.maybeToday, () => FALLBACK_TODAY),
        }),
        (loaded) =>
          modifyFields(model, {
            isShowingProblems: () => false,
            nextNodeId: () => loaded.nextNodeId,
            root: () => loaded.root,
          })
      ),
  });

/**
 * The draft as a condition, when every value converts.
 *
 * @param model - The builder.
 * @param scope - The tables the browser holds.
 * @returns `None` for no filter, the condition, or the problems.
 */
export const currentCondition = (model: Model, scope: ConditionScope) =>
  isEmptyFilter(model.root)
    ? Result.succeed(Option.none<Expr>())
    : Result.map(toCondition(model.root, scope), Option.some);

/**
 * The element ID of one part of a node's controls, such as its `value`
 * input or its `legend`.
 *
 * @param model - The builder.
 * @param nodeId - The condition or group.
 * @param part - The part.
 * @returns The ID.
 */
export const nodeElementId = (
  model: Model,
  nodeId: number,
  part: string
): string => `${model.id}-node-${nodeId}-${part}`;

/**
 * The controls focus may move to for a node's problem, the most telling
 * first: the value a condition holds (its text, offset or time), then its
 * field; a group's "all"/"any" choice.
 */
const PROBLEM_PARTS = ["value", "offset", "time", "field", "junction"];

// COMMAND

/**
 * Moves focus to the first control of a node with a problem, after an
 * "Apply" that found one: the first of the given element IDs that exists.
 */
export const FocusProblem = Command.define("FocusProblem", {
  args: { elementIds: Schema.Array(Schema.String) },
  execute: ({ elementIds }) =>
    // NOTE: `Effect.void` closes the list, so it is never empty (an empty
    // `firstSuccessOf` dies) and a page without any of the controls
    // completes all the same.
    Effect.firstSuccessOf([
      ...elementIds.map((elementId) => Dom.focus(`#${elementId}`)),
      Effect.void,
    ]).pipe(Effect.ignore, Effect.as(Message.CompletedFocusProblem())),
  messages: [Message.CompletedFocusProblem],
});

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>;

type PlainReturn = Update.Return<Model, Message>;

type Step = Update.Step<Model, Message>;

const takeIds = (model: Model, count: number) => ({
  first: model.nextNodeId,
  model: modifyFields(model, { nextNodeId: (next) => next + count }),
});

const operandContext = (model: Model, conditionId: number) => ({
  pickerId: pickerIdOf(model.id, conditionId),
  today: Option.getOrElse(model.maybeToday, () => FALLBACK_TODAY),
});

/**
 * The condition a field starts as: its first operator, with that
 * operator's empty operand.
 *
 * @param model - The builder.
 * @param id - The condition's ID.
 * @param path - The path to the field.
 * @param field - The field compared.
 * @returns The condition.
 */
const freshCondition = (
  model: Model,
  id: number,
  path: readonly string[],
  field: MetaField
): Condition => {
  const operator = operatorsFor(field.type.kind)[0] ?? "empty";

  return Condition({
    id,
    operand: defaultOperand(
      field.type.kind,
      operator,
      operandContext(model, id)
    ),
    operator,
    path,
  });
};

const firstFilterableField = (
  scope: ConditionScope
): Option.Option<MetaField> =>
  Option.fromNullishOr(
    scope.tables.get(scope.table)?.fields.find(isFilterable)
  );

/**
 * When a field is a reference whose target the page does not hold yet, the
 * request for that table.
 *
 * @param field - The field picked.
 * @param scope - The tables.
 * @returns The OutMessage, if any.
 */
const requestTargetOf = (
  field: MetaField,
  scope: ConditionScope
): OutMessage | undefined =>
  field.type.kind === "reference" &&
  field.type.target !== null &&
  Option.isNone(targetOf(field, scope.tables))
    ? OutMessage.RequestedTable({ table: field.type.target })
    : undefined;

const addCondition = (
  model: Model,
  groupId: number,
  scope: ConditionScope
): UpdateReturn =>
  Option.match(firstFilterableField(scope), {
    onNone: () => ({ model }),
    onSome: (field) => {
      const ids = takeIds(model, 2);

      return Update.withOutMessage(
        {
          model: modifyFields(ids.model, {
            root: (root) =>
              appendTo(
                root,
                groupId,
                freshCondition(ids.model, ids.first, [field.id], field),
                ids.first + 1
              ),
          }),
        },
        requestTargetOf(field, scope)
      );
    },
  });

/**
 * Starts an empty filter with its first condition, as "Add condition"
 * does, so whoever opens the builder picks a field straight away; a
 * filter that holds anything is left as it is.
 *
 * @param model - The builder.
 * @param scope - The tables the filter can name.
 * @returns The builder, and the request for a target table the first
 *   field may need.
 */
export const startFilter = (
  model: Model,
  scope: ConditionScope
): UpdateReturn =>
  isEmptyFilter(model.root)
    ? addCondition(model, model.root.id, scope)
    : { model };

const addGroup = (model: Model, groupId: number): UpdateReturn => {
  const ids = takeIds(model, 2);

  return {
    model: modifyFields(ids.model, {
      root: (root) =>
        appendTo(
          root,
          groupId,
          Group({ children: [], id: ids.first, junction: "and" }),
          ids.first + 1
        ),
    }),
  };
};

const selectField = (
  model: Model,
  conditionId: number,
  path: readonly string[],
  scope: ConditionScope
): UpdateReturn =>
  Option.match(resolvePath(path, scope), {
    onNone: () => ({ model }),
    onSome: ({ hops, field }) => {
      const [first] = hops;

      return Update.withOutMessage(
        {
          model: modifyFields(model, {
            root: (root) =>
              replaceCondition(root, conditionId, () =>
                freshCondition(model, conditionId, path, field)
              ),
          }),
        },
        path.length === 1 && first !== undefined
          ? requestTargetOf(first.field, scope)
          : undefined
      );
    },
  });

const fieldOf = (
  model: Model,
  conditionId: number,
  scope: ConditionScope
): Option.Option<MetaField> =>
  Option.flatMap(findCondition(model.root, conditionId), (condition) =>
    Option.map(resolvePath(condition.path, scope), ({ field }) => field)
  );

const changeCondition = (
  model: Model,
  conditionId: number,
  change: (condition: Condition) => Condition
): PlainReturn => ({
  model: modifyFields(model, {
    root: (root) => replaceCondition(root, conditionId, change),
  }),
});

const changeOperand = (
  model: Model,
  conditionId: number,
  change: (operand: Operand) => Operand
): PlainReturn =>
  changeCondition(model, conditionId, (condition) =>
    Condition({ ...condition, operand: change(condition.operand) })
  );

const selectOperator = (
  model: Model,
  conditionId: number,
  operator: FilterOperator,
  scope: ConditionScope
): UpdateReturn =>
  Option.match(fieldOf(model, conditionId, scope), {
    onNone: () => ({ model }),
    onSome: (field) =>
      changeCondition(model, conditionId, (condition) =>
        Condition({
          ...condition,
          operand: operandFits(condition.operand, field.type.kind, operator)
            ? condition.operand
            : defaultOperand(
                field.type.kind,
                operator,
                operandContext(model, conditionId)
              ),
          operator,
        })
      ),
  });

const selectValueSource = (
  model: Model,
  conditionId: number,
  source: ValueSource,
  scope: ConditionScope
): UpdateReturn =>
  Option.match(fieldOf(model, conditionId, scope), {
    onNone: () => ({ model }),
    onSome: (field) =>
      changeOperand(model, conditionId, () =>
        operandForSource(
          field.type.kind,
          source,
          operandContext(model, conditionId)
        )
      ),
  });

const isTodayUnit = Schema.is(TodayUnit);

const isNowUnit = Schema.is(NowUnit);

const isPeriodUnit = Schema.is(PeriodUnit);

const withUnit =
  (unit: string) =>
  (operand: Operand): Operand => {
    if (Operand.guards.Today(operand) && isTodayUnit(unit)) {
      return Operand.Today({ offset: operand.offset, unit });
    }

    if (Operand.guards.FromNow(operand) && isNowUnit(unit)) {
      return Operand.FromNow({ offset: operand.offset, unit });
    }

    return Operand.guards.Period(operand) && isPeriodUnit(unit)
      ? Operand.Period({ offset: operand.offset, unit })
      : operand;
  };

const withOffset =
  (offset: string) =>
  (operand: Operand): Operand => {
    if (Operand.guards.Today(operand)) {
      return Operand.Today({ offset, unit: operand.unit });
    }

    if (Operand.guards.FromNow(operand)) {
      return Operand.FromNow({ offset, unit: operand.unit });
    }

    return Operand.guards.Period(operand)
      ? Operand.Period({ offset, unit: operand.unit })
      : operand;
  };

const withText =
  (text: string) =>
  (operand: Operand): Operand => {
    if (Operand.guards.Typed(operand)) {
      return Operand.Typed({ text });
    }

    return Operand.guards.Lines(operand) ? Operand.Lines({ text }) : operand;
  };

const withChoiceToggled =
  (key: string, isChecked: boolean) =>
  (operand: Operand): Operand =>
    Operand.guards.ChoiceSet(operand)
      ? Operand.ChoiceSet({
          keys: isChecked
            ? [...operand.keys.filter((kept) => kept !== key), key]
            : operand.keys.filter((kept) => kept !== key),
        })
      : operand;

const withTime =
  (time: string) =>
  (operand: Operand): Operand =>
    Operand.guards.Instant(operand)
      ? Operand.Instant({ ...operand, time })
      : operand;

const withDate =
  (maybeDate: Option.Option<CalendarDate>) =>
  (operand: Operand): Operand => {
    if (Operand.guards.Day(operand)) {
      return Operand.Day({ ...operand, maybeDate });
    }

    return Operand.guards.Instant(operand)
      ? Operand.Instant({ ...operand, maybeDate })
      : operand;
  };

const pickerOf = (operand: Operand): Option.Option<DatePicker.Model> => {
  if (Operand.guards.Day(operand) || Operand.guards.Instant(operand)) {
    return Option.some(operand.picker);
  }

  return Option.none();
};

const withPicker =
  (picker: DatePicker.Model) =>
  (operand: Operand): Operand => {
    if (Operand.guards.Day(operand)) {
      return Operand.Day({ ...operand, picker });
    }

    return Operand.guards.Instant(operand)
      ? Operand.Instant({ ...operand, picker })
      : operand;
  };

const setDate =
  (conditionId: number, maybeDate: Option.Option<CalendarDate>): Step =>
  (model) =>
    changeOperand(model, conditionId, withDate(maybeDate));

const foldDatePicker = Update.foldChildAt({
  foldOutMessage: (conditionId: number) =>
    DatePicker.OutMessage.match<Step>({
      // oxlint-disable-next-line sonarjs/function-name -- an OutMessage.match case is keyed by its OutMessage's tag
      ChangedViewMonth: () => (model) => ({ model }),
      // oxlint-disable-next-line sonarjs/function-name -- an OutMessage.match case is keyed by its OutMessage's tag
      ClearedDate: () => setDate(conditionId, Option.none()),
      // oxlint-disable-next-line sonarjs/function-name -- an OutMessage.match case is keyed by its OutMessage's tag
      SelectedDate: ({ date }) => setDate(conditionId, Option.some(date)),
    }),
  readAt: (model: Model, conditionId: number) =>
    Option.flatMap(findCondition(model.root, conditionId), (condition) =>
      pickerOf(condition.operand)
    ),
  toParentMessage: (conditionId, message) =>
    Message.GotDatePickerMessage({ conditionId, message }),
  update: DatePicker.update,
  writeAt: (model: Model, conditionId: number, nextPicker: DatePicker.Model) =>
    modifyFields(model, {
      root: (root) =>
        replaceCondition(root, conditionId, (condition) =>
          Condition({
            ...condition,
            operand: withPicker(nextPicker)(condition.operand),
          })
        ),
    }),
});

const apply = (model: Model, scope: ConditionScope): UpdateReturn =>
  Result.match(currentCondition(model, scope), {
    onFailure: (problems) => ({
      commands: problems.slice(0, 1).map((problem) =>
        FocusProblem({
          elementIds: PROBLEM_PARTS.map((part) =>
            nodeElementId(model, problem.conditionId, part)
          ),
        })
      ),
      model: modifyFields(model, { isShowingProblems: () => true }),
    }),
    onSuccess: (maybeCondition) => ({
      model: modifyFields(model, { isShowingProblems: () => false }),
      outMessage: OutMessage.SubmittedFilter({ maybeCondition }),
    }),
  });

const clear = (model: Model): UpdateReturn => ({
  model: modifyFields(model, {
    isShowingProblems: () => false,
    nextNodeId: (next) => next + 1,
    root: () => emptyRoot(model.nextNodeId),
  }),
  outMessage: OutMessage.SubmittedFilter({ maybeCondition: Option.none() }),
});

const negate = (model: Model, nodeId: number): UpdateReturn => {
  const ids = takeIds(model, 1);

  return {
    model: modifyFields(ids.model, {
      root: (root) => toggleNegation(root, nodeId, ids.first),
    }),
  };
};

const setJunction = (
  model: Model,
  groupId: number,
  junction: Junction
): UpdateReturn => ({
  model: modifyFields(model, {
    root: (root) =>
      replaceNode(root, groupId, (found: FilterNode) =>
        found._tag === "Group"
          ? Group({ children: found.children, id: found.id, junction })
          : found
      ),
  }),
});

const selectTargetField = (
  model: Model,
  conditionId: number,
  maybeFieldId: Option.Option<string>,
  scope: ConditionScope
): UpdateReturn =>
  Option.match(
    Option.flatMap(findCondition(model.root, conditionId), (condition) =>
      Option.fromNullishOr(condition.path[0])
    ),
    {
      onNone: () => ({ model }),
      onSome: (referenceId) =>
        selectField(
          model,
          conditionId,
          [referenceId, ...Option.toArray(maybeFieldId)],
          scope
        ),
    }
  );

/**
 * The builder's update. It needs the tables the page holds, to know each
 * field's type, choices and reference target.
 *
 * @param model - The builder.
 * @param message - What happened.
 * @param scope - The tables the browser holds.
 * @returns The next builder, its Commands, and what the page should do.
 */
export const update = (
  model: Model,
  message: Message,
  scope: ConditionScope
): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedAddCondition: ({ groupId }) => addCondition(model, groupId, scope),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedAddGroup: ({ groupId }) => addGroup(model, groupId),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedApply: () => apply(model, scope),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedClear: () => clear(model),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedRemoveNode: ({ nodeId }) => ({
      model: modifyFields(model, { root: (root) => removeNode(root, nodeId) }),
    }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    CompletedFocusProblem: () => ({ model }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    GotDatePickerMessage: ({ conditionId, message: pickerMessage }) =>
      foldDatePicker(model, conditionId, pickerMessage),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SelectedChoice: ({ conditionId, maybeKey }) =>
      changeOperand(model, conditionId, (operand) =>
        Operand.guards.Choice(operand) ? Operand.Choice({ maybeKey }) : operand
      ),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SelectedField: ({ conditionId, fieldId }) =>
      selectField(model, conditionId, [fieldId], scope),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SelectedJunction: ({ groupId, junction }) =>
      setJunction(model, groupId, junction),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SelectedOperator: ({ conditionId, operator }) =>
      selectOperator(model, conditionId, operator, scope),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SelectedTargetField: ({ conditionId, maybeFieldId }) =>
      selectTargetField(model, conditionId, maybeFieldId, scope),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SelectedUnit: ({ conditionId, unit }) =>
      changeOperand(model, conditionId, withUnit(unit)),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SelectedValueSource: ({ conditionId, source }) =>
      selectValueSource(model, conditionId, source, scope),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ToggledChoice: ({ conditionId, isChecked, key }) =>
      changeOperand(model, conditionId, withChoiceToggled(key, isChecked)),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ToggledFlag: ({ conditionId, isChecked }) =>
      changeOperand(model, conditionId, (operand) =>
        Operand.guards.Flag(operand) ? Operand.Flag({ isChecked }) : operand
      ),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ToggledNegation: ({ nodeId }) => negate(model, nodeId),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    UpdatedOffset: ({ conditionId, offset }) =>
      changeOperand(model, conditionId, withOffset(offset)),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    UpdatedText: ({ conditionId, text }) =>
      changeOperand(model, conditionId, withText(text)),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    UpdatedTime: ({ conditionId, time }) =>
      changeOperand(model, conditionId, withTime(time)),
  });
