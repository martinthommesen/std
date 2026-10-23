import type { Expr } from "@std/conditions/ast";
import { Option, Result } from "effect";
import {
  Command,
  expectOutMessage,
  given,
  message,
  model,
  story,
} from "foldkit/story";
import { describe, expect, it } from "vitest";

import {
  ASSET_FIELDS,
  USER_FIELDS,
  assetTable,
  fixtureTables,
} from "../table-fixture.ts";
import type { ConditionScope } from "./condition.ts";
import {
  FocusProblem,
  Message,
  OutMessage,
  currentCondition,
  init,
  update,
  withToday,
} from "./filter-builder.ts";
import { Condition, Group, Negation, Operand } from "./model.ts";
import type { Model } from "./model.ts";
import { conditionsOf, findNode, replaceNode } from "./tree.ts";

const ASSETS = "acme.asset";

/** The asset table alone: reference targets not loaded yet. */
const assetsOnly: ConditionScope = {
  table: ASSETS,
  tables: new Map([[ASSETS, assetTable]]),
};

/** The asset table and the user table. */
const withUsers: ConditionScope = { table: ASSETS, tables: fixtureTables };

const updateIn =
  (scope: ConditionScope) => (builder: Model, builderMessage: Message) =>
    update(builder, builderMessage, scope);

const empty = withToday(init("filter"), { day: 22, month: 10, year: 2026 });

/** The IDs `init` and the first "Add condition" give: root 0, condition 1. */
const FIRST = 1;

const SECOND = 3;

const conditionOf = (builder: Model, scope = assetsOnly): Option.Option<Expr> =>
  Result.getOrThrowWith(
    currentCondition(builder, scope),
    (problems) => new Error(JSON.stringify(problems))
  );

/**
 * What a builder with one condition gives: the outermost group around it.
 *
 * @param atom - The condition.
 * @returns `and [atom]`.
 */
const only = (atom: Expr): Expr => ({ args: [atom], op: "and" });

const onField = (fieldId: string, conditionId = FIRST) =>
  message(Message.SelectedField({ conditionId, fieldId }));

const withOperator = (
  operator: Parameters<typeof Message.SelectedOperator>[0]["operator"],
  conditionId = FIRST
) => message(Message.SelectedOperator({ conditionId, operator }));

const typed = (text: string, conditionId = FIRST) =>
  message(Message.UpdatedText({ conditionId, text }));

const nameIsX: Expr = {
  left: { path: [ASSET_FIELDS.name] },
  op: "eq",
  right: { value: "x" },
};

const addCondition = (groupId = 0) =>
  message(Message.ClickedAddCondition({ groupId }));

describe("filter builder", () => {
  it("starts empty: applying it is no filter", () => {
    story(
      updateIn(assetsOnly),
      given(empty),
      message(Message.ClickedApply()),
      expectOutMessage(
        OutMessage.SubmittedFilter({ maybeCondition: Option.none() })
      ),
      model((builder) => {
        expect(builder.isShowingProblems).toBeFalsy();
      })
    );
  });

  it("compares text, numbers and UUIDs with typed literals in their canonical JSON", () => {
    story(
      updateIn(assetsOnly),
      given(empty),
      addCondition(),
      addCondition(),
      addCondition(),
      onField(ASSET_FIELDS.name),
      typed("  Laptop  "),
      onField(ASSET_FIELDS.sizeInches, SECOND),
      withOperator("ge", SECOND),
      typed("27", SECOND),
      onField(ASSET_FIELDS.cost, 5),
      withOperator("lt", 5),
      typed("0012.50", 5),
      model((builder) => {
        expect(conditionOf(builder)).toStrictEqual(
          Option.some({
            args: [
              {
                left: { path: [ASSET_FIELDS.name] },
                op: "eq",
                right: { value: "Laptop" },
              },
              {
                left: { path: [ASSET_FIELDS.sizeInches] },
                op: "ge",
                right: { value: 27 },
              },
              {
                left: { path: [ASSET_FIELDS.cost] },
                op: "lt",
                right: { value: "12.50" },
              },
            ],
            op: "and",
          })
        );
      })
    );
  });

  it("offers choices by label and sends their keys, one or a set", () => {
    story(
      updateIn(assetsOnly),
      given(empty),
      addCondition(),
      addCondition(),
      onField(ASSET_FIELDS.status),
      message(
        Message.SelectedChoice({
          conditionId: FIRST,
          maybeKey: Option.some("lost"),
        })
      ),
      onField(ASSET_FIELDS.status, SECOND),
      withOperator("notIn", SECOND),
      message(
        Message.ToggledChoice({
          conditionId: SECOND,
          isChecked: true,
          key: "in_use",
        })
      ),
      message(
        Message.ToggledChoice({
          conditionId: SECOND,
          isChecked: true,
          key: "scrapped",
        })
      ),
      model((builder) => {
        expect(conditionOf(builder)).toStrictEqual(
          Option.some({
            args: [
              {
                left: { path: [ASSET_FIELDS.status] },
                op: "eq",
                right: { value: "lost" },
              },
              {
                left: { path: [ASSET_FIELDS.status] },
                op: "notIn",
                right: [{ value: "in_use" }, { value: "scrapped" }],
              },
            ],
            op: "and",
          })
        );
      })
    );
  });

  it("lists values one per line for in and notIn", () => {
    story(
      updateIn(assetsOnly),
      given(empty),
      addCondition(),
      onField(ASSET_FIELDS.sizeInches),
      withOperator("in"),
      typed("24\n\n 27 \n"),
      model((builder) => {
        expect(conditionOf(builder)).toStrictEqual(
          Option.some(
            only({
              left: { path: [ASSET_FIELDS.sizeInches] },
              op: "in",
              right: [{ value: 24 }, { value: 27 }],
            })
          )
        );
      })
    );
  });

  it("tests emptiness and booleans", () => {
    story(
      updateIn(assetsOnly),
      given(empty),
      addCondition(),
      addCondition(),
      onField(ASSET_FIELDS.dockedTo),
      withOperator("empty"),
      onField(ASSET_FIELDS.active, SECOND),
      message(Message.ToggledFlag({ conditionId: SECOND, isChecked: false })),
      model((builder) => {
        expect(conditionOf(builder)).toStrictEqual(
          Option.some({
            args: [
              { arg: { path: [ASSET_FIELDS.dockedTo] }, op: "empty" },
              {
                left: { path: [ASSET_FIELDS.active] },
                op: "eq",
                right: { value: false },
              },
            ],
            op: "and",
          })
        );
      })
    );
  });

  it("matches text patterns with the needle as typed", () => {
    story(
      updateIn(assetsOnly),
      given(empty),
      addCondition(),
      onField(ASSET_FIELDS.notes),
      withOperator("notContains"),
      typed(" spare "),
      model((builder) => {
        expect(conditionOf(builder)).toStrictEqual(
          Option.some(
            only({
              left: { path: [ASSET_FIELDS.notes] },
              op: "notContains",
              right: " spare ",
            })
          )
        );
      })
    );
  });

  it("compares dates and date-times with me, now and relative values", () => {
    story(
      updateIn(assetsOnly),
      given(empty),
      addCondition(),
      addCondition(),
      addCondition(),
      onField(ASSET_FIELDS.owner),
      message(
        Message.SelectedValueSource({ conditionId: FIRST, source: "me" })
      ),
      onField(ASSET_FIELDS.purchasedOn, SECOND),
      withOperator("ge", SECOND),
      message(
        Message.SelectedValueSource({ conditionId: SECOND, source: "today" })
      ),
      message(Message.UpdatedOffset({ conditionId: SECOND, offset: "-90" })),
      onField(ASSET_FIELDS.checkedAt, 5),
      withOperator("lt", 5),
      message(
        Message.SelectedValueSource({ conditionId: 5, source: "fromNow" })
      ),
      message(Message.SelectedUnit({ conditionId: 5, unit: "minute" })),
      message(Message.UpdatedOffset({ conditionId: 5, offset: "-30" })),
      model((builder) => {
        expect(conditionOf(builder)).toStrictEqual(
          Option.some({
            args: [
              {
                left: { path: [ASSET_FIELDS.owner] },
                op: "eq",
                right: { ctx: "me" },
              },
              {
                left: { path: [ASSET_FIELDS.purchasedOn] },
                op: "ge",
                right: { offset: -90, rel: "today", unit: "day" },
              },
              {
                left: { path: [ASSET_FIELDS.checkedAt] },
                op: "lt",
                right: { offset: -30, rel: "now", unit: "minute" },
              },
            ],
            op: "and",
          })
        );
      })
    );
  });

  it("sends inPeriod with its unit and offset", () => {
    story(
      updateIn(assetsOnly),
      given(empty),
      addCondition(),
      onField(ASSET_FIELDS.checkedAt),
      withOperator("inPeriod"),
      message(Message.SelectedUnit({ conditionId: FIRST, unit: "quarter" })),
      message(Message.UpdatedOffset({ conditionId: FIRST, offset: "-1" })),
      model((builder) => {
        expect(conditionOf(builder)).toStrictEqual(
          Option.some(
            only({
              left: { path: [ASSET_FIELDS.checkedAt] },
              op: "inPeriod",
              period: { offset: -1, unit: "quarter" },
            })
          )
        );
      })
    );
  });

  it("nests groups with or and negates groups and conditions", () => {
    story(
      updateIn(assetsOnly),
      given(empty),
      addCondition(),
      message(Message.ClickedAddGroup({ groupId: 0 })),
      message(Message.ClickedAddCondition({ groupId: SECOND })),
      message(Message.SelectedJunction({ groupId: SECOND, junction: "or" })),
      message(Message.ClickedAddCondition({ groupId: SECOND })),
      message(Message.ToggledNegation({ nodeId: 7 })),
      message(Message.ToggledNegation({ nodeId: SECOND })),
      typed("x"),
      typed("x", 5),
      typed("x", 7),
      model((builder) => {
        expect(conditionOf(builder)).toStrictEqual(
          Option.some({
            args: [
              nameIsX,
              {
                arg: { args: [nameIsX, { arg: nameIsX, op: "not" }], op: "or" },
                op: "not",
              },
            ],
            op: "and",
          })
        );
      })
    );
  });

  it("asks for a reference's target table, then follows the reference one hop", () => {
    story(
      updateIn(assetsOnly),
      given(empty),
      addCondition(),
      onField(ASSET_FIELDS.owner),
      expectOutMessage(OutMessage.RequestedTable({ table: "core.user" })),
      model((builder) => {
        expect(
          conditionsOf(builder.root).map((atom) => atom.path)
        ).toStrictEqual([[ASSET_FIELDS.owner]]);
      })
    );

    story(
      updateIn(withUsers),
      given(empty),
      addCondition(),
      onField(ASSET_FIELDS.owner),
      message(
        Message.SelectedTargetField({
          conditionId: FIRST,
          maybeFieldId: Option.some(USER_FIELDS.name),
        })
      ),
      withOperator("startsWith"),
      typed("Bo"),
      model((builder) => {
        expect(conditionOf(builder, withUsers)).toStrictEqual(
          Option.some(
            only({
              left: { path: [ASSET_FIELDS.owner, USER_FIELDS.name] },
              op: "startsWith",
              right: "Bo",
            })
          )
        );
      })
    );
  });

  it("does not apply values that do not convert; it shows the problems and moves focus to the first", () => {
    story(
      updateIn(assetsOnly),
      given(empty),
      addCondition(),
      onField(ASSET_FIELDS.sizeInches),
      typed("1.5"),
      message(Message.ClickedApply()),
      Command.expectExact(
        FocusProblem({
          elementIds: ["value", "offset", "time", "field", "junction"].map(
            (part) => `filter-node-${FIRST}-${part}`
          ),
        })
      ),
      Command.resolve(FocusProblem, Message.CompletedFocusProblem()),
      model((builder) => {
        expect(builder.isShowingProblems).toBeTruthy();
      })
    );
  });

  it("removes nodes, and clearing applies no filter", () => {
    story(
      updateIn(assetsOnly),
      given(empty),
      addCondition(),
      addCondition(),
      typed("x", SECOND),
      message(Message.ClickedRemoveNode({ nodeId: FIRST })),
      model((builder) => {
        expect(conditionOf(builder)).toStrictEqual(
          Option.some({ args: [nameIsX], op: "and" })
        );
      }),
      message(Message.ClickedClear()),
      expectOutMessage(
        OutMessage.SubmittedFilter({ maybeCondition: Option.none() })
      ),
      model((builder) => {
        expect(conditionOf(builder)).toStrictEqual(Option.none());
      })
    );
  });
});

describe("filter builder: empty groups", () => {
  it("refuses to apply a group left without conditions", () => {
    const withEmptyGroup = update(
      update(empty, Message.ClickedAddCondition({ groupId: 0 }), assetsOnly)
        .model,
      Message.ClickedAddGroup({ groupId: 0 }),
      assetsOnly
    ).model;

    const typedName = update(
      withEmptyGroup,
      Message.UpdatedText({ conditionId: FIRST, text: "x" }),
      assetsOnly
    ).model;

    const applied = update(typedName, Message.ClickedApply(), assetsOnly);

    expect(applied.outMessage).toBeUndefined();
    expect(applied.model.isShowingProblems).toBeTruthy();
    expect(
      Result.isFailure(currentCondition(typedName, assetsOnly))
    ).toBeTruthy();
  });
});

describe("filter builder tree", () => {
  const first = Condition({
    id: 1,
    operand: Operand.Typed({ text: "x" }),
    operator: "eq",
    path: [ASSET_FIELDS.name],
  });

  const second = Condition({
    id: 2,
    operand: Operand.Typed({ text: "y" }),
    operator: "eq",
    path: [ASSET_FIELDS.name],
  });

  const untouched = Negation({
    child: Group({ children: [second], id: 3, junction: "or" }),
    id: 4,
  });

  const root = Group({
    children: [Negation({ child: first, id: 5 }), untouched],
    id: 0,
    junction: "and",
  });

  const replacement = Condition({
    id: 1,
    operand: Operand.Typed({ text: "z" }),
    operator: "eq",
    path: [ASSET_FIELDS.name],
  });

  it("shares untouched groups and negations when replacing a node", () => {
    const replaced = replaceNode(root, first.id, () => replacement);

    expect(replaced).not.toBe(root);
    expect(Option.getOrThrow(findNode(replaced, first.id))).toBe(replacement);
    expect(Option.getOrThrow(findNode(replaced, untouched.id))).toBe(
      Option.getOrThrow(findNode(root, untouched.id))
    );
  });

  it("returns the original tree for a no-op or an absent node", () => {
    expect(replaceNode(root, second.id, (found) => found)).toBe(root);
    expect(replaceNode(root, -1, () => replacement)).toBe(root);
    expect(findNode(root, -1)).toStrictEqual(Option.none());
  });
});
