/**
 * Reading a definition set from disk: every `.yaml` or `.yml` file of a
 * directory (not recursive), parsed as YAML 1.2 core schema and decoded
 * with the set file schema. Any unreadable or invalid file refuses the set.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { DefinitionInvalid, problem } from "@std/definitions/problems";
import type { NamedSetFile } from "@std/definitions/set-file";
import { decodeSetFile } from "@std/definitions/set-resolve";
import { isJsonValue } from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Result } from "effect";
import { parse } from "yaml";

const SET_FILE = /\.ya?ml$/u;

/** The `core` definition set shipped with the server. */
export const CORE_SET_DIRECTORY = new URL(
  "../../definitions/core",
  import.meta.url
).pathname;

const refuse = (message: string): DefinitionInvalid =>
  new DefinitionInvalid({ problems: [problem("invalidName", null, message)] });

const readText = Effect.fn("Config.readSetFileText")(function* readText(
  file: string
): Effect.fn.Return<string, DefinitionInvalid> {
  return yield* Effect.tryPromise({
    catch: () => refuse(`${file} cannot be read`),
    try: async () => await readFile(file, "utf-8"),
  });
});

/**
 * Parses YAML text (1.2 core schema, unique keys) into a JSON value.
 *
 * @param text - The file's text.
 * @returns The document (an empty file is `{}`), or undefined when it holds
 *   values that are not JSON.
 */
const parseYaml = (text: string): JsonValue | undefined => {
  const document: unknown = parse(text, { schema: "core", uniqueKeys: true });

  if (document === null || document === undefined) {
    return {};
  }

  return isJsonValue(document) ? document : undefined;
};

/**
 * Parses and decodes one set file at the server's YAML boundary. Unknown
 * keys are refused, so a typo cannot be ignored silently.
 *
 * @param file - The file's name, for messages.
 * @param text - The file's text.
 * @returns The decoded file, or a `DefinitionInvalid` naming the file.
 */
const parseFile = Effect.fn("Config.parseSetFile")(function* parseFile(
  file: string,
  text: string
): Effect.fn.Return<NamedSetFile, DefinitionInvalid> {
  const document = yield* Effect.try({
    catch: () => refuse(`${file} is not valid YAML`),
    try: () => parseYaml(text),
  });

  if (document === undefined) {
    return yield* refuse(`${file} holds values that are not JSON`);
  }

  const decoded = decodeSetFile(file, document);

  if (Result.isFailure(decoded)) {
    return yield* decoded.failure;
  }

  return decoded.success;
});

/**
 * Reads every set file of a directory.
 *
 * @param directory - The set's directory.
 * @returns The decoded files, sorted by name.
 */
export const readSetDirectory = Effect.fn("Config.readSetDirectory")(
  function* readSetDirectory(
    directory: string
  ): Effect.fn.Return<readonly NamedSetFile[], DefinitionInvalid> {
    const entries = yield* Effect.tryPromise({
      catch: () => refuse(`${directory} cannot be read`),
      try: async () => await readdir(directory),
    });

    const names = entries.filter((name) => SET_FILE.test(name)).toSorted();
    const files: NamedSetFile[] = [];

    for (const name of names) {
      const text = yield* readText(path.join(directory, name));

      files.push(yield* parseFile(name, text));
    }

    return files;
  }
);
