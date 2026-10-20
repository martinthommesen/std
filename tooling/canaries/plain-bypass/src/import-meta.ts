const { resolve } = import.meta;

/** import.meta.resolve resolves any module at run time. */
export type ViaImportMeta = typeof resolve;
