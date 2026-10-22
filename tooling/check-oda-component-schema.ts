/**
 * `oda-component-schema` for the Step 3 probe's stub (Contracts 13.6;
 * docs/decisions/0027-oda-canvas-probe.md): the stub's Component validates
 * against the `v1` schema of the pinned Component CRD in `deploy/oda/crds/`
 * (canvas-oda 1.2.5), the CRD's storage version. Unknown fields fail here,
 * where the API server would drop them, and the CRD's CEL rules are
 * evaluated. The stub's templates carry no Helm directives, so the file is
 * what `helm template` renders. The probe itself also validates the rendered
 * chart on the live API server (`kubectl apply --dry-run=server`) and checks
 * that the committed CRD equals the one in the chart it installs. Step 5
 * replaces this with the check of the real chart.
 *
 * Usage: `node tooling/check-oda-component-schema.ts [--crd <file>] [--component <file>]`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { Schema } from "effect";
import { parse, parseAllDocuments } from "yaml";

import { report, runCheck } from "./lib/report.ts";
import type { StructuralSchema } from "./lib/structural-schema.ts";
import { decodeStructuralSchema, validate } from "./lib/structural-schema.ts";
import { repoRoot } from "./lib/workspace.ts";

const checkName = "check-oda-component-schema";
const version = "v1";
const helmDirective = /\{\{[^{}]*\}\}/gu;
const serverFields = new Set(["apiVersion", "kind", "metadata"]);

const shown = (file: string): string => {
  const relative = path.relative(repoRoot, file);

  return relative.startsWith("..") ? file : relative;
};

// The parts of a CustomResourceDefinition this check reads; the version's
// schema is decoded separately, strictly (`decodeStructuralSchema`).
const Crd = Schema.Struct({
  spec: Schema.Struct({
    group: Schema.Literal("oda.tmforum.org"),
    names: Schema.Struct({ kind: Schema.Literal("Component") }),
    versions: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        schema: Schema.Struct({ openAPIV3Schema: Schema.Json }),
        served: Schema.Boolean,
        storage: Schema.Boolean,
      })
    ),
  }),
});

const decodeCrd = Schema.decodeUnknownSync(Crd);

// What the API server, not the CRD's schema, checks.
const ComponentEnvelope = Schema.Struct({
  apiVersion: Schema.Literal(`oda.tmforum.org/${version}`),
  kind: Schema.Literal("Component"),
  metadata: Schema.Struct({ name: Schema.NonEmptyString }),
});

const decodeEnvelope = Schema.decodeUnknownResult(ComponentEnvelope);

const decodeJsonObject = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Json)
);

/** The schema of the CRD's version, and whether it is served and stored. */
interface CrdVersion {
  readonly schema: StructuralSchema;
  readonly served: boolean;
  readonly storage: boolean;
}

/**
 * Reads the schema of one version of the CRD. The CRD is a Helm template;
 * its directives sit only in metadata and the conversion webhook, so each
 * is replaced by a quoted placeholder before parsing.
 *
 * @param file - The CRD file.
 * @returns The version's `openAPIV3Schema` and whether it is served and stored.
 */
const readCrdVersion = (file: string): CrdVersion => {
  const source = readFileSync(file, "utf-8").replaceAll(
    helmDirective,
    '"helm-template"'
  );

  const crd = decodeCrd(parse(source));
  const found = crd.spec.versions.find((entry) => entry.name === version);

  if (found === undefined) {
    throw new Error(`${file}: no ${version} version`);
  }

  return {
    schema: decodeStructuralSchema(found.schema.openAPIV3Schema),
    served: found.served,
    storage: found.storage,
  };
};

/**
 * Validates the component file against the CRD version.
 *
 * @param file - The component file.
 * @param crdVersion - The CRD version.
 * @returns One message per problem.
 */
const componentProblems = (file: string, crdVersion: CrdVersion): string[] => {
  const source = readFileSync(file, "utf-8");

  if (source.includes("{{")) {
    return [
      "has Helm directives; keep the stub's Component plain YAML so this check sees what Helm renders",
    ];
  }

  const documents = parseAllDocuments(source);
  const [document] = documents;

  if (
    documents.length !== 1 ||
    document === undefined ||
    document.errors.length > 0
  ) {
    return ["expected exactly one valid YAML document"];
  }

  const component = decodeJsonObject(document.toJS());
  const problems: string[] = [];
  const envelope = decodeEnvelope(component);

  if (envelope._tag === "Failure") {
    problems.push(envelope.failure.message);
  }

  // `apiVersion`, `kind` and `metadata` are the API server's; the CRD's
  // schema describes the rest.
  const body = Object.fromEntries(
    Object.entries(component).filter(([key]) => !serverFields.has(key))
  );

  validate(crdVersion.schema, body, "", problems);

  return problems;
};

await runCheck(checkName, () => {
  const { values } = parseArgs({
    options: {
      component: {
        default: path.join(
          repoRoot,
          "deploy",
          "oda",
          "probe-stub",
          "templates",
          "component.yaml"
        ),
        type: "string",
      },
      crd: {
        default: path.join(
          repoRoot,
          "deploy",
          "oda",
          "crds",
          "oda-component-crd.yaml"
        ),
        type: "string",
      },
    },
  });

  const crdVersion = readCrdVersion(values.crd);

  const problems =
    crdVersion.served && crdVersion.storage
      ? []
      : [
          `${shown(values.crd)}: ${version} must be served and the storage version`,
        ];

  for (const problem of componentProblems(values.component, crdVersion)) {
    problems.push(`${shown(values.component)}: ${problem}`);
  }

  report(
    checkName,
    problems,
    `${shown(values.component)} validates against the ${version} schema of ${shown(values.crd)}`
  );
});
