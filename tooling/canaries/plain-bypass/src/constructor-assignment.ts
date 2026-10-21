// oxlint-disable-next-line prefer-const -- the destructuring assignment below assigns it
let build: unknown;

({ constructor: build } = () => 0);

/** An assignment pattern reads the Function constructor. */
export const viaAssignedConstructor = [build];
