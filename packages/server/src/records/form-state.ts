/** Non-persisting derived proposals and caller-masked form verdicts (decision 0036). */
import { formRulesFor } from "@std/access/form-rules";
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { NotAllowed } from "@std/api/errors/not-allowed";
import { NotFound } from "@std/api/errors/not-found";
import { ValidationFailed } from "@std/api/errors/validation-failed";
import { VersionConflict } from "@std/api/errors/version-conflict";
import type { FormState, FormFieldState } from "@std/api/form-state";
import { checkCondition } from "@std/conditions/check";
import { evaluateCondition } from "@std/conditions/evaluate";
import type { RecordImage } from "@std/conditions/evaluate-core";
import { resolveCondition } from "@std/conditions/resolve";
import { conditionPaths } from "@std/definitions/condition";
import { classViewOf } from "@std/definitions/condition-view";
import type { EffectiveField } from "@std/definitions/effective-schema";
import {
  effectiveClass,
  effectiveFields,
} from "@std/definitions/effective-schema";
import { invalidValue } from "@std/definitions/field-errors";
import { apiAttributeNameOf } from "@std/definitions/names";
import type { MetaFormRule } from "@std/definitions/table-metadata";
import { encodeOut } from "@std/values/codec";
import type { DecodedInput } from "@std/values/field-value";
import { isBoolean, isString } from "@std/values/field-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { isPlaintext } from "@std/values/write-only";
import { Effect, Option, Result } from "effect";

import { applyDeriveRules } from "../hooks/before-rules.ts";
import { imageOf } from "../hooks/rule-condition.ts";
import { deriveIndividualName } from "./party-rules.ts";
import { hookChanges, writtenFields } from "./proposal-changes.ts";
import { rulesById } from "./proposal-rules.ts";
import { currentReadScope } from "./read-records.ts";
import type { ReadScope } from "./read-view.ts";
import { readableOnProposal, readableOnRecord } from "./record-access.ts";
import { loadRecord, loadRoot } from "./save-sql.ts";
import type { ProposalCheck } from "./write-access.ts";
import { WriteAccess } from "./write-access.ts";
import { resolveWriteBody } from "./write-body.ts";
import { proposeCreate, proposeUpdate } from "./write-validation.ts";

/** A canonical proposal at the record interface; values use definition names. */
export interface FormProposal {
  readonly id: string | null;
  readonly revision: number | null;
  readonly values: JsonObject;
}

const existingFor = Effect.fn("Forms.existing")(function* existingFor(
  scope: ReadScope,
  classId: string,
  request: FormProposal
) {
  if (request.id === null) {
    if (request.revision !== null) {
      return yield* new InvalidRequest({
        message: "A create proposal has null id and revision.",
        parameter: "revision",
      });
    }

    return null;
  }

  const root = yield* loadRoot(scope.snapshot, classId, request.id, "none");

  if (
    Option.isNone(root) ||
    !scope.snapshot.subtreeIds(classId).includes(root.value.classId)
  ) {
    return yield* new NotFound();
  }

  const readable = yield* readableOnRecord(
    scope,
    root.value.classId,
    request.id
  );

  if (Option.isNone(readable)) {
    return yield* new NotFound();
  }

  if (request.revision !== root.value.version) {
    return yield* new VersionConflict({ currentVersion: root.value.version });
  }

  const loaded = yield* loadRecord(
    scope.snapshot,
    root.value.classId,
    request.id
  );

  if (Option.isNone(loaded)) {
    return yield* new NotFound();
  }

  return loaded.value;
});

const maskImage = (
  scope: ReadScope,
  classId: string,
  image: RecordImage,
  readable: ReadonlySet<string>
): RecordImage =>
  Object.fromEntries(
    scope.snapshot
      .fields(classId)
      .map((field) => [
        field.id,
        readable.has(field.id) ? (image[field.id] ?? null) : null,
      ])
  );

const targetsFor = Effect.fn("Forms.targets")(function* targetsFor(
  scope: ReadScope,
  rules: readonly MetaFormRule[],
  record: RecordImage,
  previous: RecordImage | null
) {
  const targets = new Map<string, RecordImage | null>();

  // The formRule profile permits one preloaded reference hop (Contracts 5.10).
  for (const path of rules.flatMap((rule) => conditionPaths(rule.condition))) {
    const [firstId] = path.path;

    const field =
      firstId === undefined ? undefined : scope.snapshot.field(firstId);

    const image = path.image === "previous" ? previous : record;
    const id = firstId === undefined ? null : image?.[firstId];

    if (
      path.path.length < 2 ||
      field?.type.kind !== "reference" ||
      !isString(id) ||
      targets.has(id)
    ) {
      continue;
    }

    const loaded = yield* loadRecord(
      scope.snapshot,
      field.type.targetClassId,
      id
    );

    if (Option.isNone(loaded)) {
      targets.set(id, null);
    } else {
      const readable = yield* readableOnRecord(scope, loaded.value.classId, id);
      targets.set(
        id,
        Option.isNone(readable)
          ? null
          : maskImage(
              scope,
              loaded.value.classId,
              imageOf(loaded.value),
              readable.value
            )
      );
    }
  }

  return targets;
});

const readableValues = Effect.fn("Forms.readableValues")(
  function* readableValues(
    fields: readonly EffectiveField[],
    readable: ReadonlySet<string>,
    image: RecordImage
  ) {
    const values = new Map<string, JsonValue>();

    for (const field of fields) {
      if (
        !readable.has(field.field.id) ||
        field.type.kind === "password" ||
        field.type.kind === "secret"
      ) {
        continue;
      }

      const value = image[field.field.id] ?? null;

      if (isPlaintext(value)) {
        return yield* Effect.die(
          new Error(
            "A readable non-secret field contains plaintext credential data."
          )
        );
      }

      values.set(
        apiAttributeNameOf(field.field.name),
        encodeOut(field.type, value)
      );
    }

    return Object.fromEntries(values);
  }
);

interface FieldStateInput {
  readonly fields: readonly EffectiveField[];
  readonly readable: ReadonlySet<string>;
  readonly formRules: readonly MetaFormRule[];
  readonly classId: string;
  readonly masked: RecordImage;
  readonly maskedPrevious: RecordImage | null;
  readonly targets: ReadonlyMap<string, RecordImage | null>;
  readonly scope: ReadScope;
}

interface FieldState {
  hidden: boolean;
  readOnly: boolean;
  required: boolean;
  choices: readonly string[] | null;
}

const applyAssignment = (state: FieldState, rule: MetaFormRule): void => {
  if (rule.property === "choices" && !isBoolean(rule.value)) {
    state.choices = rule.value;
  }

  if (rule.property !== "choices" && isBoolean(rule.value)) {
    state[rule.property] = rule.value;
  }
};

const fieldStates = Effect.fn("Forms.fieldStates")(function* fieldStates(
  input: FieldStateInput
) {
  const {
    fields,
    readable,
    formRules,
    classId,
    masked,
    maskedPrevious,
    targets,
    scope,
  } = input;

  const { snapshot, context } = scope;

  const states = new Map<string, FieldState>(
    fields.flatMap((field) =>
      readable.has(field.field.id)
        ? [
            [
              field.field.id,
              {
                choices: null,
                hidden: false,
                readOnly: false,
                required: false,
              },
            ] as const,
          ]
        : []
    )
  );

  const messages: string[] = [];
  const clearPolicies = new Map<string, MetaFormRule["clearHidden"]>();

  for (const rule of formRules) {
    const state = states.get(rule.fieldId);

    if (state === undefined) {
      continue;
    }

    const checked = checkCondition(rule.condition, {
      classId,
      profile: "formRule",
      purpose: "evaluate",
      view: classViewOf(snapshot),
    });

    if (!checked.ok) {
      return yield* Effect.die(new Error("A stored form rule did not check."));
    }

    const resolvedCondition = resolveCondition(checked.value, context);

    if (!resolvedCondition.ok) {
      return yield* Effect.die(new Error("A form rule did not resolve."));
    }

    if (
      evaluateCondition(resolvedCondition.value, {
        previous: maskedPrevious,
        record: masked,
        targets,
      })
    ) {
      applyAssignment(state, rule);

      if (rule.message !== undefined && rule.message !== null) {
        messages.push(rule.message);
      }

      if (rule.property === "hidden") {
        clearPolicies.set(
          rule.fieldId,
          rule.value === true ? (rule.clearHidden ?? null) : null
        );
      }
    }
  }

  return { clearPolicies, messages, states };
});

const clearHiddenFields = Effect.fn("Forms.clearHiddenFields")(
  function* clearHiddenFields(
    result: Effect.Success<ReturnType<typeof fieldStates>>,
    proposal: ProposalCheck & {
      readonly endpointClassId: string;
    }
  ) {
    const access = yield* WriteAccess;
    const { snapshot, classId, existing, values, endpointClassId } = proposal;

    const writable = new Set(
      effectiveFields(snapshot, classId).flatMap((field) =>
        !field.readOnly && field.field.state === "active"
          ? [field.field.id]
          : []
      )
    );

    const clears = new Map<
      string,
      NonNullable<typeof FormFieldState.Type.clear>
    >();

    for (const [fieldId, policy] of result.clearPolicies) {
      const state = result.states.get(fieldId);

      if (policy === undefined || policy === null || state?.hidden !== true) {
        continue;
      }

      const permitted = yield* Effect.gen(function* mayClear() {
        if (state.readOnly || !writable.has(fieldId)) {
          return false;
        }

        if (existing !== null) {
          yield* access.checkExisting({
            action: "update",
            endpointClassId,
            record: existing,
            snapshot,
            written: new Set([fieldId]),
          });
        }

        yield* access.checkProposedImage({
          action: existing === null ? "create" : "update",
          classId,
          existing,
          snapshot,
          values: new Map([...values, [fieldId, false]]),
          written: new Set([fieldId]),
        });

        return true;
      }).pipe(Effect.catchTag("NotAllowed", () => Effect.succeed(false)));

      clears.set(fieldId, {
        allowed: permitted,
        notice: permitted ? policy.clearedNotice : policy.retainedNotice,
      });
    }

    return clears;
  }
);

const proposeForm = Effect.fn("Forms.propose")(function* proposeForm(
  scope: ReadScope,
  endpointClassId: string,
  request: FormProposal
) {
  const { snapshot } = scope;

  const existing = yield* existingFor(scope, endpointClassId, request);

  if (
    snapshot.class(endpointClassId)?.storage === "platform" ||
    !(effectiveClass(snapshot, endpointClassId)?.acceptsWrites ?? false)
  ) {
    return yield* new NotAllowed();
  }

  const classId = existing?.classId ?? endpointClassId;
  const fields = effectiveFields(snapshot, classId);

  const rules = rulesById(
    snapshot,
    new Map(fields.map((field) => [field.field.id, field])),
    {
      input: { endpointClassId },
      update: existing !== null,
    }
  );

  const resolved = resolveWriteBody(request.values, snapshot.fields(classId));

  if (Result.isFailure(resolved)) {
    return yield* resolved.failure;
  }

  const proposal =
    existing === null
      ? proposeCreate(rules, resolved.success)
      : proposeUpdate(rules, resolved.success, existing);

  return {
    classId,
    existing,
    fields,
    proposal,
    resolved: resolved.success,
    rules,
  };
});

interface VerdictInput {
  readonly fields: readonly EffectiveField[];
  readonly states: ReadonlyMap<string, FieldState>;
  readonly clears: ReadonlyMap<
    string,
    NonNullable<typeof FormFieldState.Type.clear>
  >;
  readonly rules: ReturnType<typeof rulesById>;
  readonly readable: ReadonlySet<string>;
  readonly masked: RecordImage;
  readonly messages: readonly string[];
  readonly revision: number | null;
  readonly schemaRevision: number;
}

const encodeFormState = Effect.fn("Forms.encodeFormState")(
  function* encodeFormState({
    fields,
    states,
    clears,
    rules,
    readable,
    masked,
    messages,
    revision,
    schemaRevision,
  }: VerdictInput) {
    const verdict: typeof FormState.Type = {
      fields: Object.fromEntries(
        fields.flatMap((field) => {
          const state = states.get(field.field.id);

          return state === undefined
            ? []
            : [
                [
                  apiAttributeNameOf(field.field.name),
                  {
                    ...state,
                    ...Option.match(
                      Option.fromNullishOr(clears.get(field.field.id)),
                      {
                        onNone: () => ({}),
                        onSome: (clear) => ({ clear }),
                      }
                    ),
                    readOnly:
                      state.readOnly ||
                      (rules.get(field.field.id)?.readOnly ?? field.readOnly) ||
                      field.numberPrefix !== null,
                    required:
                      state.required ||
                      (field.required && field.numberPrefix === null),
                  },
                ],
              ];
        })
      ),
      messages,
      revision,
      schemaRevision,
      values: yield* readableValues(fields, readable, masked),
    };

    return verdict;
  }
);

/**
 * Evaluates a proposal after derives without saving, running guards, assigning numbers or writing history.
 * @param endpointClassId - The class named by the endpoint.
 * @param request - The proposed values, ID and version in definition names.
 * @returns The caller-masked verdict, or the ordinary access/version refusal.
 */
export const formState = Effect.fn("Forms.state")(function* formState(
  endpointClassId: string,
  request: FormProposal
) {
  const scope = yield* currentReadScope();
  const { snapshot } = scope;
  const actorId = scope.context.me;
  const access = yield* WriteAccess;

  const { existing, classId, fields, resolved, proposal, rules } =
    yield* proposeForm(scope, endpointClassId, request);

  const effective = new Map(fields.map((field) => [field.field.id, field]));

  const oldReadable =
    existing === null
      ? new Set<string>()
      : Option.getOrElse(
          yield* readableOnRecord(scope, classId, existing.id),
          () => new Set<string>()
        );

  const bodyWritten =
    existing === null
      ? new Set(resolved.entries.keys())
      : writtenFields(effective, proposal, existing, oldReadable);

  if (existing !== null) {
    yield* access.checkExisting({
      action: "update",
      endpointClassId,
      record: existing,
      snapshot,
      written: bodyWritten,
    });
  }

  if (proposal.invalid.size > 0) {
    return yield* new ValidationFailed({
      errors: [...proposal.invalid].map(([id, error]) =>
        invalidValue(snapshot.field(id)?.name ?? id, error)
      ),
    });
  }

  const previous = existing === null ? null : imageOf(existing);

  const image: RecordImage = {
    ...Object.fromEntries(fields.map((field) => [field.field.id, null])),
    ...previous,
    ...Object.fromEntries(proposal.values),
  };

  const context = {
    me: actorId,
    now: scope.context.now,
    timeZone: scope.context.timeZone,
  };

  const derived =
    existing !== null && bodyWritten.size === 0
      ? { image, set: new Map<string, DecodedInput>() }
      : yield* applyDeriveRules({
          classId,
          context,
          image,
          operation: existing === null ? "create" : "update",
          previous,
          snapshot,

          supplied: new Set(resolved.entries.keys()),
        });

  const values = deriveIndividualName(
    snapshot,
    classId,
    new Map([...proposal.values, ...derived.set]),
    existing?.values ?? null
  );

  const proposedImage = { ...derived.image, ...Object.fromEntries(values) };

  const affected =
    existing === null
      ? new Set([
          ...resolved.entries.keys(),
          ...hookChanges(effective, proposal.values, values),
        ])
      : writtenFields(
          effective,
          { ...proposal, values },
          existing,
          oldReadable
        );

  if (existing !== null) {
    yield* access.checkExisting({
      action: "update",
      endpointClassId,
      record: existing,
      snapshot,
      written: affected,
    });
  }

  yield* access.checkProposedImage({
    action: existing === null ? "create" : "update",
    classId,
    existing,
    snapshot,
    values,
    written: affected,
  });

  const readable = yield* readableOnProposal(scope, {
    actorId,
    classId,
    existing,
    values,
  });

  const masked = maskImage(scope, classId, proposedImage, readable);

  const previousReadable =
    existing === null
      ? null
      : yield* readableOnProposal(scope, {
          actorId,
          classId,
          existing,
          values: new Map(),
        });

  const maskedPrevious =
    previous === null || previousReadable === null
      ? null
      : maskImage(scope, classId, previous, previousReadable);

  const formRules = formRulesFor(snapshot, scope.caller, classId);
  const targets = yield* targetsFor(scope, formRules, masked, maskedPrevious);

  const { clearPolicies, messages, states } = yield* fieldStates({
    classId,
    fields,
    formRules,
    masked,
    maskedPrevious,
    readable,
    scope,
    targets,
  });

  const clears = yield* clearHiddenFields(
    { clearPolicies, messages, states },
    { classId, endpointClassId, existing, snapshot, values }
  );

  // An optimistic preview never locks out saves. A changed/deleted root invalidates the whole answer.
  if (existing !== null) {
    yield* existingFor(scope, endpointClassId, request);
  }

  return yield* encodeFormState({
    clears,
    fields,
    masked,
    messages,
    readable,
    revision: existing?.version ?? null,
    rules,
    schemaRevision: snapshot.revision,
    states,
  });
});
