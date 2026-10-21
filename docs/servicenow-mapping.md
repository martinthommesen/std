# ServiceNow to STD mapping

ServiceNow is STD's feature checklist, not its spec (plan, "Direction"). This file maps ServiceNow concepts to their STD counterparts as features land, so the later migration toolkit and anyone switching knows where things went. Each section names the contracts that define the STD side.

## Configuration layers and upgrades (Contracts 1.8, 1.9, 1.10, 8)

| ServiceNow | STD | Notes |
| --- | --- | --- |
| Update set (`sys_update_set`, `sys_update_xml`) moved between instances | Definition set: a versioned directory of YAML files in git, loaded by `std upgrade` as one change set per set | An install that keeps its own config in git packages it as its own app set (8.1). There is no export of ad-hoc admin changes; changes made in the UI stay local overrides. |
| Store app, scoped app (`sys_app`, `sys_scope`) | App set (owner layer `app`, naming its set) with its own namespace | `requires` replaces app dependencies; the app's namespace is reserved. Sets load core first, then apps in `requires` order. |
| Base system (out of the box) records, plugins | The `core` set, owner layer `core`, mostly protected | Protected core definitions accept only label and help-text overrides (1.8). |
| Customer update (`sys_update_xml` of a customized OOTB record) | Override (`core.config_override`): one row per changed property, with the shipped value at the time (`base_when_set`) | ServiceNow tracks a customized record as a whole; STD tracks single properties, so a shipped change to another property of the same record still applies. |
| Record ownership by `sys_scope`, "Customer" vs "System" changes | Owner layer `core`, `app` or `local` (8.1) | The layer never changes, except `adopt` of a record its set removed. |
| `sys_id` that stays the same across instances | Stable UUID written in the set file (1.1) | Diffs compare by ID only; a missing, duplicate or foreign ID refuses the set. |
| Upgrade "skipped records" (Upgrade History, "Skipped changes to review") | Conflict (`core.config_conflict`) with old shipped, new shipped and local values | A skipped record in ServiceNow means the whole new version was not applied. In STD only the conflicting property keeps the local value; every other shipped change applies. An override whose local value equals the new shipped value is dropped as `converged` instead of being reported. |
| Resolve skipped record: "Retain" / "Revert to base system" / "Merge" | `keep_local` / `take_shipped` / `replace` | `keep_local` also records that the new shipped value was seen (`base_when_set`), so the same conflict does not reopen on the next version unless the shipped value changes again. |
| Upgrade preview, Upgrade Monitor | `std upgrade --plan [--json]` | The plan lists migrations, per-set diffs, conflicts, converged overrides, removals, refusals and a "security changes" section (access rules, roles, permission grants). The real run with `--expect <hash>` applies exactly the reviewed plan. |
| Upgrade that deletes or deactivates OOTB records | Removed upstream: tables and fields retired (never purged), access rules deactivated, roles retired; `adopt` keeps one as local | A role that an active local access rule names refuses the upgrade at plan time; ServiceNow would leave the ACL pointing at a missing role. |
| Upgrade conflicts with a customer-created record of the same name | Name clash refused at plan time, naming the local definition | The admin renames the local definition (by ID, nothing that refers to it breaks) and reruns. |
| Instance upgrade applies platform changes online, node by node | Offline `std upgrade`: servers stopped, refused while a `std-server` session is connected (8.5) | Rolling upgrades need expand-and-contract rules and come later. |
| Instance clone, backup and restore (ServiceNow-operated) | `pg_dump` of the one STD database, restore, `std upgrade`, `std doctor` (8.6) | `docs/runbooks/upgrade-and-recovery.md`. |
| Instance Scan, health checks | `std doctor [--json]` (1.10): 16 read-only checks, exit 0, 1 or 2 | Checks the catalog against the definitions, config layers, journal, dependency index, protected core definitions and server settings; repairs are separate commands. |
| Dictionary entries that do not match the database ("dictionary out of sync") | `doctor` checks 2 to 5 | Missing, extra or mistyped columns, invalid indexes and constraints, orphans (reported, never dropped). |
