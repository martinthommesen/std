# 0029. Aggregates: owner references, locks, settling and the aggregate save

Status: proposed, 2026-10-23 (workstream 3A/3T aggregates, plan Step 3 gate "Aggregates and patches"). Builds on decision 0021 (resolved questions 20, 23, 26, 28 and 33), decision 0022 (record rules, and its seams for aggregates: the `settled` save mode, `applyDeriveRules`, `suppliedFieldsOf`) and decision 0023 (the `kind: "system"` cause precedent). Contracts 2.2, 4.1, 4.9, 4.10, 5.2, 5.10 and 6.5; the contract text now carries the precisions below, each marked `[precised, decision 0029]` or `[judgment, decision 0029]`.

Code: `packages/values/src/field-type.ts` (`aggregate` on reference types), `packages/definitions/src/aggregates.ts` (owner references, part classes, graph checks), `packages/conditions/src/aggregate.ts` (the aggregate-rule profile), `packages/definitions/src/{condition,condition-view,rule-validation,rule-references,record-rules,record-schema,table-metadata,set-file,set-resolve,effective-schema,allowed-records,validate,problems}.ts`, `packages/server/src/records/aggregate-{chain,state,images,finalize}.ts`, `packages/server/src/hooks/{aggregate-settle,rule-for-each}.ts`, `packages/server/src/records/{save-pipeline,save-hooks,write-access,change-entry}.ts`, `packages/api/src/errors/aggregate-not-settled.ts`.

## Decision

### Owner references (4.9, 6.5)

A reference type may carry `aggregate: true`. It is stored in the field's `type` JSON, so no platform migration is needed: an absent key decodes as false (RU12 holds without new tolerance), and an explicit `false` compares equal to absent, so turning it on or off is the existing `unsupportedChange` of a type change. Set files write it on the reference entry.

- **Required.** The effective field is required whatever its flag, so validation gives `Required` on a create without an owner.
- **Read-only after create.** `rulesOnUpdate` (`record-rules.ts`) makes an owner reference read-only on updates in both the server pipeline and the browser's `recordSchema`; metadata shows `aggregate: true` on the reference type so the browser knows. An unchanged owner is no write (`unchanged`); a different one is `ReadOnlyField`.
- **Graph checks** (`aggregateProblems`, run on the whole configuration by `validateSnapshot`, like uniqueness): a second owner reference, own or inherited (`aggregateSecondOwner` [judgment: 4.9 names no code]); a cycle (`aggregateCycle`); a chain of more than two owner references, three record levels (`aggregateTooDeep`); an owner reference on or to a platform table (`invalidType`). A part's owner may be of the target class or any descendant, so the chain follows every class of the target's subtree that is itself a part [judgment: the conservative reading].

### Locks (2.2, 4.9)

`aggregate-chain.ts` reads a chain without locks (owner references never change), locks it root first, each owner's root row `FOR NO KEY UPDATE`, and reads it again. Update and delete do this before their own root lock (`lockOwnersOf`; a gone owner is `NotFound`); create does it from the proposed owner reference after the before-write hooks and before validation (`lockOwnersForCreate`; a gone owner, also one deleted concurrently, is `InvalidReference` on the owner reference). An endpoint whose subtree has no owner reference issues no extra statement, so existing statement counts are unchanged. `lockAggregates(members)` locks several aggregates ordered by aggregate root ID, each chain from its root down. On-demand locking needs no extra code: every part save locks its chain. Deadlocks the on-demand order can still cause are retried by the HTTP layer's request retry (3.8).

### The touched set and when finalization runs [judgment]

`aggregate-state.ts` keeps, per transaction attempt (keyed by the transaction handle, like the operation ID and the supplied fields), each touched owner's concrete class, level, status (`touched`, `finalizing`, `persisted`, `clean`, `deleted`), start image (taken when first touched; null when the transaction created it), the concrete classes of its parts that saves wrote (`partsChanged`), the change IDs of those writes and the `once` rules that fired. The pipeline adds to it right after a save's change entry (`noteAggregateWrite`).

Finalization runs at the end of every outermost save outside an **aggregate operation**, and once at the end of `aggregateOperation(effect)`, which runs several saves in one request transaction (a move, a TMF write of an owner and its parts, a batch, a TMF `DELETE` of an owner and its parts). An after-commit effect, whose saves start below its cause chain's depth and are never outermost, finalizes after its actions (`finalizeTouchedAggregates` in `runAfterCommitRule`). Reason: the SQL layer has no typed pre-commit hook that could carry the record service's errors to the caller, and finalizing per outermost save keeps every existing single-save path correct without changes. The cost: two outermost saves of one transaction outside an aggregate operation that write one aggregate end in `AggregateNotSettled` for the second, never in a silent second aggregate version. Writers of several saves (3G's JSON Patch, 3T's TMF adapters, 7.7's `saveBatch`) must use `aggregateOperation`.

### Settling (4.9 step 1, 4.10, 5.10)

`SaveHooks` gained a fourth hook point, `settle`: `RecordRuleSaveHooks` runs `hooks/aggregate-settle.ts` with the instance time zone; `SaveHooks.none` and the outbox-only hooks settle nothing, so without rules finalization still gives every owner whose parts changed its aggregate version. The record service (`aggregate-images.ts`) loads the settling set: each owner's current record and its parts as locked, one shared image per record, so a request item is the same image as a part of its request and as an owner. Passes run each owner's aggregate rules innermost first (deeper level, then ID), in rule order, then the `derive` rules of every image a proposal changed in the pass (`previous` the stored record, `create` for a proposed part, the record's supplied fields). A proposal is a value that differs from the image, or a new part. Pass 3 must propose nothing, else `AggregateNotSettled`. Settling only reads, as system: owners, parts, reference targets and `forEach` records.

- Conditions (`@std/conditions/aggregate`): the record-rule profile on the owner plus `partsChanged`, `anyPart` and `allParts` over part classes of the rule's class. The checked and resolved trees are their own types (`AggregateNode`), never a `CheckedCondition`, so they cannot reach the SQL compiler. Atoms reuse the ordinary checker, resolver and evaluator; a path with `scope: "owner"` is read from the owner's image by a reader that dispatches on the path. `partsChanged.C` is a new AST operator [judgment: 5.10 calls it a synthetic field, but a path holds field IDs only]; its classes count from saves, not proposals. A part condition (quantifier `where`, `setParts.where`) refuses `changed`, a part's `previous` and nested quantifiers [judgment: the parts are not being saved by the user]; `previous` on an owner path reads the owner's start image. Every other profile refuses the new operators with `operatorNotAllowed` and owner paths with `scopeNotAllowed`. The text syntax has no form for them yet [deferral]: such conditions are JSON ASTs, as in set files.
- Actions: `set` on the owner image; `setParts` on matching parts (its `where` evaluated in memory, so unlike decision 0022's SQL `forEach.where` it may follow references, preloaded as system); `createParts` (its `forEach` still compiled to SQL; more than 100 parts is `AggregateNotSettled` [judgment: 4.10 names no error]); `refuse` fails the transaction. `record.f`, `owner.f` and increments read the owner's image. A changed part that owns parts is enrolled and settles from the next pass; an owner that this transaction already persisted cannot be enrolled (`AggregateNotSettled`).
- Definition validation: `setParts` and `createParts` name part classes of the rule's class; `createParts` names no class that owns parts itself [judgment: a proposed part never needs a settling of its own]; no action sets an owner reference except `createEach` [judgment]; the rule's class of `anyPart`, `allParts` and `partsChanged` likewise. `rule_on` edges include the part classes a condition names.

### Persisting and the aggregate save (4.9 steps 2 and 3)

Innermost first: each changed or proposed part not itself in the settling set is saved through the pipeline as the **system effect** `aggregate` in mode `settled`; then each owner whose parts (the change IDs of the transaction's part writes) or derived fields changed gets one **aggregate save** (`UpdateInput.aggregateSave`): never a no-op, its body only the changed derived fields, cause `{"kind": "system", "aggregate": {"reason", "parts", "rules"}}`. An owner with neither is not saved (`clean`), and may be finalized again if a later write touches it. Then the loop picks up owners that after-write rules of these saves touched (cascades). Any failure poisons the transaction.

- The system effect (`systemEffectAccess`): every field nameable and visible, existing reference targets allowed, neither access check refuses, read-only fields writable (owner references stay read-only after create), validation as usual; responses and validation errors keep the acting user's read rights; the saves' after-write rules write as the acting user again (`userAccessOf`). This is the conservative reading of "the proposed-state access check runs on the owner for visibility only": visibility shapes what a response shows (3.9) and refuses nothing [judgment].
- `actor_id` is the operation's acting user; `cause.aggregate.rules` lists the rules that proposed the record's change, so a part a request rule moved names that rule as well as its own.
- A write into an owner already persisted, or into an owner of the settling set by a save other than persistence's own (an after-write rule of a persisted part writing into its own aggregate) [judgment], is `AggregateNotSettled`.

`AggregateNotSettled` is a new `@std/api` error, 422 like `RecordInSave` [judgment: 3.8 lists no status], in every write route's errors. The cause carries `kind: "system"` so that a previous release decodes it as a system change, as decision 0023 did for role bumps.

## Review round 1

1. **Poisoning on every cause.** Finalization poisons the transaction with `Effect.onError`, which runs uninterruptibly on a typed error, a defect or an interruption alike (`poisonOnAnyFailure`), where `tapError` saw typed errors only; an after-commit effect's actions and their finalization are one unit under the same guard, because its saves complete (and join) before finalization starts. A caller that catches a settling defect or a timeout therefore commits nothing.
2. **Responses after finalization.** `createRecord`, `updateRecord` and `deleteRecord` reload the saved record after finalization whenever it settled anything and project it with the acting user's access (`reloadSaved`): the version and values are the committed ones, and a record settling made invisible answers with its ID and version only (3.9). Inside an `aggregateOperation` the saves' results predate finalization; its callers project with `reloadSaved` after it completes.
3. **Errors of system writes.** A system-effect save has no caller body, so `failIfInvalid` treats none of its fields as caller-supplied: errors name only fields the acting user can read on the proposed record, and an error on one they cannot read is `ValidationFailed` with an empty list (3.8). The caller learns only that the aggregate their write touched could not be saved valid. `InvalidReference` from a system write still names its field; settling writes only references copied from records it read, so it arises only for a target deleted in between [judgment].
4. **Live reference targets.** A path a rule follows to a record of the settling set reads that record's settling image, the object proposals change, in every pass; the derive rules settling runs read the same images (`RuleImages.live`). Only records outside the settling set come from SQL, cached for the settling.
5. **Part conditions are their own type.** `checkPartCondition` returns a `CheckedPartCondition` (`stage: "checkedPart"`), resolved by `resolvePartCondition`; neither is a `CheckedCondition` or `ResolvedCondition`, so neither reaches `compileCondition` or `evaluateCondition` by type. Both also refuse owner-scoped paths and quantifier nodes at run time (`owner-scope.ts`), in `compileNodeToSql` too, so a tree taken out of a part condition is a defect, never compiled as the part's own field.

Merging main (3G's `/api/v2`): `AggregateNotSettled` is a declared `422` TMF Error subtype on `/api/v2`; the reference type in table metadata carries `aggregate: true` (v2's `tableMetadata` shows field types as metadata does; its `schema.json` shows no per-field write rules, so nothing more is added there); `/api/v1` shows the three aggregate problem codes as their nearest `v0.0.2` codes (`extendsCycle`, `invalidType`), and its frozen OpenAPI document gains `AggregateNotSettled` among the write 422s, the optional `aggregate` of reference metadata and the aggregate condition members (the `v1-frozen` hash and its list of additions). Persistence evaluates no JSON Patch, so its `PatchTestFailed` is a defect.

## Rolling upgrades (8.8)

No platform migration. `aggregate` on a reference type and the new condition operators are new definition properties (RU11): a release before this one would refuse to decode a stored condition with `anyPart` and would not know owner references. Step 3's upgrade from `v0.0.2` is offline (RU12), and `v0.0.3` ships them, so nothing more is needed now; Step 5's RU11 release tags must list them.

## Tests

| Gate bullet | Test |
| --- | --- |
| owner references never change | `packages/server/test/aggregate-ownership.test.ts#an owner reference is required, and writing a different owner into it is ReadOnlyField` |
| graph checks at definition validation | `aggregate-ownership.test.ts#a second owner reference on a class, a cycle and a fourth level are refused at definition validation` |
| move as delete and create | `aggregate-ownership.test.ts#a move done as a delete and a create in one transaction persists both owners once each` |
| opposite moves at once | `aggregate-ownership.test.ts#two moves in opposite directions at once both complete, with no lost or doubled part` |
| owner deleted concurrently | `aggregate-ownership.test.ts#a part whose owner was deleted concurrently gets InvalidReference` |
| a part write changes the owner's version, history and events | `packages/server/test/aggregate-finalize.test.ts#a part-only change with no derived change still gives one aggregate version, its change entry and its deliveries` |
| owner delete with parts | `aggregate-finalize.test.ts#a delete of an owner with parts leaves the parts' and the owner's delete entries and no aggregate save` |
| `createParts` while settling | `aggregate-finalize.test.ts#settling creates a change's first round of approvals, persisted with one aggregate version` |
| rejected change approval | `aggregate-finalize.test.ts#a rejected change approval cancels the other approvals and rejects the change in one transaction` |
| normal change invalidation | `aggregate-finalize.test.ts#an owner-only edit of planned_start on a scheduled normal change cancels its approvals and moves it to assess` |
| emergency change invalidation | `aggregate-finalize.test.ts#the same edit on an emergency change in authorize, and in scheduled, starts exactly one new round in two passes` |
| spy guard and derive | `aggregate-finalize.test.ts#no guard or derive rule runs on a persisted save, while guards still refuse users and derive values reach the settled image` |
| invariant at persistence | `aggregate-finalize.test.ts#an invariant that breaks on a settled image rolls back the whole transaction, the approver's own write included` |
| request submit, statement log | `aggregate-finalize.test.ts#submitting a request creates the item's approvals while settling, before anything is persisted, then persists approvals, items and request once each` |
| item approval settles item then request | `aggregate-finalize.test.ts#an approval of a request item settles the item and then the request, each persisted once` |
| cascades | `aggregate-finalize.test.ts#cascades: an after-write rule of an aggregate save writes another aggregate, which is finalized in turn` |
| after-commit effects | `aggregate-finalize.test.ts#an after-commit effect's writes into an aggregate are finalized in its delivery transaction` |
| poisoning on every cause (review 1) | `aggregate-finalize.test.ts#a caught defect in finalization and an interrupted settling poison the transaction: nothing commits` |
| responses after finalization (review 2) | `aggregate-finalize.test.ts#a save answers with the committed state after finalization, projected with the caller's read rights` |
| system-write errors (review 3) | `aggregate-finalize.test.ts#a system write's validation errors name only fields the acting user can read` |
| live reference targets (review 4) | `aggregate-finalize.test.ts#a reference a rule follows reads the settling image, also a change an earlier pass proposed` |
| part conditions refused by SQL (review 5) | `packages/conditions/test/quantifier-profiles.test.ts#a part condition's owner paths never reach the SQL compiler or the plain evaluator` |
| `/api/v2` | `packages/server/test/aggregate-v2.test.ts#an owner reference shows in the table metadata, and an aggregate that does not settle is a 422 TMF Error` |
| persisted at most once | `aggregate-finalize.test.ts#a write into an owner this transaction already persisted is AggregateNotSettled, and nothing commits` |
| no fixed point | `aggregate-finalize.test.ts#an aggregate rule that keeps changing a part ends in AggregateNotSettled with nothing committed` |
| aggregate actions and audit | `packages/server/test/record-rule-actions.test.ts#aggregate actions write nothing until persistence, and their change entries name the acting user and the proposing rules` |
| quantifiers only in aggregate rules | `record-rule-actions.test.ts#quantifier-profiles: anyPart, allParts, partsChanged and owner paths are accepted only in aggregate rules, over their own part classes`; `packages/conditions/test/quantifier-profiles.test.ts` |
| quantifier semantics | `packages/conditions/test/aggregate-quantifiers.test.ts#anyPart and allParts with owner paths agree with a naive evaluator` |
| races | `packages/server/test/aggregate-race.test.ts#an update on the version before a racing note is VersionConflict; without one it waits and wins`, `#concurrent notes and ticket updates never deadlock, and every version has exactly one change entry` |

The change, request and ticket shapes are test-fixture classes in the local `site` namespace (`packages/server/test/aggregates-support.ts`) with rules that follow 14.4's for those shapes; no shipped set declares an owner reference yet (3I and Step 4 will).

## Follow-ups

- `aggregate-race-http`: the contract states `aggregate-race` over `/api/v2/helpdeskTicketNote` and a TMF621 `PATCH` with and without `If-Match`. Neither route is on main; once 3G's `/api/v2` and 3I's TMF621 merge, add the HTTP variants on top of the record-service test (an `If-Match` is `expectedVersion`; without it the adapter locks the aggregate and reads the version under the lock, as `patchLatest` does). Every multi-save adapter must run inside `aggregateOperation`.
- Contracts 3.8's error table needs an `AggregateNotSettled` row (422); this workstream may not edit 3.8.
- Text syntax for `anyPart`, `allParts`, `partsChanged` and `owner.` paths (5.10 mentions `owner.f`), with `parse(print(a)) = a`.
- Retiring or purging an owner reference is not handled specially: a retired owner reference stays an owner reference.
- Step 5 RU11 tags: `aggregate` on reference types and the aggregate condition operators.

## Considered

- **A pre-commit hook in the SQL layer** that finalizes once per transaction, whatever saves ran. Rejected for now: the hook's errors (`AggregateNotSettled`, `RuleRefused`, validation) could not reach the caller's typed error channel, and the SQL layer would depend on the record service.
- **Running aggregate rules in the record service directly**, not through `SaveHooks`. Rejected: the record service would import the rule engine (an import cycle through `rule-actions` and the pipeline), and the instance time zone is the hooks layer's.
- **Settle proposals counting toward `partsChanged`.** Rejected: `once` rules rely on `partsChanged` staying fixed within a transaction (4.9).
