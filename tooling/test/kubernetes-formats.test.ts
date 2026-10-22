import { readFileSync } from "node:fs";
import path from "node:path";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { isCheckedFormat, matchesFormat } from "../lib/kubernetes-formats.ts";
import { repoRoot } from "../lib/workspace.ts";

// The formats a Kubernetes 1.30 API server checks in CRD schemas
// (docs/decisions/0027-oda-canvas-probe.md, `oda-component-schema`),
// compared with what the pinned Go validators answered for the same inputs:
// tooling/fixtures/kubernetes-formats/expected.json, written by main.go
// beside it (kube-openapi 70dd3763d340, Go 1.22.2).
const decodeExpected = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Record(
      Schema.String,
      Schema.Array(Schema.Tuple([Schema.String, Schema.Boolean]))
    )
  )
);

const expected = decodeExpected(
  readFileSync(
    path.join(
      repoRoot,
      "tooling",
      "fixtures",
      "kubernetes-formats",
      "expected.json"
    ),
    "utf-8"
  )
);

describe("kubernetes-formats", () => {
  it.each(Object.entries(expected))(
    "answers %s as the Go validators do",
    (format, cases) => {
      const disagreements = cases.filter(
        ([value, valid]) => matchesFormat(format, value) !== valid
      );

      expect(disagreements).toStrictEqual([]);
    }
  );

  it("covers every format the API server checks", () => {
    const covered = Object.keys(expected).filter((format) =>
      isCheckedFormat(format)
    );

    expect(covered).toHaveLength(24);
  });
});
