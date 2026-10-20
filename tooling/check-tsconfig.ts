/**
 * Verifies that every workspace package's `tsconfig.json` carries exactly the
 * `@effect/language-service` plugin entry of the profile declared in its
 * `package.json`, and that the copy-paste templates in `tooling/tsconfig/`
 * still match the profiles.
 *
 * Usage: `node tooling/check-tsconfig.ts [package-dir ...]`. Without
 * arguments it checks the whole workspace and the templates.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { Schema } from "effect";

import type { ProfileName } from "./lib/profiles.ts";
import { pluginEntryFor, profileNames } from "./lib/profiles.ts";
import { report, runCheck } from "./lib/report.ts";
import type { WorkspacePackage } from "./lib/workspace.ts";
import {
  listWorkspacePackages,
  packagesFromArgs,
  repoRoot,
} from "./lib/workspace.ts";

const checkName = "check-tsconfig";

/** The part of a tsconfig this check compares. Comments are not allowed. */
const TsConfig = Schema.fromJsonString(
  Schema.Struct({
    compilerOptions: Schema.optionalKey(
      Schema.Struct({ plugins: Schema.optionalKey(Schema.Unknown) })
    ),
  })
);

const decodeTsConfig = Schema.decodeUnknownSync(TsConfig);

const checkFile = (
  file: string,
  label: string,
  profile: ProfileName
): string[] => {
  if (!existsSync(file)) {
    return [`${label}: missing`];
  }

  let plugins: unknown;

  try {
    plugins = decodeTsConfig(readFileSync(file, "utf-8")).compilerOptions
      ?.plugins;
  } catch (error) {
    return [`${label}: not a plain JSON tsconfig (${String(error)})`];
  }

  const expected = [pluginEntryFor(profile)];

  if (isDeepStrictEqual(plugins, expected)) {
    return [];
  }

  return [
    `${label}: compilerOptions.plugins does not match the "${profile}" profile. Expected exactly:\n${JSON.stringify(expected, null, 2)}`,
  ];
};

const checkPackage = (pkg: WorkspacePackage): string[] =>
  pkg.profile === undefined
    ? [
        `${pkg.label}/package.json: declare "std": { "profile": ... } with one of ${profileNames.join(", ")}`,
      ]
    : checkFile(
        path.join(pkg.dir, "tsconfig.json"),
        `${pkg.label}/tsconfig.json`,
        pkg.profile
      );

const checkTemplates = (): string[] =>
  profileNames.flatMap((profile) => {
    const file = path.join(repoRoot, "tooling", "tsconfig", `${profile}.json`);

    return checkFile(file, path.relative(repoRoot, file), profile);
  });

await runCheck(checkName, () => {
  const args = process.argv.slice(2);

  const packages =
    args.length > 0 ? packagesFromArgs(args) : listWorkspacePackages();

  const problems = [
    ...packages.flatMap((pkg) => checkPackage(pkg)),
    ...(args.length > 0 ? [] : checkTemplates()),
  ];

  report(
    checkName,
    problems,
    `${packages.length} package(s) match their profiles`
  );
});
