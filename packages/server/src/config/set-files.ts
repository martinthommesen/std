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

const readText = (file: string): Effect.Effect<string, DefinitionInvalid> =>
  Effect.tryPromise({
    catch: () => refuse(`${file} cannot be read`),
    try: async () => await readFile(file, "utf-8"),
  });

/**
 * Parses YAML text into a JSON value.
 *
 * @param text - The file's text.
 * @returns The document, or undefined when it holds non-JSON values.
 */
const parseYaml = (text: string): JsonValue | undefined => {
  const document: unknown = parse(text, { schema: "core", uniqueKeys: true });

  if (document === null || document === undefined) {
    return {};
  }

  return isJsonValue(document) ? document : undefined;
};

const parseFile = (
  file: string,
  text: string
): Effect.Effect<NamedSetFile, DefinitionInvalid> => {
  const parsed = Result.try({
    catch: () => refuse(`${file} is not valid YAML`),
    try: () => parseYaml(text),
  });

  if (Result.isFailure(parsed)) {
    return Effect.fail(parsed.failure);
  }

  if (parsed.success === undefined) {
    return Effect.fail(refuse(`${file} holds values that are not JSON`));
  }

  const decoded = decodeSetFile(file, parsed.success);

  return Result.isSuccess(decoded)
    ? Effect.succeed(decoded.success)
    : Effect.fail(decoded.failure);
};

/**
 * Reads every set file of a directory.
 *
 * @param directory - The set's directory.
 * @returns The decoded files, sorted by name.
 */
export const readSetDirectory = (
  directory: string
): Effect.Effect<readonly NamedSetFile[], DefinitionInvalid> =>
  Effect.gen(function* readSetFiles() {
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
  });
