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
 * Usage: `pnpm ctk API --url URL --token-file FILE` with the optional flags
 * `--payloads FILE`, `--network DOCKER_NETWORK` and `--reports DIR`, for
 * example `pnpm ctk tmf621 --url http://127.0.0.1:8080/tmf-api/troubleTicket/v5 --token-file "$TOKEN_FILE" --network host`.
 *
 * The bearer token is read from a file only its owner may read (mode 0600
 * or stricter), never from an argument: arguments show in `ps` and in
 * pnpm's echo of the command it runs (decision 0035). No message of the
 * runner contains it.
 */
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
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
import { withKitSession } from "../lib/ctk-session.ts";
import { runCheck } from "../lib/report.ts";
import { runCommand } from "../lib/run.ts";
import { repoRoot } from "../lib/workspace.ts";
import { readZipEntry } from "../lib/zip.ts";

/** How long one Docker cleanup call may take before it is killed. */
const CLEANUP_TIMEOUT_MS = 60_000;

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

  if (existsSync(file)) {
    const bytes = readFileSync(file);

    if (sha256(bytes) === kit.zipSha256) {
      return bytes;
    }
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

/**
 * The permission bits for group and others sit below this place value of
 * a mode: `mode % OWNER_PLACE` is the bits a token file must leave unset.
 */
const OWNER_PLACE = 0o100;

/**
 * The bearer token in a file only its owner may read.
 *
 * @param file - The token file.
 * @returns The token, without surrounding white space.
 */
const readToken = (file: string): string => {
  if (statSync(file).mode % OWNER_PLACE !== 0) {
    throw new Error(
      `the token file ${file} is readable by others; make it mode 0600`
    );
  }

  const token = readFileSync(file, "utf-8").trim();

  if (token === "") {
    throw new Error(`the token file ${file} is empty`);
  }

  return token;
};

const main = async (): Promise<void> => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      network: { default: "host", type: "string" },
      payloads: { type: "string" },
      reports: { type: "string" },
      "token-file": { type: "string" },
      url: { type: "string" },
    },
  });

  const [api] = positionals;
  const { network, reports: keep, "token-file": tokenFile, url } = values;

  if (api === undefined || url === undefined || tokenFile === undefined) {
    throw new Error(
      "usage: pnpm ctk <api> --url <base URL> --token-file <file holding the bearer token, mode 0600>"
    );
  }

  const token = readToken(tokenFile);
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

  const verdict = await withKitSession(
    {
      cleanupTimeoutMs: CLEANUP_TIMEOUT_MS,
      docker: async (args, signal) =>
        await runCommand("docker", args, { cwd: repoRoot, signal }),
      exit: (code) => process.exit(code),
      signals: process,
      tempRoot: tmpdir(),
    },
    pin.spec.toLowerCase(),
    image,
    async (session) => {
      writeFileSync(
        session.config,
        JSON.stringify(
          {
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            payloads,
            url,
          },
          null,
          2
        )
      );

      const reportsWereEmpty = readdirSync(session.reports).length === 0;
      const startedAt = Date.now();

      // The exit code says nothing: the kit's entrypoint ignores test
      // failures.
      await docker(
        [
          "run",
          "--rm",
          "--name",
          session.container,
          "--network",
          network,
          "-v",
          `${session.reports}:/reports`,
          "-v",
          `${session.config}:/config/config.json:ro`,
          image,
        ],
        true
      );

      const judged = judgeKitRun(
        {
          ctkVersion: readIfPresent(
            path.join(session.reports, "ctk_version.txt")
          ),
          indexJson: readIfPresent(path.join(session.reports, "index.json")),
          reportsWereEmpty,
          startedAt,
        },
        { expectedCases, image: pin.ctk.image, url }
      );

      if (keep !== undefined) {
        cpSync(session.reports, keep, { recursive: true });
      }

      return judged;
    }
  );

  for (const title of verdict.passedCases) {
    process.stdout.write(`passed: ${normalizeCaseTitle(title, url)}\n`);
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
  await runCheck("ctk", main);
}
