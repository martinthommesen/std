// Fixture for the conformance-matrix-check tests: an `it` that is not
// vitest's, so its titles never satisfy a row.
const it = (title: string, body: () => void): string => {
  body();

  return title;
};

it("a local case", () => {
  it("a nested local case", () => {
    // Nothing to do.
  });
});
