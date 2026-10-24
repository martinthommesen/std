import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { runCommand } from "../lib/run.ts";
import { repoRoot } from "../lib/workspace.ts";
import { fixture } from "./run-tools.ts";

const workflow = readFileSync(
  path.join(repoRoot, ".github/workflows/release.yml"),
  "utf-8"
);

const ReleaseWorkflow = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      steps: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            "continue-on-error": Schema.optionalKey(Schema.Unknown),
            id: Schema.optionalKey(Schema.String),
            if: Schema.optionalKey(Schema.String),
            name: Schema.optionalKey(Schema.String),
            run: Schema.optionalKey(Schema.String),
            uses: Schema.optionalKey(Schema.String),
          })
        )
      ),
    })
  ),
});

const parsedWorkflow: unknown = parse(workflow);
const { jobs } = Schema.decodeUnknownSync(ReleaseWorkflow)(parsedWorkflow);
const script = path.join(repoRoot, "docker/release-gate.sh");
const temporaryDirs: string[] = [];

// Keep the real checker and project commands. Only their input evidence and
// package version are synthetic; no registry, signing or workflow is invoked.
const releaseFixture = (version: string): string => {
  const scratch = mkdtempSync(path.join(tmpdir(), "std-release-gate-"));

  temporaryDirs.push(scratch);
  cpSync(fixture("conformance-matrix"), scratch, { recursive: true });
  mkdirSync(path.join(scratch, "packages/server"), { recursive: true });
  mkdirSync(path.join(scratch, "packages/tmf/specs"), { recursive: true });
  mkdirSync(path.join(scratch, "docs"));
  mkdirSync(path.join(scratch, "tooling"));
  mkdirSync(path.join(scratch, "docker"));
  cpSync(path.join(scratch, "matrix"), path.join(scratch, "docs/conformance"), {
    recursive: true,
  });
  cpSync(
    path.join(scratch, "pins.json"),
    path.join(scratch, "packages/tmf/specs/pins.json")
  );
  cpSync(
    path.join(scratch, "demo.oas.json"),
    path.join(scratch, "packages/tmf/specs/demo.oas.json")
  );
  cpSync(
    path.join(repoRoot, "package.json"),
    path.join(scratch, "package.json")
  );
  cpSync(
    path.join(repoRoot, "tooling/lib"),
    path.join(scratch, "tooling/lib"),
    {
      recursive: true,
    }
  );
  cpSync(
    path.join(repoRoot, "tooling/check-conformance-matrix.ts"),
    path.join(scratch, "tooling/check-conformance-matrix.ts")
  );
  cpSync(
    path.join(repoRoot, "docker/release-conformance.sh"),
    path.join(scratch, "docker/release-conformance.sh")
  );
  cpSync(
    path.join(repoRoot, "docker/release-version.sh"),
    path.join(scratch, "docker/release-version.sh")
  );
  symlinkSync(
    path.join(repoRoot, "node_modules"),
    path.join(scratch, "node_modules")
  );
  writeFileSync(
    path.join(scratch, "packages/server/package.json"),
    JSON.stringify({ version })
  );
  writeFileSync(
    path.join(scratch, "docs/conformance/AWAITED@v1.yaml"),
    [
      "spec: AWAITED",
      "version: v1",
      "title: A step 5 fixture specification",
      "sources:",
      "  - id: DOC",
      "    document: Demo step 5 document",
      "    version: v1",
      "    licence: Apache-2.0",
      "rows:",
      "  - id: AWAITED@v1/DOC/1/ready",
      "    source: Demo step 5 document §1",
      "    level: mandatory",
      "    requirement: Has evidence for Step 5.",
      "    status: tested",
      "    tests:",
      "      - sample-tests.ts#counts rows",
      "",
    ].join("\n")
  );
  writeFileSync(
    path.join(scratch, "record-publication.sh"),
    'printf "%s\\n" publication >> "$PUBLICATION_RECORD"\n'
  );

  return scratch;
};

const release = async (scratch: string, tag: string, refType = "tag") =>
  await runCommand(
    "/bin/bash",
    [
      "-eu",
      "-c",
      'bash "$1"\nbash "$2"',
      "--",
      script,
      path.join(scratch, "record-publication.sh"),
    ],
    {
      cwd: scratch,
      env: {
        ...process.env,
        GITHUB_OUTPUT: path.join(scratch, "output"),
        GITHUB_REF_NAME: tag,
        GITHUB_REF_TYPE: refType,
        PUBLICATION_RECORD: path.join(scratch, "publication"),
      },
    }
  );

const dryRun = async (scratch: string) =>
  await runCommand(
    "/bin/bash",
    [
      "-eu",
      "-c",
      'pnpm check:release\nbash "$1"',
      "--",
      path.join(scratch, "record-publication.sh"),
    ],
    {
      cwd: scratch,
      env: {
        ...process.env,
        GITHUB_OUTPUT: path.join(scratch, "output"),
        GITHUB_REF_NAME: "main",
        GITHUB_REF_TYPE: "branch",
        PUBLICATION_RECORD: path.join(scratch, "publication"),
      },
    }
  );

const edit = (
  scratch: string,
  file: string,
  from: string,
  to: string
): void => {
  const target = path.join(scratch, "docs/conformance", file);
  const source = readFileSync(target, "utf-8");

  if (!source.includes(from)) {
    throw new Error(`${file} does not contain ${from}`);
  }

  writeFileSync(target, source.replace(from, to));
};

describe("release-version", () => {
  afterEach(() => {
    for (const dir of temporaryDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("wires the release workflow to the tested gate", () => {
    expect(jobs.publish?.steps?.find((step) => step.id === "gate")?.run).toBe(
      "bash docker/release-gate.sh"
    );
    expect(
      jobs["dry-run"]?.steps?.find((step) => step.name === "Conformance gate")
        ?.run
    ).toBe("pnpm check:release");
  });

  it.each([
    ["publish", "Release gate"],
    ["dry-run", "Conformance gate"],
  ])(
    "gates every %s build, login, signature, attestation and artifact upload",
    (jobName, gateName) => {
      const steps = jobs[jobName]?.steps ?? [];
      const gateIndex = steps.findIndex((step) => step.name === gateName);
      const gate = steps[gateIndex];

      expect(gateIndex).toBeGreaterThan(-1);
      expect({
        condition: gate?.if ?? null,
        continueOnError: gate?.["continue-on-error"] ?? null,
      }).toStrictEqual({
        condition: null,
        continueOnError: null,
      });

      const publicationSteps = steps.filter(
        ({ uses = "", run = "" }) =>
          /^(?:docker\/|actions\/(?:attest|upload-artifact)@)/u.test(uses) ||
          /\b(?:cosign |helm push |docker buildx )/u.test(run)
      );

      expect(publicationSteps.length).toBeGreaterThan(0);

      for (const step of publicationSteps) {
        expect(steps.indexOf(step)).toBeGreaterThan(gateIndex);
        // An explicit status function could run a step after a failed gate.
        expect(step.if ?? "").not.toMatch(
          /(?:always|failure|cancelled|success)\s*\(/u
        );
      }
    }
  );

  it.each([
    ["publish", "Release gate"],
    ["dry-run", "Conformance gate"],
  ])(
    "installs the pinned toolchain before the %s gate",
    (jobName, gateName) => {
      const steps = jobs[jobName]?.steps ?? [];
      const installIndex = steps.findIndex((step) => step.name === "Install");

      expect(installIndex).toBeGreaterThan(0);
      expect(steps[installIndex]?.run).toBe("pnpm install --frozen-lockfile");
      expect(
        steps.slice(0, installIndex).map((step) => step.uses)
      ).toStrictEqual(
        expect.arrayContaining([
          expect.stringMatching(/^pnpm\/action-setup@/u),
          expect.stringMatching(/^actions\/setup-node@/u),
        ])
      );
      expect(steps.findIndex((step) => step.name === gateName)).toBeGreaterThan(
        installIndex
      );
    }
  );

  it.each([
    ["0.0.3", "step3"],
    ["0.0.4", "step4"],
    ["0.1.0", "step5"],
  ])(
    "allows accepted evidence for %s through %s to the recording stand-in",
    async (version, stage) => {
      const scratch = releaseFixture(version);
      const result = await release(scratch, `v${version}`);

      expect(result.code).toBe(0);
      expect(result.output).toContain(`gate ${stage} passed`);
      expect(readFileSync(path.join(scratch, "output"), "utf-8")).toBe(
        `tag=v${version}\n`
      );
      expect(readFileSync(path.join(scratch, "publication"), "utf-8")).toBe(
        "publication\n"
      );
    }
  );

  it.each([
    ["0.0.3", "step3"],
    ["0.0.4", "step4"],
    ["0.1.0", "step5"],
  ])(
    "allows canonical %s through the %s dry-run gate to the recording stand-in",
    async (version, stage) => {
      const scratch = releaseFixture(version);
      const result = await dryRun(scratch);

      expect(result.code).toBe(0);
      expect(result.output).toContain(`gate ${stage} passed`);
      expect(existsSync(path.join(scratch, "output"))).toBeFalsy();
      expect(readFileSync(path.join(scratch, "publication"), "utf-8")).toBe(
        "publication\n"
      );
    }
  );

  it.each(
    (
      [
        ["trailing LF", "0.0.3\n"],
        ["repeated trailing LF", "0.0.3\n\n"],
        ["trailing CRLF", "0.0.3\r\n"],
        ["leading LF", "\n0.0.3"],
        ["embedded LF", "0.0.\n3"],
        ["trailing space", "0.0.3 "],
        ["trailing tab", "0.0.3\t"],
        ["leading space", " 0.0.3"],
        ["trailing NUL", "0.0.3\u0000"],
        ["embedded NUL", "0.0.\u00003"],
        ["prerelease suffix", "0.0.3-rc.1"],
        ["build suffix", "0.0.3+build"],
        ["leading zero", "00.0.3"],
        ["empty string", ""],
        ["null", null],
        ["number", 3],
        ["boolean", true],
        ["array", ["0.0.3"]],
        ["object", { version: "0.0.3" }],
        ["missing version", undefined],
      ] as const
    ).flatMap(([name, version]) =>
      ["publish", "dry-run"].map((mode) => ({ mode, name, version }))
    )
  )(
    "rejects the original JSON version ($name) in $mode before the recording stand-in",
    async ({ mode, version }) => {
      const scratch = releaseFixture("0.0.3");

      writeFileSync(
        path.join(scratch, "packages/server/package.json"),
        JSON.stringify({ version })
      );

      const result =
        mode === "publish"
          ? await release(scratch, "v0.0.3")
          : await dryRun(scratch);

      expect({
        code: result.code,
        deliverablesCreated: existsSync(path.join(scratch, "dist")),
        publicationRecorded: existsSync(path.join(scratch, "publication")),
        tagEmitted: existsSync(path.join(scratch, "output")),
      }).toStrictEqual({
        code: 1,
        deliverablesCreated: false,
        publicationRecorded: false,
        tagEmitted: false,
      });
      expect(result.output).toContain("packages/server/package.json");
      expect(result.output).toContain("must be canonical");
      expect(result.output).toContain("JSON string");
      expect(result.output).toContain(
        `got ${JSON.stringify(version ?? null)}.`
      );
    }
  );

  it.each([
    ["0.0.3", "v0.0.2", "tag", "must match server version"],
    ["0.0.3", "v0.0.3-rc.1", "tag", "must match server version"],
    ["0.0.3-rc.1", "v0.0.3-rc.1", "tag", "must be canonical"],
    ["0.0.3+build", "v0.0.3+build", "tag", "must be canonical"],
    ["00.0.3", "v00.0.3", "tag", "must be canonical"],
    ["0.0.3", "v0.0.3", "branch", "requires a tag"],
    ["0.0.2", "v0.0.2", "tag", "No conformance stage is documented"],
    ["0.0.5", "v0.0.5", "tag", "No conformance stage is documented"],
    ["0.2.0", "v0.2.0", "tag", "No conformance stage is documented"],
  ])(
    "rejects version %s and ref %s (%s) before publication",
    async (version, tag, refType, problem) => {
      const scratch = releaseFixture(version);
      const result = await release(scratch, tag, refType);

      expect(result.code).toBe(1);
      expect(result.output).toContain(problem);
      expect(existsSync(path.join(scratch, "output"))).toBeFalsy();
      expect(existsSync(path.join(scratch, "publication"))).toBeFalsy();
    }
  );

  it.each([
    ["pending", "is pending"],
    ["proposed", "Martin has not decided"],
    ["rejected", "Martin rejected"],
  ])("a matching tag cannot publish %s evidence", async (status, problem) => {
    const scratch = releaseFixture("0.0.3");

    if (status === "pending") {
      edit(
        scratch,
        "DEMO-A@1.0.0.yaml",
        "rows:\n",
        [
          "rows:",
          "  - id: DEMO-A@1.0.0/DOC/4/pending",
          "    source: Demo document 1.0.0 §4 p.3",
          "    level: mandatory",
          "    requirement: Not tested yet.",
          "    status: pending",
          "",
        ].join("\n")
      );
    } else {
      edit(
        scratch,
        "decisions.yaml",
        "    state: decided\n    outcome: accepted\n    decidedBy: Martin\n    words: Accepted.\n    date: 2026-10-22",
        status === "proposed"
          ? "    state: proposed"
          : "    state: decided\n    outcome: rejected\n    decidedBy: Martin\n    words: Rejected.\n    date: 2026-10-22"
      );
    }

    const result = await release(scratch, "v0.0.3");

    expect(result.code).toBe(1);
    expect(result.output).toContain(problem);
    expect(existsSync(path.join(scratch, "output"))).toBeFalsy();
    expect(existsSync(path.join(scratch, "publication"))).toBeFalsy();
  });

  it.each([
    ["0.0.3", 0, "gate step3 passed"],
    ["0.0.4", 0, "gate step4 passed"],
    [
      "0.1.0",
      1,
      "step5: DEMO-B@2.0.yaml: row DEMO-B@2.0/DOC/2/later is pending",
    ],
  ])(
    "version %s applies its stage to later pending rows (exit %i)",
    async (version, code, message) => {
      const scratch = releaseFixture(version);

      edit(
        scratch,
        "DEMO-B@2.0.yaml",
        "    status: tested\n    step: 5\n    tests:\n      - sample-tests.ts#effect-rows",
        "    status: pending\n    step: 5"
      );

      const result = await release(scratch, `v${version}`);

      expect(result.code).toBe(code);
      expect(existsSync(path.join(scratch, "publication"))).toBe(code === 0);

      expect(result.output).toContain(message);
      expect(existsSync(path.join(scratch, "output"))).toBe(code === 0);
    }
  );

  it("the branch dry-run conformance command also rejects pending evidence", async () => {
    const scratch = releaseFixture("0.0.3");

    edit(
      scratch,
      "DEMO-A@1.0.0.yaml",
      "    status: excluded\n    decision: D1-accepted",
      "    status: pending"
    );
    edit(
      scratch,
      "decisions.yaml",
      "    rows:\n      - DEMO-A@1.0.0/DOC/3/excluded",
      "    rows: []"
    );

    const result = await runCommand("pnpm", ["check:release"], {
      cwd: scratch,
      env: {
        ...process.env,
        GITHUB_REF_NAME: "main",
        GITHUB_REF_TYPE: "branch",
      },
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain("is pending");
  });
});
