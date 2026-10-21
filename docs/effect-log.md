# Effect measurement log

The measured review of the plan's "Effect" section. Every Effect upgrade PR, every defect whose root cause may be Effect, and every agent PR sent back for Effect reasons adds a row here in the same PR. The thresholds and the upgrade procedure are in `docs/decisions/0001-effect.md`; they are reviewed at every stage gate.

## Upgrades

One row per Effect upgrade PR (runtime packages together, or `@effect/tsgo` alone).

| Date | PR | Packages | From | To | Kind (patch, minor, major) | Engineer-hours | Breakages per allowed module | Allow-list entries removed | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-20 | ws/0a-toolchain | effect and `@effect/*` runtime | none | 4.0.5 | initial | n/a | none | none | Baseline pins; vendored `effect@4.0.5` (7f524e2) |
| 2026-10-20 | ws/0a-toolchain | `@effect/tsgo` | none | 0.54.1 | initial | n/a | none | n/a | Baseline pin with TypeScript 7.0.2 |

## Defects

One row per defect with a possible Effect cause. "Effect root cause" is yes only when the cause is Effect behavior or an Effect API change.

| Date | Issue or PR | Workstream | Completed workstream? | Effect root cause | Module | Summary |
| --- | --- | --- | --- | --- | --- | --- |

## Agent rework

One row per agent PR. "Sent back" is yes when review returned it for Effect 3 idioms or Effect misuse.

| Date | PR | Workstream | Sent back | Reason (Effect 3 idiom, misuse, other) | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-10-21 | ws/1b-config-layers | 1B | no (not reviewed yet) | none | `Effect.fn` with a whole-function transform (`Effect.scoped`) inferred a call signature without parameters for a generator whose parameter has a default; an explicit function type on the constant fixes it, as `runPlatformMigrations` already did |

## Gate reviews

Filled in at each stage gate from the tables above.

| Gate | Date | Upgrade hours (max per patch or minor PR) | Effect defects per completed workstream | Agent rework rate | Threshold crossed | Decision by Martin |
| --- | --- | --- | --- | --- | --- | --- |
| Stage 0 |  |  |  |  |  |  |
