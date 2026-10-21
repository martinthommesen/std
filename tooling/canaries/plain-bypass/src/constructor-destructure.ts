const { constructor: build } = () => 0;

/** Destructuring reads the Function constructor. */
export type ViaDestructuredConstructor = typeof build;
