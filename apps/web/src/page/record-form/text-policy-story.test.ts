import { Option } from "effect";
import { given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";

import type { MetaTable } from "../../domain/metadata.ts";
import {
  REVISION_5,
  TICKET,
  TICKET_FIELDS,
  TICKET_ID,
  ticketRecord,
  ticketTable,
} from "../../form-fixture.ts";
import { REVISION_3, userTable } from "../../table-fixture.ts";
import { formAfter } from "./fixture.ts";
import { checkForm } from "./form.ts";
import { Message } from "./message.ts";
import { FormMode } from "./model.ts";
import { init, update } from "./update.ts";

const PROSE = " \tCafe\u0301\r\nline\r ";

const metadata: MetaTable = {
  ...ticketTable,
  fields: ticketTable.fields.map((field) => {
    if (field.id === TICKET_FIELDS.description) {
      return { ...field, type: { kind: "longText", textPolicy: "freeText" } };
    }

    return field;
  }),
};

const opened = formAfter(
  init({
    id: 1,
    maybeAppRevision: Option.some(REVISION_3),
    mode: FormMode.Edit({ recordId: TICKET_ID }),
    table: TICKET,
  }).model,
  Message.SucceededLoadFormMetadata({ revision: REVISION_5, table: metadata }),
  Message.SucceededLoadRecord({
    generation: 1,
    maybeRevision: Option.some(REVISION_5),
    purpose: "Open",
    record: {
      ...ticketRecord,
      values: { ...ticketRecord.values, description: PROSE },
    },
  }),
  Message.SucceededLoadTarget({ request: 1, table: userTable })
);

describe("free text form", () => {
  it("keeps untouched server scalars out of a save of another field", () => {
    story(
      update,
      given(opened),
      message(
        Message.UpdatedText({
          fieldId: TICKET_FIELDS.shortDescription,
          text: "Another title",
        })
      ),
      model((page) => {
        expect(checkForm(page).body.values).toStrictEqual({
          short_description: "Another title",
        });
      })
    );
  });

  it("sends actual textarea edits and optional empty text as strings", () => {
    story(
      update,
      given(opened),
      message(
        Message.UpdatedText({
          fieldId: TICKET_FIELDS.description,
          text: " \tCafe\u0301\nline\n ",
        })
      ),
      model((page) => {
        expect(checkForm(page).body.values).toStrictEqual({
          description: " \tCafe\u0301\nline\n ",
        });
      }),
      message(
        Message.UpdatedText({ fieldId: TICKET_FIELDS.description, text: "" })
      ),
      model((page) => {
        expect(checkForm(page).body.values).toStrictEqual({ description: "" });
      })
    );
  });
});
