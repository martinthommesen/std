import { Option } from "effect";
import { reduce } from "effect/Array";

import type { MetaTable } from "../../domain/metadata.ts";
import {
  REVISION_5,
  TICKET_ID,
  TICKET,
  ticketRecord,
} from "../../form-fixture.ts";
import { REVISION_3, userTable } from "../../table-fixture.ts";
import { Message } from "./message.ts";
import { FormMode } from "./model.ts";
import type { Model } from "./model.ts";
import { init, update } from "./update.ts";

/**
 * Applies form Messages in order, retaining the final Model.
 * @param start - The starting Model.
 * @param messages - The protocol to replay.
 * @returns The resulting Model.
 */
export const formAfter = (
  start: Model,
  ...messages: readonly Message[]
): Model =>
  reduce(messages, start, (current, next) => update(current, next).model);

/**
 * The ticket form, ready at revision 5, the record at version 3.
 *
 * @param table - The ticket's metadata.
 * @returns The page.
 */
export const readyWith = (table: MetaTable): Model =>
  formAfter(
    init({
      id: 1,
      maybeAppRevision: Option.some(REVISION_3),
      mode: FormMode.Edit({ recordId: TICKET_ID }),
      table: TICKET,
    }).model,
    Message.SucceededLoadFormMetadata({ revision: REVISION_5, table }),
    Message.SucceededLoadRecord({
      generation: 1,
      maybeRevision: Option.some(REVISION_5),
      purpose: "Open",
      record: ticketRecord,
    }),
    Message.SucceededLoadTarget({ request: 1, table: userTable })
  );
