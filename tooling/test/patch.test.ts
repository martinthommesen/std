import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CommandResult } from "../lib/run.ts";
import { repoRoot } from "../lib/workspace.ts";
import { runBin } from "./run-tools.ts";

// pnpm hard-links package files from its content-addressed store
// (`<store>/files/<2 hex>/<rest of sha512>[-exec]`), so a patch that wrote
// into a linked file would change the store copy every project shares.
// Contracts 9, "Patch and pnpm".
const ModulesYaml = Schema.fromJsonString(
  Schema.Struct({ storeDir: Schema.String })
);

const { storeDir } = Schema.decodeSync(ModulesYaml)(
  readFileSync(path.join(repoRoot, "node_modules", ".modules.yaml"), "utf-8")
);

const nativePackage = `@typescript/typescript-${process.platform}-${process.arch}`;

const libDir = path.join(
  path.dirname(
    createRequire(
      path.join(repoRoot, "node_modules", "typescript", "package.json")
    ).resolve(`${nativePackage}/package.json`)
  ),
  "lib"
);

const tsc = path.join(libDir, "tsc");

const sha512 = (file: string): string =>
  createHash("sha512").update(readFileSync(file)).digest("hex");

// The store file that holds this content, if the store has it.
const storeFileFor = (hash: string): string | undefined =>
  [
    path.join(storeDir, "files", hash.slice(0, 2), hash.slice(2)),
    path.join(storeDir, "files", hash.slice(0, 2), `${hash.slice(2)}-exec`),
  ].find((candidate) => existsSync(candidate));

/** What the test observes around one unpatch-and-patch cycle. */
interface Observed {
  readonly before: {
    readonly hash: string;
    readonly ino: number;
    readonly nlink: number;
  };
  readonly patch: CommandResult;
  readonly after: {
    readonly hash: string;
    readonly ino: number;
    readonly nlink: number;
  };
  readonly store: { readonly file: string; readonly ino: number } | undefined;
  readonly storeAfter:
    | { readonly hash: string; readonly ino: number }
    | undefined;
  readonly movedAsideHash: string;
}

const fileFacts = (file: string) => ({
  hash: sha512(file),
  ino: statSync(file).ino,
  nlink: statSync(file).nlink,
});

describe("effect-tsgo-patch-and-pnpm", () => {
  let observed: Observed | undefined;

  beforeAll(async () => {
    const unpatch = await runBin("effect-tsgo", ["unpatch"]);

    if (unpatch.code !== 0) {
      throw new Error(`effect-tsgo unpatch failed:\n${unpatch.output}`);
    }

    const before = fileFacts(tsc);
    const storeFile = storeFileFor(before.hash);

    const store =
      storeFile === undefined
        ? undefined
        : { file: storeFile, ino: statSync(storeFile).ino };

    const patch = await runBin("effect-tsgo", ["patch"]);

    observed = {
      after: fileFacts(tsc),
      before,
      movedAsideHash: sha512(path.join(libDir, "tsc.original")),
      patch,
      store,
      storeAfter:
        store === undefined
          ? undefined
          : { hash: sha512(store.file), ino: statSync(store.file).ino },
    };
  });

  afterAll(async () => {
    // Leave the compiler patched whatever happened above.
    await runBin("effect-tsgo", ["patch"]);
  });

  it("starts from the store's own copy of the compiler", () => {
    const facts = observed;
    // A hard-linked file (the usual pnpm import) must be the store's inode;
    // a copied one (nlink 1) shares nothing with the store.
    const sharedWithStore = (facts?.before.nlink ?? 1) > 1;

    expect(facts?.store).toBeDefined();
    expect(sharedWithStore ? facts?.before.ino : facts?.store?.ino).toBe(
      facts?.store?.ino
    );
  });

  it("writes the patched compiler as a new, unshared file", () => {
    const facts = observed;

    expect(facts?.patch.code).toBe(0);
    expect(facts?.patch.output).toContain("Patched typescript");
    expect(facts?.after.nlink).toBe(1);
    expect(facts?.after.ino).not.toBe(facts?.store?.ino);
    expect(facts?.after.hash).not.toBe(facts?.before.hash);
  });

  it("leaves the store copy unchanged", () => {
    const facts = observed;

    expect(facts?.storeAfter).toStrictEqual({
      hash: facts?.before.hash,
      ino: facts?.store?.ino,
    });
    expect(facts?.movedAsideHash).toBe(facts?.before.hash);
  });

  it("keeps every other hard-linked file equal to its store content", () => {
    const unknownContent = readdirSync(libDir)
      .map((name) => path.join(libDir, name))
      .filter((file) => file !== tsc && statSync(file).nlink > 1)
      .filter((file) => storeFileFor(sha512(file)) === undefined);

    expect(unknownContent).toStrictEqual([]);
  });
});
