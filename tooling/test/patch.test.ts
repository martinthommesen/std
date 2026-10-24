import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CommandResult } from "../lib/run.ts";
import { runCommand } from "../lib/run.ts";
import { repoRoot } from "../lib/workspace.ts";

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

const nativeDir = path.dirname(
  createRequire(
    path.join(repoRoot, "node_modules", "typescript", "package.json")
  ).resolve(`${nativePackage}/package.json`)
);

const libDir = path.join(nativeDir, "lib");

const sha512 = (file: string): string =>
  createHash("sha512").update(readFileSync(file)).digest("hex");

// The store file that holds this content, if the store has it.
const storeFileFor = (hash: string): string | undefined =>
  [
    path.join(storeDir, "files", hash.slice(0, 2), hash.slice(2)),
    path.join(storeDir, "files", hash.slice(0, 2), `${hash.slice(2)}-exec`),
  ].find((candidate) => existsSync(candidate));

/** Inode, link count and content hash of one file. */
interface FileFacts {
  readonly hash: string;
  readonly ino: number;
  readonly nlink: number;
}

const factsOf = (file: string): FileFacts => {
  const stats = statSync(file);

  return { hash: sha512(file), ino: stats.ino, nlink: stats.nlink };
};

/** What the isolated fixture shows around one real `effect-tsgo patch`. */
interface Observed {
  readonly after: FileFacts;
  readonly before: Pick<FileFacts, "ino">;
  readonly fixtureTsc: string;
  readonly movedAside: Pick<FileFacts, "ino">;
  readonly patch: CommandResult;
  readonly storeAfter: FileFacts;
  readonly storeBefore: FileFacts;
}

// A fixture project whose compiler is a hard link to a sentinel "store" file,
// exactly like a pnpm install, patched by the real effect-tsgo.
const patchFixture = async (temporary: string): Promise<Observed> => {
  const store = path.join(temporary, "store", "tsc");
  const project = path.join(temporary, "project");
  const fixtureNative = path.join(project, "node_modules", nativePackage);
  const fixtureTsc = path.join(fixtureNative, "lib", "tsc");
  const original = path.join(libDir, "tsc.original");

  mkdirSync(path.dirname(store), { recursive: true });
  mkdirSync(path.dirname(fixtureTsc), { recursive: true });
  mkdirSync(path.join(project, "node_modules", "typescript"), {
    recursive: true,
  });
  copyFileSync(
    existsSync(original) ? original : path.join(libDir, "tsc"),
    store
  );
  linkSync(store, fixtureTsc);
  copyFileSync(
    path.join(nativeDir, "package.json"),
    path.join(fixtureNative, "package.json")
  );
  copyFileSync(
    path.join(repoRoot, "node_modules", "typescript", "package.json"),
    path.join(project, "node_modules", "typescript", "package.json")
  );
  writeFileSync(
    path.join(project, "package.json"),
    '{ "name": "patch-fixture", "private": true }\n'
  );

  const storeBefore = factsOf(store);
  const before = statSync(fixtureTsc);

  const patch = await runCommand(
    path.join(repoRoot, "node_modules", ".bin", "effect-tsgo"),
    ["patch"],
    { cwd: project }
  );

  return {
    after: factsOf(fixtureTsc),
    before,
    fixtureTsc,
    movedAside: statSync(path.join(fixtureNative, "lib", "tsc.original")),
    patch,
    storeAfter: factsOf(store),
    storeBefore,
  };
};

describe("effect-tsgo-patch-and-pnpm", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "std-patch-canary-"));
  let observed: Observed | undefined;

  beforeAll(async () => {
    observed = await patchFixture(temporary);
  });

  afterAll(() => {
    rmSync(temporary, { force: true, recursive: true });
  });

  it("starts from a compiler hard-linked to the store file", () => {
    expect(observed?.before.ino).toBe(observed?.storeBefore.ino);
    expect(observed?.storeBefore.nlink).toBe(2);
  });

  it("patches the fixture's compiler", () => {
    expect(observed?.patch.code).toBe(0);
    expect(observed?.patch.output).toContain(
      `Patched typescript at ${observed?.fixtureTsc ?? ""}`
    );
  });

  it("writes the patched compiler as a new, unshared file", () => {
    expect(observed?.after.nlink).toBe(1);
    expect(observed?.after.ino).not.toBe(observed?.storeBefore.ino);
    expect(observed?.after.hash).not.toBe(observed?.storeBefore.hash);
  });

  it("leaves the store file's content and inode unchanged", () => {
    expect(observed?.storeAfter).toStrictEqual(observed?.storeBefore);
    expect(observed?.movedAside.ino).toBe(observed?.storeBefore.ino);
  });

  it("keeps every hard-linked file of the real install equal to its store content", () => {
    const unknownContent = readdirSync(libDir)
      .map((name) => path.join(libDir, name))
      .filter((file) => statSync(file).nlink > 1)
      .filter((file) => storeFileFor(sha512(file)) === undefined);

    expect(unknownContent).toStrictEqual([]);
    expect(statSync(path.join(libDir, "tsc")).nlink).toBe(1);
  });
});
