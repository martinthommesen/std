/**
 * Operations on the builder's tree, by node ID. Every operation returns a
 * new tree; nodes it does not touch are shared.
 */
import { Option } from "effect";

import { Group, Negation } from "./model.ts";
import type { Condition, FilterNode } from "./model.ts";

/**
 * The empty filter: `and []`.
 *
 * @param id - The group's node ID.
 * @returns The group.
 */
export const emptyRoot = (id: number): FilterNode =>
  Group({ children: [], id, junction: "and" });

/**
 * Replaces the node with an ID.
 *
 * @param node - The tree.
 * @param id - The node's ID.
 * @param replace - Its replacement, given the node.
 * @returns The new tree.
 */
export const replaceNode = (
  node: FilterNode,
  id: number,
  replace: (found: FilterNode) => FilterNode
): FilterNode => {
  if (node.id === id) {
    return replace(node);
  }

  if (node._tag === "Group") {
    return Group({
      children: node.children.map((child) => replaceNode(child, id, replace)),
      id: node.id,
      junction: node.junction,
    });
  }

  return node._tag === "Negation"
    ? Negation({ child: replaceNode(node.child, id, replace), id: node.id })
    : node;
};

/**
 * Replaces a condition, leaving the tree as is when the ID names another
 * kind of node.
 *
 * @param node - The tree.
 * @param id - The condition's ID.
 * @param replace - Its replacement, given the condition.
 * @returns The new tree.
 */
export const replaceCondition = (
  node: FilterNode,
  id: number,
  replace: (found: Condition) => Condition
): FilterNode =>
  replaceNode(node, id, (found) =>
    found._tag === "Condition" ? replace(found) : found
  );

/**
 * The node with an ID.
 *
 * @param node - The tree.
 * @param id - The node's ID.
 * @returns The node, if the tree has it.
 */
export const findNode = (
  node: FilterNode,
  id: number
): Option.Option<FilterNode> => {
  if (node.id === id) {
    return Option.some(node);
  }

  if (node._tag === "Group") {
    return Option.firstSomeOf(
      node.children.map((child) => findNode(child, id))
    );
  }

  return node._tag === "Negation" ? findNode(node.child, id) : Option.none();
};

/**
 * The condition with an ID.
 *
 * @param node - The tree.
 * @param id - The condition's ID.
 * @returns The condition, if the tree has one with that ID.
 */
export const findCondition = (
  node: FilterNode,
  id: number
): Option.Option<Condition> =>
  Option.filter(
    findNode(node, id),
    (found): found is Condition => found._tag === "Condition"
  );

const removeFrom = (
  node: FilterNode,
  id: number
): Option.Option<FilterNode> => {
  if (node.id === id) {
    return Option.none();
  }

  if (node._tag === "Group") {
    return Option.some(
      Group({
        children: node.children.flatMap((child) =>
          Option.toArray(removeFrom(child, id))
        ),
        id: node.id,
        junction: node.junction,
      })
    );
  }

  return node._tag === "Negation"
    ? Option.map(removeFrom(node.child, id), (child) =>
        Negation({ child, id: node.id })
      )
    : Option.some(node);
};

/**
 * Removes a node, and the `not` around it if any. Removing the root leaves
 * the empty filter.
 *
 * @param root - The tree.
 * @param id - The node's ID.
 * @returns The new tree.
 */
export const removeNode = (root: FilterNode, id: number): FilterNode =>
  Option.getOrElse(removeFrom(root, id), () => emptyRoot(root.id));

/**
 * Adds a node at the end of a group. When the ID names the root and the
 * root is not a group (a loaded condition), the root becomes the first
 * child of a new `and` group with the given ID.
 *
 * @param root - The tree.
 * @param groupId - The group's ID.
 * @param added - The new node.
 * @param wrapperId - The ID of a wrapping group, if one is needed.
 * @returns The new tree.
 */
export const appendTo = (
  root: FilterNode,
  groupId: number,
  added: FilterNode,
  wrapperId: number
): FilterNode => {
  if (root.id === groupId && root._tag !== "Group") {
    return Group({ children: [root, added], id: wrapperId, junction: "and" });
  }

  return replaceNode(root, groupId, (found) =>
    found._tag === "Group"
      ? Group({
          children: [...found.children, added],
          id: found.id,
          junction: found.junction,
        })
      : found
  );
};

/**
 * Puts `not` around a node, or takes away the `not` with that ID.
 *
 * @param root - The tree.
 * @param id - The node to negate, or the negation to remove.
 * @param negationId - The ID of a new negation.
 * @returns The new tree.
 */
export const toggleNegation = (
  root: FilterNode,
  id: number,
  negationId: number
): FilterNode =>
  replaceNode(root, id, (found) =>
    found._tag === "Negation"
      ? found.child
      : Negation({ child: found, id: negationId })
  );

/**
 * The conditions of a tree in reading order, for numbering them.
 *
 * @param node - The tree.
 * @returns The conditions.
 */
export const conditionsOf = (node: FilterNode): readonly Condition[] => {
  if (node._tag === "Group") {
    return node.children.flatMap(conditionsOf);
  }

  return node._tag === "Negation" ? conditionsOf(node.child) : [node];
};
