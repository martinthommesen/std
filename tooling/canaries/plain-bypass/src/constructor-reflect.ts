// oxlint-disable-next-line anti-slop/no-reflect-get -- the canary names the member in a string argument
const build: unknown = Reflect.get(() => 0, "constructor");

/** A string argument that names the member. */
export const viaReflectConstructor = [build];
