import { Match, Option } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

/**
 * The filter builder's view: groups as fieldsets with an "all"/"any"
 * choice, conditions as fieldsets with a field, an operator and a value
 * control that fits the field's type (Foldkit UI Select for fields,
 * operators, choices and units, Input for text and numbers, Textarea for
 * lists, Checkbox for booleans, choice sets and negation, Date Picker for
 * dates). Every condition and group is a named group ("Condition 2",
 * "Group 1"), so its controls are found by role and label.
 */
import type { MetaField, MetaTable } from "../domain/metadata.ts";
import {
  checkboxField,
  buttonView,
  inputField,
  selectField,
  textareaField,
} from "../view/controls.ts";
import type { SelectOption } from "../view/controls.ts";
import { datePickerField } from "../view/date-picker.ts";
import {
  isEmptyFilter,
  isFilterable,
  problemsByCondition,
  resolvePath,
  targetOf,
} from "./condition.ts";
import type { ConditionScope } from "./condition.ts";
import { Message, nodeElementId } from "./filter-builder.ts";
import {
  FilterOperator,
  Junction,
  NowUnit,
  PeriodUnit,
  TodayUnit,
  ValueSource,
} from "./model.ts";
import type { Condition, FilterNode, Group, Model, Operand } from "./model.ts";
import {
  operatorLabel,
  operatorsFor,
  valueSourceLabel,
  valueSourceOf,
  valueSourcesFor,
} from "./operators.ts";
import { conditionsOf } from "./tree.ts";

const LEGEND_CLASS = "filter-legend";

const CONTROLS_CLASS = "filter-controls";

const NODE_ACTIONS_CLASS = "filter-node-actions";

/** What the builder's view needs from the page. */
export interface ViewInputs {
  /** The tables the page holds metadata for. */
  readonly scope: ConditionScope;
  /** Target tables whose metadata is loading. */
  readonly loadingTables: ReadonlySet<string>;
}

/** The heading's element ID. */
export const HEADING_ID_SUFFIX = "heading";

/** What the view of one node needs besides the node. */
interface NodeContext {
  readonly model: Model;
  readonly inputs: ViewInputs;
  readonly table: MetaTable;
  readonly fieldOptionsByTable: ReadonlyMap<MetaTable, readonly SelectOption[]>;
  readonly numbers: ReadonlyMap<number, number>;
  readonly problems: ReadonlyMap<number, string>;
}

const elementId = nodeElementId;

const groupsOf = (node: FilterNode): readonly Group[] => {
  if (node._tag === "Group") {
    return [node, ...node.children.flatMap(groupsOf)];
  }

  return node._tag === "Negation" ? groupsOf(node.child) : [];
};

const numbersOf = (root: FilterNode): ReadonlyMap<number, number> => {
  const groups = groupsOf(root);
  const conditions = conditionsOf(root);

  return new Map([
    ...groups.map((group, index) => [group.id, index + 1] as const),
    ...conditions.map((condition, index) => [condition.id, index + 1] as const),
  ]);
};

const nodeName = (context: NodeContext, node: FilterNode): string =>
  `${node._tag === "Group" ? "Group" : "Condition"} ${context.numbers.get(node.id) ?? ""}`;

const notView = (
  context: NodeContext,
  node: FilterNode,
  maybeNegationId: Option.Option<number>,
  h: HtmlBuilder<Message>
): Html =>
  checkboxField(
    {
      id: elementId(context.model, node.id, "not"),
      isChecked: Option.isSome(maybeNegationId),
      label: "Not",
      onToggle: () =>
        Message.ToggledNegation({
          nodeId: Option.getOrElse(maybeNegationId, () => node.id),
        }),
    },
    h
  );

const removeView = (
  context: NodeContext,
  node: FilterNode,
  removedId: number,
  h: HtmlBuilder<Message>
): Html =>
  buttonView(
    {
      maybeAriaLabel: Option.some(`Remove ${nodeName(context, node)}`),
      onClick: Message.ClickedRemoveNode({ nodeId: removedId }),
      text: "Remove",
      variant: "quiet",
    },
    h
  );

const fieldOptions = (fields: readonly MetaField[]): readonly SelectOption[] =>
  fields.map((field) => ({ label: field.label, value: field.id }));

const offeredFieldOptions = (
  context: NodeContext,
  table: MetaTable,
  selectedId: string
): readonly SelectOption[] => {
  const options = Option.getOrThrow(
    Option.fromNullishOr(context.fieldOptionsByTable.get(table))
  );

  return selectedId === "" ||
    options.some((option) => option.value === selectedId)
    ? options
    : fieldOptions(
        table.fields.filter(
          (field) => isFilterable(field) || field.id === selectedId
        )
      );
};

const fieldSelect = (
  context: NodeContext,
  condition: Condition,
  h: HtmlBuilder<Message>
): Html => {
  const [firstId = ""] = condition.path;

  return selectField(
    {
      id: elementId(context.model, condition.id, "field"),
      label: "Field",
      onChange: (fieldId) =>
        Message.SelectedField({ conditionId: condition.id, fieldId }),
      options: offeredFieldOptions(context, context.table, firstId),
      value: firstId,
    },
    h
  );
};

const THE_REFERENCE = "";

const targetSelect = (
  context: NodeContext,
  condition: Condition,
  h: HtmlBuilder<Message>
): Html => {
  const [firstId = "", secondId = THE_REFERENCE] = condition.path;
  const first = context.table.fields.find((field) => field.id === firstId);

  if (first?.type.kind !== "reference" || first.type.target === null) {
    return h.empty;
  }

  const id = elementId(context.model, condition.id, "target-field");
  const isLoading = context.inputs.loadingTables.has(first.type.target);

  return Option.match(targetOf(first, context.inputs.scope.tables), {
    onNone: () =>
      isLoading
        ? selectField(
            {
              id,
              isDisabled: true,
              label: `Field of ${first.label}`,
              onChange: () =>
                Message.SelectedTargetField({
                  conditionId: condition.id,
                  maybeFieldId: Option.none(),
                }),
              options: [{ label: "Loading…", value: THE_REFERENCE }],
              value: THE_REFERENCE,
            },
            h
          )
        : h.empty,
    onSome: (target) =>
      selectField(
        {
          id,
          label: `Field of ${first.label}`,
          onChange: (fieldId) =>
            Message.SelectedTargetField({
              conditionId: condition.id,
              maybeFieldId:
                fieldId === THE_REFERENCE
                  ? Option.none()
                  : Option.some(fieldId),
            }),
          options: [
            { label: `(the ${first.label} itself)`, value: THE_REFERENCE },
            ...offeredFieldOptions(context, target, secondId),
          ],
          value: secondId,
        },
        h
      ),
  });
};

const operatorSelect = (
  context: NodeContext,
  condition: Condition,
  field: MetaField,
  h: HtmlBuilder<Message>
): Html =>
  selectField(
    {
      id: elementId(context.model, condition.id, "operator"),
      label: "Operator",
      onChange: (value) => {
        const operator = FilterOperator.literals.find(
          (candidate) => candidate === value
        );

        return Message.SelectedOperator({
          conditionId: condition.id,
          operator: operator ?? condition.operator,
        });
      },
      options: operatorsFor(field.type.kind).map((operator) => ({
        label: operatorLabel(operator, field.type.kind),
        value: operator,
      })),
      value: condition.operator,
    },
    h
  );

const sourceSelect = (
  context: NodeContext,
  condition: Condition,
  field: MetaField,
  h: HtmlBuilder<Message>
): Html => {
  const sources = valueSourcesFor(field);

  return sources.length < 2
    ? h.empty
    : selectField(
        {
          id: elementId(context.model, condition.id, "source"),
          label: "Compare with",
          onChange: (value) =>
            Message.SelectedValueSource({
              conditionId: condition.id,
              source:
                ValueSource.literals.find((source) => source === value) ??
                "value",
            }),
          options: sources.map((source) => ({
            label: valueSourceLabel(source),
            value: source,
          })),
          value: valueSourceOf(condition.operand),
        },
        h
      );
};

const unitSelect = (
  context: NodeContext,
  condition: Condition,
  units: readonly string[],
  value: string,
  h: HtmlBuilder<Message>
): Html =>
  selectField(
    {
      id: elementId(context.model, condition.id, "unit"),
      label: "Unit",
      onChange: (unit) =>
        Message.SelectedUnit({ conditionId: condition.id, unit }),
      options: units.map((unit) => ({ label: `${unit}s`, value: unit })),
      value,
    },
    h
  );

const maybeProblemOf = (
  context: NodeContext,
  node: FilterNode
): Option.Option<string> =>
  context.model.isShowingProblems
    ? Option.fromNullishOr(context.problems.get(node.id))
    : Option.none();

/**
 * Whether a condition's typed value shows a problem: its value control
 * then carries `aria-invalid`, so focus moved to it after "Apply" says so
 * (the problem itself describes the condition's fieldset).
 *
 * @param context - The view's context.
 * @param condition - The condition.
 * @returns True when its problem shows.
 */
const isConditionInvalid = (
  context: NodeContext,
  condition: Condition
): boolean => Option.isSome(maybeProblemOf(context, condition));

const offsetInput = (
  context: NodeContext,
  condition: Condition,
  offset: string,
  hint: string,
  h: HtmlBuilder<Message>
): Html =>
  inputField(
    {
      id: elementId(context.model, condition.id, "offset"),
      isInvalid: isConditionInvalid(context, condition),
      label: "Offset",
      maybeDescription: Option.some(hint),
      onInput: (value) =>
        Message.UpdatedOffset({ conditionId: condition.id, offset: value }),
      type: "number",
      value: offset,
    },
    h
  );

const choiceOptions = (field: MetaField): readonly SelectOption[] =>
  (field.choices ?? []).map((choice) => ({
    label: choice.retired ? `${choice.label} (hidden)` : choice.label,
    value: choice.key,
  }));

const VALUE_HINTS: Partial<Record<MetaField["type"]["kind"], string>> = {
  bigInteger: "A whole number.",
  decimal: "A number such as 12.50.",
  integer: "A whole number.",
  reference: "The record's ID.",
  uuid: "A UUID.",
};

const typedValue = (
  context: NodeContext,
  condition: Condition,
  field: MetaField,
  text: string,
  h: HtmlBuilder<Message>
): Html =>
  inputField(
    {
      id: elementId(context.model, condition.id, "value"),
      isInvalid: isConditionInvalid(context, condition),
      label: "Value",
      maybeDescription: Option.fromNullishOr(VALUE_HINTS[field.type.kind]),
      onInput: (value) =>
        Message.UpdatedText({ conditionId: condition.id, text: value }),
      value: text,
    },
    h
  );

const datePicker = (
  condition: Condition,
  operand: Extract<Operand, { readonly _tag: "Day" | "Instant" }>,
  h: HtmlBuilder<Message>
): Html =>
  datePickerField(
    {
      label: "Date",
      maybeSelectedDate: operand.maybeDate,
      model: operand.picker,
      toParentMessage: (message) =>
        Message.GotDatePickerMessage({ conditionId: condition.id, message }),
    },
    h
  );

const choiceSetView = (
  context: NodeContext,
  condition: Condition,
  field: MetaField,
  chosen: ReadonlySet<string>,
  h: HtmlBuilder<Message>
): Html =>
  h.fieldset(
    [h.Class("choice-set")],
    [
      h.legend([h.Class("control-label")], ["Values"]),
      ...choiceOptions(field).map((option) =>
        h.keyed("div")(
          option.value,
          [],
          [
            checkboxField(
              {
                id: elementId(
                  context.model,
                  condition.id,
                  `choice-${option.value}`
                ),
                isChecked: chosen.has(option.value),
                label: option.label,
                onToggle: (isChecked) =>
                  Message.ToggledChoice({
                    conditionId: condition.id,
                    isChecked,
                    key: option.value,
                  }),
              },
              h
            ),
          ]
        )
      ),
    ]
  );

const operandView = (
  context: NodeContext,
  condition: Condition,
  field: MetaField,
  h: HtmlBuilder<Message>
): readonly Html[] =>
  Match.value(condition.operand).pipe(
    Match.withReturnType<readonly Html[]>(),
    Match.tag("Choice", ({ maybeKey }) => [
      selectField(
        {
          id: elementId(context.model, condition.id, "value"),
          label: "Value",
          onChange: (key) =>
            Message.SelectedChoice({
              conditionId: condition.id,
              maybeKey: key === "" ? Option.none() : Option.some(key),
            }),
          options: [{ label: "Choose…", value: "" }, ...choiceOptions(field)],
          value: Option.getOrElse(maybeKey, () => ""),
        },
        h
      ),
    ]),
    Match.tag("ChoiceSet", ({ keys }) => [
      choiceSetView(context, condition, field, new Set(keys), h),
    ]),
    Match.tag("Day", (day) => [datePicker(condition, day, h)]),
    Match.tag("Flag", ({ isChecked }) => [
      checkboxField(
        {
          id: elementId(context.model, condition.id, "value"),
          isChecked,
          label: "True",
          onToggle: (checked) =>
            Message.ToggledFlag({
              conditionId: condition.id,
              isChecked: checked,
            }),
        },
        h
      ),
    ]),
    Match.tag("FromNow", ({ offset, unit }) => [
      offsetInput(
        context,
        condition,
        offset,
        "From now: -1 is one unit ago.",
        h
      ),
      unitSelect(context, condition, NowUnit.literals, unit, h),
    ]),
    Match.tag("Instant", (instant) => [
      datePicker(condition, instant, h),
      inputField(
        {
          id: elementId(context.model, condition.id, "time"),
          isInvalid: isConditionInvalid(context, condition),
          label: "Time (UTC)",
          maybeDescription: Option.some("HH:MM, in UTC."),
          onInput: (time) =>
            Message.UpdatedTime({ conditionId: condition.id, time }),
          value: instant.time,
        },
        h
      ),
    ]),
    Match.tag("Lines", ({ text }) => [
      textareaField(
        {
          id: elementId(context.model, condition.id, "value"),
          isInvalid: isConditionInvalid(context, condition),
          label: "Values",
          maybeDescription: Option.some("One value per line."),
          onInput: (value) =>
            Message.UpdatedText({ conditionId: condition.id, text: value }),
          value: text,
        },
        h
      ),
    ]),
    Match.tag("Me", () => []),
    Match.tag("NoValue", () => []),
    Match.tag("Now", () => []),
    Match.tag("Period", ({ offset, unit }) => [
      offsetInput(
        context,
        condition,
        offset,
        "0 is the current period, -1 the previous one.",
        h
      ),
      unitSelect(context, condition, PeriodUnit.literals, unit, h),
    ]),
    Match.tag("Today", ({ offset, unit }) => [
      offsetInput(
        context,
        condition,
        offset,
        "From today: -1 is one unit ago.",
        h
      ),
      unitSelect(context, condition, TodayUnit.literals, unit, h),
    ]),
    Match.tag("Typed", ({ text }) => [
      typedValue(context, condition, field, text, h),
    ]),
    Match.exhaustive
  );

/**
 * The attributes that tie a node's fieldset to its problem, when shown.
 *
 * @param context - The view's context.
 * @param node - The condition or group.
 * @param h - The builder.
 * @returns `aria-describedby`, or nothing.
 */
const problemAttributes = (
  context: NodeContext,
  node: FilterNode,
  h: HtmlBuilder<Message>
) =>
  Option.match(maybeProblemOf(context, node), {
    onNone: () => [],
    onSome: () => [
      h.AriaDescribedBy(elementId(context.model, node.id, "problem")),
    ],
  });

const problemView = (
  context: NodeContext,
  node: FilterNode,
  h: HtmlBuilder<Message>
): Html =>
  // NOTE: the live region stays mounted, so a problem that appears in it is
  // announced.
  h.div(
    [h.AriaLive("polite")],
    [
      Option.match(maybeProblemOf(context, node), {
        onNone: () => h.empty,
        onSome: (problem) =>
          h.p(
            [
              h.Id(elementId(context.model, node.id, "problem")),
              h.Class("field-error"),
            ],
            [problem]
          ),
      }),
    ]
  );

const WITHOUT_SOURCE: ReadonlySet<Operand["_tag"]> = new Set([
  "NoValue",
  "Period",
  "Lines",
  "ChoiceSet",
]);

const takesValueSource = (operand: Operand): boolean =>
  !WITHOUT_SOURCE.has(operand._tag);

const conditionView = (
  context: NodeContext,
  condition: Condition,
  maybeNegationId: Option.Option<number>,
  h: HtmlBuilder<Message>
): Html => {
  const legendId = elementId(context.model, condition.id, "legend");

  const controls = Option.match(
    resolvePath(condition.path, context.inputs.scope),
    {
      onNone: () => [fieldSelect(context, condition, h)],
      onSome: (field) => [
        fieldSelect(context, condition, h),
        targetSelect(context, condition, h),
        operatorSelect(context, condition, field, h),
        ...(takesValueSource(condition.operand)
          ? [sourceSelect(context, condition, field, h)]
          : []),
        ...operandView(context, condition, field, h),
      ],
    }
  );

  return h.fieldset(
    [
      h.Class("filter-condition"),
      h.AriaLabelledBy(legendId),
      ...problemAttributes(context, condition, h),
    ],
    [
      h.legend(
        [h.Id(legendId), h.Class(LEGEND_CLASS)],
        [nodeName(context, condition)]
      ),
      h.div([h.Class(CONTROLS_CLASS)], controls),
      h.div(
        [h.Class(NODE_ACTIONS_CLASS)],
        [
          notView(context, condition, maybeNegationId, h),
          removeView(
            context,
            condition,
            Option.getOrElse(maybeNegationId, () => condition.id),
            h
          ),
        ]
      ),
      problemView(context, condition, h),
    ]
  );
};

const junctionSelect = (
  context: NodeContext,
  group: Group,
  h: HtmlBuilder<Message>
): Html =>
  selectField(
    {
      id: elementId(context.model, group.id, "junction"),
      label: "Match",
      onChange: (value) =>
        Message.SelectedJunction({
          groupId: group.id,
          junction:
            Junction.literals.find((junction) => junction === value) ??
            group.junction,
        }),
      options: [
        { label: "all of these", value: "and" },
        { label: "any of these", value: "or" },
      ],
      value: group.junction,
    },
    h
  );

const addButtons = (
  context: NodeContext,
  groupId: number,
  h: HtmlBuilder<Message>
): readonly Html[] => [
  buttonView(
    {
      maybeAriaLabel:
        groupId === context.model.root.id
          ? Option.none()
          : Option.some(
              `Add condition to Group ${context.numbers.get(groupId) ?? ""}`
            ),
      onClick: Message.ClickedAddCondition({ groupId }),
      text: "Add condition",
      variant: "quiet",
    },
    h
  ),
  buttonView(
    {
      maybeAriaLabel:
        groupId === context.model.root.id
          ? Option.none()
          : Option.some(
              `Add group to Group ${context.numbers.get(groupId) ?? ""}`
            ),
      onClick: Message.ClickedAddGroup({ groupId }),
      text: "Add group",
      variant: "quiet",
    },
    h
  ),
];

const groupView = (
  context: NodeContext,
  group: Group,
  maybeNegationId: Option.Option<number>,
  h: HtmlBuilder<Message>
): Html => {
  const legendId = elementId(context.model, group.id, "legend");
  const isRoot = group.id === context.model.root.id;

  return h.fieldset(
    [
      h.Class("filter-group"),
      h.AriaLabelledBy(legendId),
      ...problemAttributes(context, group, h),
    ],
    [
      h.legend(
        [h.Id(legendId), h.Class(LEGEND_CLASS)],
        [nodeName(context, group)]
      ),
      h.div(
        [h.Class(CONTROLS_CLASS)],
        [
          junctionSelect(context, group, h),
          notView(context, group, maybeNegationId, h),
          ...(isRoot
            ? []
            : [
                removeView(
                  context,
                  group,
                  Option.getOrElse(maybeNegationId, () => group.id),
                  h
                ),
              ]),
        ]
      ),
      h.ul(
        [h.Class("filter-children")],
        group.children.map((child) =>
          h.keyed("li")(
            String(child.id),
            [],
            [
              // oxlint-disable-next-line no-use-before-define -- groups and nodes render each other recursively
              nodeView(context, child, Option.none(), h),
            ]
          )
        )
      ),
      h.div([h.Class(NODE_ACTIONS_CLASS)], addButtons(context, group.id, h)),
      problemView(context, group, h),
    ]
  );
};

const nodeView = (
  context: NodeContext,
  node: FilterNode,
  maybeNegationId: Option.Option<number>,
  h: HtmlBuilder<Message>
): Html => {
  if (node._tag === "Group") {
    return groupView(context, node, maybeNegationId, h);
  }

  if (node._tag === "Condition") {
    return conditionView(context, node, maybeNegationId, h);
  }

  return Option.isSome(maybeNegationId)
    ? h.div(
        [h.Class("filter-negation")],
        [
          h.p([h.Class(LEGEND_CLASS)], ["Not:"]),
          nodeView(context, node.child, Option.some(node.id), h),
        ]
      )
    : nodeView(context, node.child, Option.some(node.id), h);
};

/**
 * The filter builder.
 *
 * @param model - The builder.
 * @param inputs - The page's tables and the ones loading.
 * @param h - The builder's Html builder.
 * @returns The builder's section.
 */
export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, inputs, h) => {
    const headingId = `${model.id}-${HEADING_ID_SUFFIX}`;

    return Option.match(
      Option.fromNullishOr(inputs.scope.tables.get(inputs.scope.table)),
      {
        onNone: () => h.empty,
        onSome: (table) => {
          const context: NodeContext = {
            fieldOptionsByTable: new Map(
              Array.from(inputs.scope.tables.values(), (scopeTable) => [
                scopeTable,
                fieldOptions(scopeTable.fields.filter(isFilterable)),
              ])
            ),
            inputs,
            model,
            numbers: numbersOf(model.root),
            problems: model.isShowingProblems
              ? problemsByCondition(model.root, inputs.scope)
              : new Map(),
            table,
          };

          return h.section(
            [h.Class("panel filter-builder"), h.AriaLabelledBy(headingId)],
            [
              h.h2([h.Id(headingId)], ["Filter"]),
              isEmptyFilter(model.root)
                ? h.p(
                    [h.Class("placeholder")],
                    ["No conditions: every record is listed."]
                  )
                : nodeView(context, model.root, Option.none(), h),
              h.div(
                [h.Class("filter-actions")],
                [
                  ...(model.root._tag === "Group" && !isEmptyFilter(model.root)
                    ? []
                    : addButtons(context, model.root.id, h)),
                  buttonView(
                    {
                      onClick: Message.ClickedApply(),
                      text: "Apply filter",
                      variant: "primary",
                    },
                    h
                  ),
                  buttonView(
                    {
                      onClick: Message.ClickedClear(),
                      text: "Clear filter",
                      variant: "quiet",
                    },
                    h
                  ),
                ]
              ),
            ]
          );
        },
      }
    );
  }
);
