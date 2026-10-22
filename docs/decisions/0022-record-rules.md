# 0022. Record rules: definitions, phases, nested saves and the after-commit mapping

Status: accepted, 2026-10-22 (workstream 3A, plan Step 3). Builds on decisions 0009 (the save pipeline's hook points), 0011 (change sets and the dependency index), 0012 (owner layers and overrides), 0013 (the outbox producer) and 0021 (the rule language of Contracts 4.10). Code: `packages/conditions/src/{ast,check,resolve,typed}.ts`, `packages/definitions/src/{rule-definition,rule-references,rule-validation}.ts` and the kind's entries across `@std/definitions`, `packages/server/src/platform/migrations/0011-record-rules.ts`, `packages/server/src/hooks/`, `packages/server/src/records/{save-hooks,save-pipeline,save-stack,write-access,write-access-rules,outbox-producer}.ts`, `packages/api/src/errors/{rule-refused,invalid-transition,record-in-save,hook-depth-exceeded}.ts`.

## Decision

Record rules are config records of a new definition kind, `recordRule`, stored in the platform table `core.record_rule` and written only through change sets (the generic API's definition-table writes included), shipped in sets like every other config record, with `active` as their one overridable property (Contracts 4.10, 8.2). `std serve` saves through `RecordRuleSaveHooks`, which runs `before` rules in pipeline step 5, writes the deliveries of `afterCommit` rules in step 9 next to the outbox producer's, and runs `after` rules in step 10. The `aggregate` phase is declared and validated only; the aggregates workstream (4.9) executes it through the seams below.

## The definition

| Property | Column | Notes |
| --- | --- | --- |
| `classId` | `table_id` | the class it is attached to; it applies to that class and its descendants |
| `name` | `name` | an identifier, unique among the class's live rules (`record_rule_name_live`), so set files and upgrade reports can name it [judgment: 4.10 lists no name; every other named config kind has one] |
| `description` | `description` | optional |
| `phase` | `phase` | `before`, `after`, `afterCommit`, `aggregate` |
| `ruleKind` | `rule_kind` | 4.10's `kind` (`derive`, `guard`, `invariant`); renamed because `kind` is the definition kind of every definition |
| `order` | `sort_order` | order number; ties by stable ID |
| `operations` | `operations` | `create`, `update`, `delete`; none for `aggregate` |
| `condition` | `condition` | a `recordRule`-profile condition (5.10), or null (always holds) |
| `once` | `once` | `aggregate` only |
| `runAsId` | `run_as_id` | `after` only: a user ID (data, so no foreign key, like a subscription's identity) |
| `subscriptionId` | `subscription_id` | `afterCommit` only, required: its carrier subscription (below) [judgment: needed because a delivery row names a subscription] |
| `actions` | `actions` | the ordered actions, JSON holding field and class IDs only |
| `active` | `active` | overridable; an inactive rule never runs |

Set files list rules under `recordRules:` with `table` (a qualified name), `kind`, `runAs` and `subscription` (IDs), and the stored JSON form of `condition` and `actions`, like every condition in a set file. A removed shipped rule is deactivated on upgrade, like an access rule.

### Actions and values

Each action carries its kind in `type`: `set {values}`, `refuse {code, message}`, `setParts {classId, where, values}`, `createParts {classId, forEach, values}`, `updateEach {forEach, target, values}`, `createEach {forEach, classId, values}`. `values` is an ordered list of `{fieldId, value}` (one canonical JSON order). A value is `{value: <canonical JSON>}`, `{ctx: "now" | "me"}`, `{copy: {from: "record" | "owner" | "source", fieldId}}` or `{increment: fieldId}`. Two extensions of 4.10's forms, both [judgment]:

- `copy` with `fieldId: null` is the record's own ID (`record.id`, `source.id`). Without it a rule cannot create a record that refers to the rule's record (a note for its incident) or follow a record to its children; it is allowed only in `updateEach` and `createEach` bodies, since a `before` rule's record has no ID yet on create.
- A `forEach.where` reads the rule's record through `scope: "record"` paths, an extension of the condition AST (5.2): a path with `scope: "record"` may stand only on the right of `eq` to `ge`; it names one field of the rule's record, or with an empty path the record's ID (compared with a reference or uuid field). The checker accepts it only when the caller passes the rule's class (`recordClassId`); the resolver turns it into a literal of the record field's own type, with `eq(f, g)` semantics for an empty value (`f = record.g` is `empty(f)`, an ordering is false); the SQL compiler casts every literal by its own type, so an int8 value compared with an int4 column, or a decimal with an integer, binds as `int8` or `numeric` and Postgres compares exactly (review round 1); the text syntax has no form for it. This is how 14.2's "resolving a major incident resolves its open children" (`parent_incident = record.id`) and 14.3's "linked incidents" are declared.

### Definition validation (`DefinitionInvalid`, code `invalidRecordRule`)

| Phase | `ruleKind` | Actions | `operations` | `once` | `runAsId` | `subscriptionId` |
| --- | --- | --- | --- | --- | --- | --- |
| `before` | required: `derive` (only `set`, never with `delete` [judgment: a delete stores no values]), `guard` or `invariant` (only `refuse`) | `set`, `refuse` | at least one, each once | false | null | null |
| `after` | null | `updateEach`, `createEach` | at least one | false | optional | null |
| `afterCommit` | null | `updateEach`, `createEach` | at least one | false | null | required |
| `aggregate` | null | `set`, `refuse`, `setParts`, `createParts` | none | optional | null | null |

Also refused: no action; a refusal message that is empty or longer than 500 characters; a class, `forEach` class or target class that is not a live class, or is a platform table; a value for a field outside the class it sets or an auto-numbered field; in an active rule, a retired field, whether the rule is new, changed, reactivated or overridden active (an inactive rule may name one, so the field can be retired once the rule is switched off; conditions keep reading retired fields, 5.2); a read-only field in a `before` rule's `set` or a nested save's body (both count as the acting user's write); `keepSupplied` outside a `before` rule; a literal that does not convert under the field's type or names no live choice; `now` outside date-time fields; `me` outside uuid fields and references to users; a copy between different kinds (a reference to the same class or a descendant), of a password or secret, from `owner` outside `aggregate`, from `source` without a `forEach`; an increment whose source is not an integer or big integer field of the same kind as the field it sets (the two are represented differently; at run time an empty source gives 1, any other mismatch is a defect, never a silent 1); a `forEach.where` or `setParts.where` that uses `changed` or `previous` (the records it selects are not being saved) or follows a reference [judgment: it compiles to SQL over the class's own relation; 5.10 allows 3 hops in the record-rule profile, and the rule's own condition keeps them]; an `afterCommit` rule whose carrier is not a live subscription on the rule's class with the rule's operations and no condition of its own, or that shares its carrier with another rule. Conditions are checked in the `recordRule` profile (`invalidCondition`). `aggregate` conditions use the same profile until the aggregates workstream adds `anyPart`, `allParts` and owner paths.

### Dependencies (1.7)

`rule_on` (new): a rule to its class, every class its actions name and its carrier subscription. `rule_writes` (new): a rule to every field its actions set. `condition_reads`: every field its conditions read (record-scoped paths included) and every field a value copies, increments or `updateEach` follows. An active rule keeps the fields it writes from retiring ("an active rule writes it"), and a rule on a table keeps it from being purged, like an access rule or subscription.

## Running

### Selection and order

`selectRules(snapshot, concreteClassId, {phase, operation, kind})`: the rules attached to the concrete class and every ancestor, active and not retired, of the phase (and `before` kind), listing the operation, sorted across the lineage by order number, then stable ID. Selection uses the record's concrete class, so the endpoint never matters (`incident-through-ticket`).

### `before` (step 5)

On a `user` save every `before` rule runs: `derive`, then `guard`, then `invariant`, each kind in rule order, as the acting user (`me`), on the proposed image with `previous` the stored record (all-null on create; on a delete the stored record is both, so `changed` is false). Each `derive` rule sees the values earlier ones set. A `guard` or `invariant` whose condition holds fails the save with its first `refuse` action: `RuleRefused` or `InvalidTransition` (422) carrying the rule's fixed message and nothing else.

Values a `derive` rule sets count as supplied fields (3.9): the existing-state and proposed-state checks see them as written, and validation checks them like body values, `ReadOnlyField` and `DefinitionRetired` included. So a derive rule cannot set a read-only field (refused at definition validation). Review round 1 dropped an earlier exemption for read-only fields set only by rules: Martin decided on 2026-10-22 that TM Forum takes priority over ITIL, so 14.2's priority is writable through every API and shown read-only only by a form rule (3C).

**`keepSupplied`.** The pipeline passes each `before` hook the fields the caller's body named (`BeforeWriteInput.supplied`, the body's keys, whatever their values). A `set` action with `keepSupplied: true` skips every one of them, so an explicit value in the same write wins, even one equal to the stored value; without it the rule's value wins. Settling (4.9) passes no supplied fields. This is the simplest form 14.2's priority rule can use: "set priority from impact × urgency when impact or urgency changes, unless the write names priority" is a derive rule with condition `changed(impact) or changed(urgency)` and a `keepSupplied` set of priority. [judgment, review round 1]

### The seams for aggregates (4.9)

- `SaveInput.mode`: `"user"` (default) or `"settled"`. A settled save runs only `invariant` rules; 4.9's persistence passes it for part saves and aggregate saves.
- `applyDeriveRules({snapshot, classId, operation, image, previous, context})` runs only the `derive` rules on an in-memory image and returns the image and the values set, for settling.

### `after` (step 10) and nested saves

Each `after` rule whose condition holds on the save's images runs its actions in order. A `forEach` selects records of its class and subclasses as system, in stable ID order, with its `where` compiled to SQL (record-scoped paths resolved to literals); `updateEach` saves each selected record (`target: "self"`, through the `forEach` class's endpoint) or the record its reference names (`target: {via}`, once per target, an empty reference skipped [judgment]) at the version just read; `createEach` creates one record per selected record. Bodies name fields by their current names, so access rules, unknown-field rules and validation apply exactly as to a client's body. Every nested save records `cause` `{kind: "hook", hookId: <rule ID>, parentChangeId}` and shares the operation ID.

Nested saves go through `Transactions.request`, which joins the running transaction and never issues `SAVEPOINT` (the SQL layer refuses it); a nested save that fails after writing poisons the transaction, which then never commits even if hook code catches the failure (the existing SQL-layer guarantee, 4.1). The save stack (`SaveStack`) now carries a depth: each save checks it first, and a save nested more than 8 deep is `HookDepthExceeded` [judgment: the outermost save plus 8 nested levels]. `RecordInSave` and `HookDepthExceeded` moved into `@std/api` as 422 errors [judgment: Contracts 3.8 lists no status; both are configuration loops the caller cannot fix by retrying], and the write routes list them with `RuleRefused` and `InvalidTransition`; a delete can now also end in `ValidationFailed` or `InvalidReference` from its rules' nested saves.

### Identities and `rules.run_as`

An `after` rule without `runAs` acts as the acting user, so its writes are refused exactly as the user's own (`record-rule-actions`). With `runAs`, and for an `afterCommit` rule (its carrier's identity), the nested saves run as that user with the roles they hold now: `WriteAccess` gained `forActor(actor)`, which rebuilds the access layer for that identity [the rule-based layer captured its actor when built].

The permission is checked twice [judgment: the conservative reading of "succeeds only if the rule's author holds `rules.run_as`"]:

1. At definition time: a local change set that leaves a rule active with a run identity other than the requester (a new or changed rule, or a changed carrier subscription) needs `rules.run_as` (`PermissionRequired`, 403). Set loads are exempt: installing a set is the operator's act, and its rules are trusted like its access rules.
2. At run time: a local rule's author is the user of the change entry of its current definition version; if the run identity is not the author and the author no longer holds `rules.run_as`, the rule fails closed with `NotAllowed`. A rule shipped in a set is trusted.

Running as oneself needs no permission. Deactivating a rule needs none either.

### No HTTP client in transactions

`SaveHooksApi`'s three hook points declare their environment: `beforeWrite` `SqlClient | Actor`, `deliveries` `SqlClient | CurrentTransaction | Actor`, `afterWrite` `HookEnvironment` (the record service with the acting user). None includes `HttpClient`, so a hook that calls out does not type-check (`record-rules` asserts it at type level).

## `afterCommit` rules: subscription and delivery (for 3B and 3H)

1. **Carrier.** An `afterCommit` rule names its carrier, a `core.subscription` on the rule's class that lists the rule's operations and has no condition of its own. One rule per carrier. The carrier provides the identity, `maxAttempts`, dead-letter policy and `enabled`; its own condition and class never decide what it receives.
2. **Producing (step 9, this workstream).** The outbox producer never matches a carrier (`ruleCarriers` excludes every subscription an `afterCommit` rule names). Instead `afterCommitCarriers` evaluates each active `afterCommit` rule of the concrete class's lineage that lists the operation, with its record-rule condition on the save's own images (`previous` included, as save time is the only time both are known), and `writeDeliveries(input, carried)` inserts one ordinary `core.delivery` row for each matching rule's carrier that is active and enabled (a disabled carrier gets nothing, like any disabled subscription; review round 1), in the save's transaction, ordered by subscription ID with the plain matches. Ordering, fencing and dead letters are those of every delivery (4.6, 4.7).
3. **Running (3B's worker).** For a claimed delivery whose subscription is a carrier (`ruleCarriers(snapshot).has(subscriptionId)`), the worker opens its delivery transaction with `Transactions.request`, provides the record service (`Catalog`, `WriteAccess` for the subscription identity or any base layer, `SaveHooks` = `RecordRuleSaveHooks`, `WriteOnlyValues`, `InstanceSettings`), runs `runAfterCommitRule({subscriptionId, changeId})` and then its fenced `done` update in the same transaction. The executor requires `CurrentTransaction`, so it cannot run outside one.
4. **What the executor does.** It finds the carrier's active rule (none: outcome `noRule`, the delivery is done); loads the change entry; reads the rule's record as it is now (the delete entry's `before` image for a delete; outcome `recordGone` when an updated record was deleted since [judgment]); checks the author's `rules.run_as` (above); runs the actions as the carrier's identity with `cause` `{kind: "after_commit", subscriptionId, parentChangeId: changeId}`, at a save-stack depth one past the triggering change's cause chain (a recursive walk of `core.change.cause ->> 'parentChangeId'`), so the 8-level cap holds across after-commit hops. Any failure fails the delivery transaction: the worker rolls back and retries with backoff, then dead-letters.
5. **Not built here.** The worker loop, claims of carriers, external calls (afterCommit rules have none: their actions only write through the record service, so their effects are exactly once with `done`).

## Tests

| Test | File |
| --- | --- |
| rule order and determinism, concrete-class selection through any endpoint | `packages/server/test/record-rules.test.ts#rule-order: by order number then stable ID, selected by the concrete class` |
| derive values validated as supplied fields, `keepSupplied` on create and update | `record-rules.test.ts#derive values count as supplied and are validated; keepSupplied leaves the caller's values alone` |
| retired fields and active rules | `record-rules.test.ts#an active rule never writes a retired field, reactivated or not; conditions may still read it` |
| guard, invariant, settled mode, `applyDeriveRules` | `record-rules.test.ts#guard and invariant refuse with the rule's fixed message; a settled save runs only invariants` |
| nested saves, cause, operation ID, no `SAVEPOINT` | `record-rules.test.ts#after rules save other records as nested saves in the same transaction, without SAVEPOINT` |
| after-write rollback, poisoning, `RecordInSave` | `record-rules.test.ts#after-write rollback: a failing after-write rule rolls back everything, nested saves included, even when hook code catches the failure` |
| depth cap | `record-rules.test.ts#HookDepthExceeded: rules nest saves at most 8 deep, and nothing commits` |
| afterCommit production and executor | `record-rules.test.ts#afterCommit rules: a delivery to their carrier only when they match, run in the caller's transaction as its identity` |
| field rename | `record-rules.test.ts#renaming a field that a record rule reads and writes keeps the rule working` |
| no HTTP client | `record-rules.test.ts#in-transaction hooks get no HTTP client` |
| phase and action matrix | `record-rule-actions.test.ts#each action kind is accepted in the phases that allow it and refused in the others`, `#every other illegal combination is DefinitionInvalid` |
| access rules on after actions | `record-rule-actions.test.ts#after actions are refused by access rules exactly as the acting user's own write` |
| run-as identity | `record-rule-actions.test.ts#a run-as rule runs as its identity only while its author holds rules.run_as` |
| concrete class over the parent endpoint | `incident-through-ticket.test.ts#a rule on helpdesk.incident refuses resolving an incident through helpdesk.ticket without resolution notes` (`/api/v1`; the `/api/v2` variant follows 3G) |
| record-scoped paths | `packages/conditions/test/record-scope.test.ts` |

## Considered

- **An afterCommit rule that evaluates its condition at delivery time** on the subscription's own deliveries. Rejected: a record-rule condition reads `previous` and `changed`, and at delivery time only the change entry's changed fields remain, so the version's full images cannot be rebuilt cheaply.
- **A `rule_id` column on `core.delivery`**, several rules per subscription. Rejected for now: it changes 3B's table while 3B is being built; one carrier per rule keeps per-rule retry state too.
- **An action-level `match` list** instead of record-scoped paths in `where`. Rejected: 4.10 says `where` reads `record.<field>`; the AST extension keeps one condition language and its checker.
