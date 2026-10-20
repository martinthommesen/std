const {
  inner: { constructor: build },
} = { inner: () => 0 };

/** A nested destructuring pattern reads the Function constructor. */
export type ViaNestedConstructor = typeof build;
