/**
 * Looks up storage models by ID.
 */
import type { ModelId, StorageModel } from "../storage-model.ts";
import { classTableModel } from "./class-table.ts";
import { concreteTableModel } from "./concrete-table.ts";
import { partitionedModel, singleTableModel } from "./hierarchy-table.ts";

const models: Readonly<Record<ModelId, StorageModel>> = {
  "class-table": classTableModel,
  "concrete-table": concreteTableModel,
  partitioned: partitionedModel,
  "single-table": singleTableModel,
};

/**
 * The storage model with this ID.
 *
 * @param id - The model ID.
 * @returns The model.
 */
export const modelById = (id: ModelId): StorageModel => models[id];
