// The foldkit-oxlint-scope canary (tooling/test/foldkit-lint.test.ts) lints
// this file as apps/web/src/counter.ts, where foldkit/no-switch-on-message-tag
// and foldkit/no-module-level-mutable-state must fire, and as
// packages/server/src/counter.ts, where no Foldkit rule may fire.
interface Incremented {
  readonly _tag: "Incremented";
}

interface Decremented {
  readonly _tag: "Decremented";
}

type Message = Incremented | Decremented;

let dispatched = 0;

/**
 * Labels a Message and counts the calls in module state.
 *
 * @param message - The Message to label.
 * @returns Its label.
 */
export const label = (message: Message): string => {
  dispatched += 1;

  switch (message._tag) {
    case "Incremented": {
      return `up ${dispatched}`;
    }

    case "Decremented": {
      return `down ${dispatched}`;
    }

    default: {
      return "unknown";
    }
  }
};
