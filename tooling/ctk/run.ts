/**
 * The CTK runner (Contracts 11.1): runs a pinned TM Forum Conformance Test
 * Kit against a running STD and passes only under the runner's criteria
 * (`tooling/lib/ctk-report.ts`).
 *
 * 1. Downloads the kit's zip from its pinned URL into a cache outside the
 *    repository (never committed), and checks its SHA-256.
 * 2. Pulls the kit's image and checks its digest against the pin.
 * 3. Writes the kit's `config.json`: the base URL STD serves the API at, a
 *    bearer token, and the payloads (the kit's defaults, overridden by
 *    `--payloads`, since the defaults hold placeholders such as
 *    `sample_severity`).
 * 4. Runs the kit's image directly (not `run.sh`, which opens a browser)
 *    in a uniquely named container, with an empty reports directory.
 * 5. Judges `reports/index.json` and `ctk_version.txt` against the
 *    matrix's `kitCases` for the specification, ignoring the exit code,
 *    copies the reports to `--reports` (a CI artifact), and removes its
 *    working directory.
 *
 * Usage: `pnpm ctk API --url URL --token TOKEN` with the optional flags
 * `--payloads FILE`, `--network DOCKER_NETWORK` and `--reports DIR`, for
 * example `pnpm ctk tmf621 --url http://127.0.0.1:8080/tmf-api/troubleTicket/v5 --token "$TOKEN" --network host`.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import type { ConformanceKit, Specification } from "@std/tmf/pins";
import { decodePinsFile, matrixFileName } from "@std/tmf/pins";
import { Predicate, Result } from "effect";
import { parse as parseYaml } from "yaml";

import { judgeKitRun, normalizeCaseTitle } from "../lib/ctk-report.ts";
import { runCommand } from "../lib/run.ts";
import { repoRoot } from "../lib/workspace.ts";
import { readZipEntry } from "../lib/zip.ts";

/** The container user of the TM Forum kits writes the reports. */
const WORLD_WRITABLE = 0o777;

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const pinOf = (
  api: string
): Specification & { readonly ctk: ConformanceKit } => {
  const decoded = decodePinsFile(
    JSON.parse(
      readFileSync(
        path.join(repoRoot, "packages", "tmf", "specs", "pins.json"),
        "utf-8"
      )
    )
  );

  if (Result.isFailure(decoded)) {
    throw new Error(`pins.json does not decode: ${String(decoded.failure)}`);
  }

  const pin = decoded.success.specifications.find(
    (candidate) => candidate.spec.toLowerCase() === api.toLowerCase()
  );

  if (pin?.ctk === undefined) {
    throw new Error(`${api} has no pinned kit in pins.json`);
  }

  return { ...pin, ctk: pin.ctk };
};

/**
 * The expected mandatory cases of a specification: every `kitCases` title
 * of its matrix file.
 *
 * @param pin - The pinned specification.
 * @returns The titles.
 */
export const expectedCasesOf = (pin: Specification): readonly string[] => {
  const file = path.join(repoRoot, "docs", "conformance", matrixFileName(pin));
  const matrix: unknown = parseYaml(readFileSync(file, "utf-8"));

  const rows: readonly unknown[] =
    Predicate.hasProperty(matrix, "rows") && Array.isArray(matrix.rows)
      ? matrix.rows
      : [];

  const titles: string[] = [];

  for (const row of rows) {
    if (Predicate.hasProperty(row, "kitCases") && Array.isArray(row.kitCases)) {
      const cases: readonly unknown[] = row.kitCases;

      titles.push(...cases.filter(Predicate.isString));
    }
  }

  return titles;
};

const cachedZip = async (kit: ConformanceKit): Promise<Buffer> => {
  const cache = path.join(
    process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"),
    "std-ctk"
  );

  const file = path.join(cache, path.basename(new URL(kit.zipUrl).pathname));

  if (existsSync(file) && sha256(readFileSync(file)) === kit.zipSha256) {
    return readFileSync(file);
  }

  const response = await fetch(kit.zipUrl);

  if (!response.ok) {
    throw new Error(`downloading ${kit.zipUrl} answered ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = sha256(bytes);

  if (digest !== kit.zipSha256) {
    throw new Error(
      `${kit.zipUrl} has SHA-256 ${digest}, not the pinned ${kit.zipSha256}`
    );
  }

  mkdirSync(cache, { recursive: true });
  writeFileSync(file, bytes);

  return bytes;
};

const docker = async (args: readonly string[], echo = false) =>
  await runCommand("docker", args, { cwd: repoRoot, echo });

const pulledImage = async (kit: ConformanceKit): Promise<string> => {
  const pulled = await docker(["pull", kit.image], true);

  if (pulled.code !== 0) {
    throw new Error(`docker pull ${kit.image} failed`);
  }

  const inspected = await docker([
    "image",
    "inspect",
    "--format",
    "{{json .RepoDigests}}",
    kit.image,
  ]);

  const repository = kit.image.split(":")[0] ?? kit.image;
  const pinned = `${repository}@${kit.imageDigest ?? ""}`;

  if (kit.imageDigest === undefined || !inspected.output.includes(pinned)) {
    throw new Error(
      `${kit.image} is not the pinned image ${pinned}: ${inspected.output.trim()}`
    );
  }

  return pinned;
};

const readIfPresent = (file: string): string | undefined =>
  existsSync(file) ? readFileSync(file, "utf-8") : undefined;

const main = async (): Promise<void> => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      network: { default: "host", type: "string" },
      payloads: { type: "string" },
      reports: { type: "string" },
      token: { type: "string" },
      url: { type: "string" },
    },
  });

  const [api] = positionals;

  if (
    api === undefined ||
    values.url === undefined ||
    values.token === undefined
  ) {
    throw new Error(
      "usage: pnpm ctk <api> --url <base URL> --token <bearer token>"
    );
  }

  const pin = pinOf(api);
  const expectedCases = expectedCasesOf(pin);
  const zip = await cachedZip(pin.ctk);

  const kitConfig: unknown = JSON.parse(
    readZipEntry(zip, "config.json").toString("utf-8")
  );

  const defaults = Predicate.hasProperty(kitConfig, "payloads")
    ? kitConfig.payloads
    : {};

  const overrides: unknown =
    values.payloads === undefined
      ? {}
      : JSON.parse(readFileSync(values.payloads, "utf-8"));

  const payloads = {};

  if (Predicate.isObject(defaults)) {
    Object.assign(payloads, defaults);
  }

  if (Predicate.isObject(overrides)) {
    Object.assign(payloads, overrides);
  }

  const image = await pulledImage(pin.ctk);

  const work = mkdtempSync(
    path.join(tmpdir(), `std-ctk-${pin.spec.toLowerCase()}-`)
  );

  const reports = path.join(work, "reports");
  const config = path.join(work, "config.json");

  mkdirSync(reports);
  chmodSync(reports, WORLD_WRITABLE);

  writeFileSync(
    config,
    JSON.stringify(
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${values.token}`,
          "Content-Type": "application/json",
        },
        payloads,
        url: values.url,
      },
      null,
      2
    )
  );

  const reportsWereEmpty = readdirSync(reports).length === 0;

  const startedAt = Date.now();
  const container = `std-ctk-${pin.spec.toLowerCase()}-${randomUUID().slice(0, 8)}`;

  // The exit code says nothing: the kit's entrypoint ignores test failures.
  await docker(
    [
      "run",
      "--rm",
      "--name",
      container,
      "--network",
      values.network,
      "-v",
      `${reports}:/reports`,
      "-v",
      `${config}:/config/config.json:ro`,
      image,
    ],
    true
  );

  const verdict = judgeKitRun(
    {
      ctkVersion: readIfPresent(path.join(reports, "ctk_version.txt")),
      indexJson: readIfPresent(path.join(reports, "index.json")),
      reportsWereEmpty,
      startedAt,
    },
    { expectedCases, image: pin.ctk.image, url: values.url }
  );

  if (values.reports !== undefined) {
    cpSync(reports, values.reports, { recursive: true });
  }

  // The kit's user owns what it wrote: delete it through the same image.
  await docker([
    "run",
    "--rm",
    "--name",
    `${container}-cleanup`,
    "--entrypoint",
    "find",
    "-v",
    `${reports}:/reports`,
    image,
    "/reports",
    "-mindepth",
    "1",
    "-delete",
  ]);
  rmSync(work, { force: true, recursive: true });

  for (const title of verdict.passedCases) {
    process.stdout.write(`passed: ${normalizeCaseTitle(title, values.url)}\n`);
  }

  for (const problem of verdict.problems) {
    process.stderr.write(`${problem}\n`);
  }

  process.stdout.write(
    `ctk ${pin.ctk.name}: ${verdict.passed ? "PASSED" : "FAILED"} (${verdict.passedCases.length} of ${verdict.tests} tests passed, ${expectedCases.length} mandatory cases expected)\n`
  );

  process.exitCode = verdict.passed ? 0 : 1;
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `ctk: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
