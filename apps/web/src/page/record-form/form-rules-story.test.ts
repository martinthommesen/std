/** The verdict binds saving and belongs to one proposal generation. */
import { Option } from "effect";
import { AsyncData } from "foldkit";
import { Command, given, message, model, story } from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import { assert, describe, it } from "vitest";

import { FieldInput } from "../../domain/form-input.ts";
import { wireFieldOf } from "../../domain/wire.ts";
import { REVISION_5, REVISION_6, TICKET_FIELDS } from "../../form-fixture.ts";
import { Metadata } from "../table-list/model.ts";
import { FocusField, LoadFormState } from "./command.ts";
import { shownProblemsOf } from "./fields-view.ts";
import {
  closedFormVerdict,
  pendingForm,
  formRuleTable,
  pendingExistingForm,
  readOnlyVerdict,
} from "./form-rules-fixture.ts";
import { formNotices } from "./form-state-flow.ts";
import {
  checkForm,
  fieldsOf,
  isFormStatePending,
  isReadOnlyForm,
  pendingFormFields,
  showOfField,
} from "./form.ts";
import { Message } from "./message.ts";
import { FormMode, FormStateVerdict, WriteError } from "./model.ts";
import { init, update } from "./update.ts";

const trueFlagForm = modifyFields(pendingForm, {
  metadata: () =>
    Metadata.Success({
      data: {
        revision: REVISION_5,
        table: {
          ...formRuleTable,
          fields: formRuleTable.fields.map((field) =>
            field.id === TICKET_FIELDS.escalated
              ? { ...field, default: true }
              : field
          ),
        },
      },
    }),
});

describe("form rule verdicts", () => {
  it("opens a readable record as read-only and sends no further check or save for attempted edits", () => {
    story(
      update,
      given(pendingExistingForm),
      message(
        Message.SucceededLoadFormState({
          generation: pendingExistingForm.formGeneration,
          maybeRevision: Option.some(REVISION_5),
          verdict: readOnlyVerdict,
        })
      ),
      message(
        Message.UpdatedText({
          fieldId: TICKET_FIELDS.description,
          text: "Attempted change",
        })
      ),
      message(Message.ClickedSave()),
      model((page) => {
        assert.isTrue(isReadOnlyForm(page));
        assert.isFalse(isFormStatePending(page));
        assert.strictEqual(pendingFormFields(page).size, 0);
        assert.deepStrictEqual(page.edits, {});
        assert.strictEqual(page.submission._tag, "Idle");
        assert.isTrue(
          fieldsOf(page).every(
            (field) => showOfField(page, field)._tag !== "Editable"
          )
        );
      }),
      Command.expectNone()
    );
  });

  it("coalesces rapid edits behind one request and applies only the final proposal's verdict", () => {
    const edits = Array.from("abcdefghijklmnopqrstuvwxyz012345", (_, index) =>
      "abcdefghijklmnopqrstuvwxyz012345".slice(0, index + 1)
    );

    story(
      update,
      given(
        init({
          id: 1,
          maybeAppRevision: Option.none(),
          mode: FormMode.Create(),
          table: formRuleTable.name,
        }).model
      ),
      message(
        Message.SucceededLoadFormMetadata({
          revision: REVISION_5,
          table: formRuleTable,
        })
      ),
      Command.expectExact(LoadFormState),
      ...edits.flatMap((text) => [
        message(
          Message.UpdatedText({ fieldId: TICKET_FIELDS.shortDescription, text })
        ),
        Command.expectExact(LoadFormState),
      ]),
      Command.resolve(
        LoadFormState,
        Message.SucceededLoadFormState({
          generation: 1,
          maybeRevision: Option.none(),
          verdict: closedFormVerdict,
        })
      ),
      model((page) => {
        assert.isFalse(AsyncData.hasData(page.formState));
        assert.isTrue(isFormStatePending(page));
        assert.deepStrictEqual(
          page.edits[TICKET_FIELDS.shortDescription],
          FieldInput.Text({ text: "abcdefghijklmnopqrstuvwxyz012345" })
        );
        assert.deepStrictEqual(
          page.maybeFormStateInFlight,
          Option.some(page.formGeneration)
        );
      }),
      Command.expectExact(
        LoadFormState({
          fields: formRuleTable.fields.map(wireFieldOf),
          generation: edits.length + 1,
          recordId: null,
          recordVersion: null,
          schemaRevision: REVISION_5,
          table: formRuleTable.name,
          values: { short_description: "abcdefghijklmnopqrstuvwxyz012345" },
        })
      ),
      Command.resolve(
        LoadFormState,
        Message.SucceededLoadFormState({
          generation: edits.length + 1,
          maybeRevision: Option.none(),
          verdict: {
            ...closedFormVerdict,
            values: {
              ...closedFormVerdict.values,
              points: 73,
              short_description: "abcdefghijklmnopqrstuvwxyz012345",
            },
          },
        })
      ),
      model((page) => {
        assert.isFalse(isFormStatePending(page));
        assert.isTrue(Option.isNone(page.maybeFormStateInFlight));
        assert.deepStrictEqual(
          AsyncData.getData(page.formState),
          Option.some({
            ...closedFormVerdict,
            values: {
              ...closedFormVerdict.values,
              points: 73,
              short_description: "abcdefghijklmnopqrstuvwxyz012345",
            },
          })
        );
      }),
      message(
        Message.SucceededLoadFormState({
          generation: 1,
          maybeRevision: Option.none(),
          verdict: closedFormVerdict,
        })
      ),
      message(
        Message.FailedLoadFormState({
          error: WriteError.Unavailable(),
          generation: 1,
          maybeRevision: Option.none(),
        })
      ),
      model((page) => {
        assert.isFalse(isFormStatePending(page));
      }),
      Command.expectNone()
    );
  });

  it("keeps the live announcement unchanged through typing and identical permissions", () => {
    const checked = update(
      pendingForm,
      Message.SucceededLoadFormState({
        generation: 1,
        maybeRevision: Option.none(),
        verdict: closedFormVerdict,
      })
    ).model;

    const edited = update(
      checked,
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.description,
        text: "A description",
      })
    ).model;

    assert.strictEqual(edited.formAnnouncement, checked.formAnnouncement);

    const repeated = update(
      edited,
      Message.SucceededLoadFormState({
        generation: edited.formGeneration,
        maybeRevision: Option.none(),
        verdict: {
          ...closedFormVerdict,
          values: { ...closedFormVerdict.values, description: "A description" },
        },
      })
    ).model;

    assert.strictEqual(repeated.formAnnouncement, checked.formAnnouncement);

    const changed = update(
      repeated,
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.description,
        text: "A changed description",
      })
    ).model;

    const allowed = update(
      changed,
      Message.SucceededLoadFormState({
        generation: changed.formGeneration,
        maybeRevision: Option.none(),
        verdict: {
          ...closedFormVerdict,
          fields: {
            ...closedFormVerdict.fields,
            description: { hidden: false, readOnly: false, required: false },
          },
        },
      })
    ).model;

    assert.notStrictEqual(allowed.formAnnouncement, checked.formAnnouncement);
  });

  it("releases a failed superseded request without applying its refusal", () => {
    const edited = update(
      pendingForm,
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.description,
        text: "Latest",
      })
    );

    assert.lengthOf(edited.commands ?? [], 0);

    const completed = update(
      edited.model,
      Message.FailedLoadFormState({
        error: WriteError.NotAllowed(),
        generation: 1,
        maybeRevision: Option.none(),
      })
    );

    assert.strictEqual(completed.commands?.length, 1);
    assert.isTrue(Option.isNone(AsyncData.getError(completed.model.formState)));
    assert.deepStrictEqual(
      completed.model.maybeFormStateInFlight,
      Option.some(edited.model.formGeneration)
    );
  });

  it("holds saves while checking, ignores late answers and applies required/read-only/hidden states", () => {
    story(
      update,
      given(pendingForm),
      message(Message.ClickedSave()),
      model((page) => {
        assert.isTrue(isFormStatePending(page));
        assert.strictEqual(page.submission._tag, "Idle");
      }),
      message(
        Message.UpdatedText({
          fieldId: TICKET_FIELDS.shortDescription,
          text: "My title",
        })
      ),
      message(
        Message.SucceededLoadFormState({
          generation: 1,
          maybeRevision: Option.none(),
          verdict: closedFormVerdict,
        })
      ),
      model((page) => {
        assert.isTrue(isFormStatePending(page));
      }),
      Command.resolve(
        LoadFormState,
        Message.SucceededLoadFormState({
          generation: 2,
          maybeRevision: Option.none(),
          verdict: closedFormVerdict,
        })
      ),
      model((page) => {
        assert.isFalse(isFormStatePending(page));
        assert.isFalse(
          fieldsOf(page).some((field) => field.name === "tracking")
        );
        const points = fieldsOf(page).find((field) => field.name === "points");
        assert.isDefined(points);

        if (points !== undefined) {
          assert.deepStrictEqual(showOfField(page, points), {
            _tag: "ReadOnly",
            value: 42,
          });
        }

        assert.deepStrictEqual(
          checkForm(page).problems[TICKET_FIELDS.description],
          ["This field is required."]
        );
      }),
      message(Message.ClickedSave()),
      model((page) => {
        assert.strictEqual(page.submission._tag, "Idle");
        assert.isTrue(page.isShowingProblems);
      }),
      Command.resolve(FocusField, Message.CompletedFocusField())
    );
  });

  it("keeps a failed check blocking, retries explicitly and accepts only the latest retry", () => {
    story(
      update,
      given(pendingForm),
      message(
        Message.FailedLoadFormState({
          error: WriteError.Unavailable(),
          generation: 1,
          maybeRevision: Option.none(),
        })
      ),
      model((page) => {
        assert.isFalse(page.isShowingProblems);
        assert.strictEqual(page.submission._tag, "Idle");
        assert.deepStrictEqual(shownProblemsOf(page), {});
      }),
      model((page) => {
        assert.strictEqual(AsyncData.getError(page.formState)._tag, "Some");
        assert.isTrue(isFormStatePending(page));
      }),
      message(Message.ClickedRetryFormState()),
      message(
        Message.FailedLoadFormState({
          error: WriteError.NotFound(),
          generation: 1,
          maybeRevision: Option.none(),
        })
      ),
      model((page) => {
        assert.strictEqual(page.formState._tag, "Loading");
      }),
      Command.resolve(
        LoadFormState,
        Message.SucceededLoadFormState({
          generation: 2,
          maybeRevision: Option.none(),
          verdict: closedFormVerdict,
        })
      ),
      model((page) => {
        assert.isFalse(isFormStatePending(page));
        assert.strictEqual(page.submission._tag, "Idle");
        assert.deepStrictEqual(shownProblemsOf(page), {});
      })
    );
  });

  it("suppresses a self-hiding edit once and converges when the field reappears", () => {
    const hiding = {
      ...closedFormVerdict,
      fields: {
        ...closedFormVerdict.fields,
        description: { hidden: true, readOnly: false, required: false },
      },
    };

    const shown = {
      ...hiding,
      fields: {
        ...hiding.fields,
        description: { hidden: false, readOnly: false, required: false },
      },
    };

    story(
      update,
      given(pendingForm),
      message(
        Message.UpdatedText({
          fieldId: TICKET_FIELDS.description,
          text: "Hide me",
        })
      ),
      message(
        Message.SucceededLoadFormState({
          generation: 1,
          maybeRevision: Option.none(),
          verdict: closedFormVerdict,
        })
      ),
      Command.resolve(
        LoadFormState,
        Message.SucceededLoadFormState({
          generation: 2,
          maybeRevision: Option.none(),
          verdict: hiding,
        })
      ),
      model((page) => {
        assert.isFalse(Object.hasOwn(page.edits, TICKET_FIELDS.description));
        assert.strictEqual(page.droppedEdits[0]?.reason, "FormRule");
        assert.isTrue(isFormStatePending(page));
      }),
      Command.resolve(
        LoadFormState,
        Message.SucceededLoadFormState({
          generation: 3,
          maybeRevision: Option.none(),
          verdict: shown,
        })
      ),
      model((page) => {
        assert.isFalse(isFormStatePending(page));
        assert.isFalse(Object.hasOwn(checkForm(page).body, "description"));
      })
    );
  });

  it("applies configured hidden clears and derives notices only while the policy applies", () => {
    const hiding = {
      ...closedFormVerdict,
      fields: {
        ...closedFormVerdict.fields,
        escalated: {
          clear: { allowed: true, notice: "Configured clear" },
          hidden: true,
          readOnly: false,
          required: false,
        },
      },
      values: { ...closedFormVerdict.values, escalated: true },
    };

    const start = modifyFields(trueFlagForm, {
      edits: () => ({
        [TICKET_FIELDS.escalated]: FieldInput.Flag({ isChecked: true }),
      }),
    });

    const cleared = update(
      start,
      Message.SucceededLoadFormState({
        generation: 1,
        maybeRevision: Option.none(),
        verdict: hiding,
      })
    ).model;

    assert.deepStrictEqual(
      cleared.edits[TICKET_FIELDS.escalated],
      FieldInput.Flag({ isChecked: false })
    );
    assert.deepStrictEqual(formNotices(cleared), ["Configured clear"]);

    const visible = {
      ...hiding,
      fields: {
        ...hiding.fields,
        escalated: { hidden: false, readOnly: false, required: false },
      },
      values: { ...hiding.values, escalated: false },
    };

    const restored = update(
      cleared,
      Message.SucceededLoadFormState({
        generation: cleared.formGeneration,
        maybeRevision: Option.none(),
        verdict: visible,
      })
    ).model;

    assert.deepStrictEqual(formNotices(restored), []);

    const denied = {
      ...hiding,
      fields: {
        ...hiding.fields,
        escalated: {
          clear: { allowed: false, notice: "Configured retain" },
          hidden: true,
          readOnly: false,
          required: false,
        },
      },
    };

    const retained = update(
      pendingForm,
      Message.SucceededLoadFormState({
        generation: 1,
        maybeRevision: Option.none(),
        verdict: denied,
      })
    ).model;

    assert.isFalse(Object.hasOwn(retained.edits, TICKET_FIELDS.escalated));
    assert.deepStrictEqual(formNotices(retained), ["Configured retain"]);
  });

  it("does not request a write simulation or show pending fields for a read-only viewer", () => {
    const metadata = AsyncData.getData(pendingForm.metadata);
    assert.isTrue(Option.isSome(metadata));

    if (Option.isNone(metadata)) {
      return;
    }

    const table = {
      ...metadata.value.table,
      fields: metadata.value.table.fields.map((field) => ({
        ...field,
        write: { create: "no" as const, update: "no" as const },
      })),
    };

    const viewer = modifyFields(pendingForm, {
      formState: () => FormStateVerdict.Idle(),
      metadata: () => Metadata.Success({ data: { ...metadata.value, table } }),
    });

    const checked = update(viewer, Message.ClickedRetryFormState()).model;
    assert.strictEqual(checked.formState._tag, "Idle");
    assert.isFalse(isFormStatePending(checked));
    assert.isFalse(pendingFormFields(checked).has(TICKET_FIELDS.tracking));
  });

  it("refreshes mismatched metadata and surfaces a version conflict without approving a save", () => {
    const mismatched = update(
      pendingForm,
      Message.SucceededLoadFormState({
        generation: 1,
        maybeRevision: Option.none(),
        verdict: { ...closedFormVerdict, schemaRevision: 6 },
      })
    ).model;

    assert.isTrue(AsyncData.isPending(mismatched.metadata));

    const schemaChanged = update(
      pendingForm,
      Message.FailedLoadFormState({
        error: WriteError.SchemaChanged({
          changes: [],
          currentRevision: "6.00000000-0000-4000-8000-000000000006",
        }),
        generation: 1,
        maybeRevision: Option.none(),
      })
    ).model;

    assert.isTrue(AsyncData.isPending(schemaChanged.metadata));

    const stale = update(
      pendingForm,
      Message.FailedLoadFormState({
        error: WriteError.VersionConflict({ currentVersion: 2 }),
        generation: 1,
        maybeRevision: Option.none(),
      })
    ).model;

    assert.strictEqual(stale.submission._tag, "Idle");
    assert.isTrue(isFormStatePending(stale));
  });

  it("binds a configured choice restriction even when an older control offered another choice", () => {
    const selected = update(
      pendingForm,
      Message.SelectedChoice({ fieldId: TICKET_FIELDS.status, key: "closed" })
    ).model;

    const queued = update(
      selected,
      Message.SucceededLoadFormState({
        generation: 1,
        maybeRevision: Option.none(),
        verdict: closedFormVerdict,
      })
    ).model;

    const checked = update(
      queued,
      Message.SucceededLoadFormState({
        generation: selected.formGeneration,
        maybeRevision: Option.none(),
        verdict: {
          ...closedFormVerdict,
          fields: {
            ...closedFormVerdict.fields,
            status: {
              choices: ["new"],
              hidden: false,
              readOnly: false,
              required: true,
            },
          },
        },
      })
    ).model;

    assert.deepStrictEqual(checkForm(checked).problems[TICKET_FIELDS.status], [
      "Choose one of the choices offered by this form.",
    ]);
  });

  it("treats a field withheld on the proposed image as restricted", () => {
    const fields = Object.fromEntries(
      Object.entries(closedFormVerdict.fields).filter(
        ([name]) => name !== "description"
      )
    );

    const checked = update(
      pendingForm,
      Message.SucceededLoadFormState({
        generation: 1,
        maybeRevision: Option.none(),
        verdict: { ...closedFormVerdict, fields },
      })
    ).model;

    const field = fieldsOf(checked).find(
      (entry) => entry.id === TICKET_FIELDS.description
    );

    assert.isDefined(field);

    if (field !== undefined) {
      assert.deepStrictEqual(showOfField(checked, field), {
        _tag: "Restricted",
      });
    }
  });

  it("validates the authoritative derived value when a derive replaces an empty input", () => {
    const selected = update(
      pendingForm,
      Message.UpdatedText({ fieldId: TICKET_FIELDS.shortDescription, text: "" })
    ).model;

    const queued = update(
      selected,
      Message.SucceededLoadFormState({
        generation: 1,
        maybeRevision: Option.none(),
        verdict: closedFormVerdict,
      })
    ).model;

    const checked = update(
      queued,
      Message.SucceededLoadFormState({
        generation: selected.formGeneration,
        maybeRevision: Option.none(),
        verdict: closedFormVerdict,
      })
    ).model;

    assert.isUndefined(
      checkForm(checked).problems[TICKET_FIELDS.shortDescription]
    );
  });

  it.each(["readOnly", "hidden"] as const)(
    "stops a clear/suppress cycle when the false value becomes %s",
    (property) => {
      const hiding = {
        ...closedFormVerdict,
        fields: {
          ...closedFormVerdict.fields,
          escalated: {
            clear: { allowed: true, notice: "Configured clear" },
            hidden: true,
            readOnly: false,
            required: false,
          },
        },
        values: { ...closedFormVerdict.values, escalated: true },
      };

      const suppressing = {
        ...hiding,
        fields: {
          ...hiding.fields,
          escalated: {
            hidden: property === "hidden",
            readOnly: property === "readOnly",
            required: false,
          },
        },
        values: { ...hiding.values, escalated: false },
      };

      story(
        update,
        given(trueFlagForm),
        message(
          Message.SucceededLoadFormState({
            generation: 1,
            maybeRevision: Option.none(),
            verdict: hiding,
          })
        ),
        Command.resolve(
          LoadFormState,
          Message.SucceededLoadFormState({
            generation: 2,
            maybeRevision: Option.none(),
            verdict: suppressing,
          })
        ),
        Command.resolve(
          LoadFormState,
          Message.SucceededLoadFormState({
            generation: 3,
            maybeRevision: Option.none(),
            verdict: hiding,
          })
        ),
        model((page) => {
          assert.isFalse(isFormStatePending(page));
          assert.strictEqual(page.formGeneration, 3);
          assert.isUndefined(page.edits[TICKET_FIELDS.escalated]);
          assert.deepStrictEqual(page.suppressedFormFields, [
            TICKET_FIELDS.escalated,
          ]);
          assert.include(
            formNotices(page)[0],
            "prevents an automatic correction"
          );
        })
      );
    }
  );

  it("applies constant hidden and choice restrictions before the server answers", () => {
    const loaded = update(
      pendingForm,
      Message.SucceededLoadFormMetadata({
        revision: REVISION_5,
        table: {
          ...formRuleTable,
          formRules: [
            ...formRuleTable.formRules,
            {
              condition: { op: "true" },
              fieldId: TICKET_FIELDS.tracking,
              id: "00000000-0000-4000-8000-00000000a004",
              order: 3,
              property: "hidden",
              value: true,
            },
            {
              condition: { op: "true" },
              fieldId: TICKET_FIELDS.status,
              id: "00000000-0000-4000-8000-00000000a005",
              order: 4,
              property: "choices",
              value: ["new"],
            },
          ],
        },
      })
    ).model;

    assert.isFalse(fieldsOf(loaded).some((field) => field.name === "tracking"));
    assert.deepStrictEqual(
      fieldsOf(loaded)
        .find((field) => field.name === "status")
        ?.choices?.map((choice) => choice.key),
      ["new"]
    );
  });

  it("keeps check refusals separate from save results", () => {
    const invalid = update(
      pendingForm,
      Message.FailedLoadFormState({
        error: WriteError.ValidationFailed({
          errors: [{ _tag: "Required", field: "description" }],
        }),
        generation: 1,
        maybeRevision: Option.none(),
      })
    ).model;

    assert.deepStrictEqual(
      shownProblemsOf(invalid)[TICKET_FIELDS.description],
      ["This field is required."]
    );
    assert.strictEqual(invalid.submission._tag, "Idle");

    const refused = update(
      pendingForm,
      Message.FailedLoadFormState({
        error: WriteError.NotAllowed(),
        generation: 1,
        maybeRevision: Option.none(),
      })
    ).model;

    assert.strictEqual(refused.submission._tag, "Idle");
  });

  it("discards an old verdict before reconciling edits after a field rename", () => {
    story(
      update,
      given(pendingForm),
      message(
        Message.UpdatedText({
          fieldId: TICKET_FIELDS.description,
          text: "Keep this input",
        })
      ),
      message(
        Message.SucceededLoadFormState({
          generation: 1,
          maybeRevision: Option.none(),
          verdict: closedFormVerdict,
        })
      ),
      Command.resolve(
        LoadFormState,
        Message.SucceededLoadFormState({
          generation: 2,
          maybeRevision: Option.none(),
          verdict: {
            ...closedFormVerdict,
            values: {
              ...closedFormVerdict.values,
              description: "Keep this input",
            },
          },
        })
      ),
      message(
        Message.SucceededLoadFormMetadata({
          revision: REVISION_6,
          table: {
            ...formRuleTable,
            fields: formRuleTable.fields.map((field) =>
              field.id === TICKET_FIELDS.description
                ? { ...field, name: "renamed_description" }
                : field
            ),
          },
        })
      ),
      model((page) => {
        assert.deepStrictEqual(
          page.edits[TICKET_FIELDS.description],
          FieldInput.Text({ text: "Keep this input" })
        );
        assert.deepStrictEqual(page.droppedEdits, []);
        assert.isFalse(AsyncData.hasData(page.formState));
        assert.isTrue(isFormStatePending(page));
      }),
      Command.resolve(
        LoadFormState,
        Message.SucceededLoadFormState({
          generation: 3,
          maybeRevision: Option.none(),
          verdict: {
            ...closedFormVerdict,
            fields: Object.fromEntries(
              Object.entries(closedFormVerdict.fields).map(([name, state]) => [
                name === "description" ? "renamed_description" : name,
                state,
              ])
            ),
            schemaRevision: 6,
            values: Object.fromEntries(
              Object.entries({
                ...closedFormVerdict.values,
                description: "Keep this input",
              }).map(([name, value]) => [
                name === "description" ? "renamed_description" : name,
                value,
              ])
            ),
          },
        })
      ),
      model((page) => {
        assert.isFalse(isFormStatePending(page));
        assert.deepStrictEqual(checkForm(page).unknownFields, []);
        assert.deepStrictEqual(
          page.edits[TICKET_FIELDS.description],
          FieldInput.Text({ text: "Keep this input" })
        );
      })
    );
  });
});
