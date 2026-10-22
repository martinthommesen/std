import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Predicate, Result } from "effect";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import type { PinsFile, Specification } from "../src/pins.ts";
import { decodePinsFile, matrixFileName } from "../src/pins.ts";

// Contracts 11.1 and 15.1: `specs/pins.json` is the single source of pins,
// and the pinned OpenAPI documents are vendored byte for byte beside it.
const specsDir = path.join(import.meta.dirname, "..", "specs");

const readPins = (): PinsFile => {
  const decoded = decodePinsFile(
    JSON.parse(readFileSync(path.join(specsDir, "pins.json"), "utf-8"))
  );

  if (Result.isFailure(decoded)) {
    throw new Error(String(decoded.failure));
  }

  return decoded.success;
};

const openApiPins = (): Specification[] =>
  readPins().specifications.filter((pin) => pin.kind === "openApi");

const documentFile = (pin: Specification): string =>
  path.join(specsDir, pin.openApi?.file ?? `${pin.spec}: no openApi`);

const trimSlash = (text: string): string => text.replace(/\/$/u, "");

describe("tmf-pins", () => {
  it("decodes pins.json strictly and names every specification once", () => {
    const names = readPins().specifications.map(matrixFileName);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("TMF630@4.2.0.yaml");
  });

  it("vendors exactly the pinned OpenAPI documents, with their SHA-256", () => {
    const pins = openApiPins();

    const hashes = pins.map((pin) => [
      pin.spec,
      createHash("sha256")
        .update(readFileSync(documentFile(pin)))
        .digest("hex"),
    ]);

    const vendored = readdirSync(specsDir).filter(
      (file) => file !== "pins.json"
    );

    expect(hashes).toStrictEqual(
      pins.map((pin) => [pin.spec, pin.openApi?.sha256])
    );
    expect(
      vendored.toSorted((left, right) => left.localeCompare(right))
    ).toStrictEqual(
      pins
        .map((pin) => pin.openApi?.file ?? "")
        .toSorted((left, right) => left.localeCompare(right))
    );
  });

  it("gives every Open API a base path and the document's own version", () => {
    const pins = openApiPins();

    const found = pins.map((pin) => {
      const document: unknown = parse(readFileSync(documentFile(pin), "utf-8"));

      const info = Predicate.hasProperty(document, "info")
        ? document.info
        : undefined;

      const version = Predicate.hasProperty(info, "version")
        ? info.version
        : undefined;

      return [pin.spec, version, pin.basePath?.startsWith("/tmf-api/")];
    });

    expect(found).toStrictEqual(
      pins.map((pin) => [pin.spec, pin.version, true])
    );
  });

  it("serves each kit's API under the kit's default base path", () => {
    const withKit = openApiPins().filter((pin) => pin.ctk !== undefined);

    const kitPaths = withKit.map((pin) => [
      pin.spec,
      trimSlash(new URL(pin.ctk?.defaultUrl ?? "").pathname),
    ]);

    expect(withKit.length).toBeGreaterThan(0);
    expect(kitPaths).toStrictEqual(
      withKit.map((pin) => [pin.spec, pin.basePath])
    );
  });
});
