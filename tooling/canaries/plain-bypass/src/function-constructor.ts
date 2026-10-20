const make = (() => 0).constructor;

/** Any function's constructor is the Function constructor. */
export type ViaConstructor = typeof make;
