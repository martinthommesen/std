# Contracts 14 surface checklist

This checklist defines the scope of `STD-ITIL@14/C14/14.1/every-surface`. It covers the incident and problem behaviors in Contracts 14.1–14.3 and the shared ticket derives and rule execution of 14.4. It does not certify a release, the later change/request/CMDB practices, or licensed ITIL guidance. The matrix tests STD's own profile; the licensed ITIL edition review remains a separate requirement. ITIL® is a registered trademark of the PeopleCert group.

## Sources and applicability

- `docs/contracts.md`, 14.1–14.3, the Step 3 rule kinds in 14.4, and the `itil-incident`, `itil-problem`, `itil-labels` and `form-vs-api` acceptance bullets. The plan's Step 3 gate and workstream 3I require the same surfaces.
- TMF621 User Guide v5.0.1, printed page 2, the original lifecycle diagram: acknowledged → inProgress/rejected/cancelled; inProgress ↔ held/pending, inProgress → resolved/cancelled; pending → cancelled; resolved → inProgress/closed; rejected, cancelled and closed are final. Contracts 11.2 specifies the many-to-one mappings to STD states, including problem state groups. Rewriting a status in its existing group preserves its concrete state.
- TMF621 Conformance Profile, the local v5.0.1-named PDF whose document identifies the profile as v5.0.0: printed pages 8–9 require description, severity, ticketType and @type on create and specify no mandatory PATCH attributes. The pinned v5.0.1 OAS, recorded in `packages/tmf/specs/pins.json`, defines writable priority, resolutionDate and characteristics. The local original PDFs and extracted text are the source receipts; they are not copied into STD.
- Decisions 0021 (34 and 53), 0026, 0034, 0035 and 0036 establish TMF precedence, supplied-field provenance, state groups, configured cascades, and form-only constraints. Decisions 0022 and 0029 specify user guards, changed settling images and settled persistence. No decision is reopened here.

An API-allowed write stays allowed even when the form requires, hides or locks a field. Access rules still apply. Browser tests use the real server, independent API reads and the shipped form-state verdict, rather than a client copy of the business rules. API tests use the shared HTTP definition or the TMF621 test client, which validates responses against the pinned OAS.

## Checklist

The row names below omit the common `STD-ITIL@14/C14/` prefix. Test labels refer to the exact references in the next section. Existing per-row matrix references remain part of the proof; this checklist adds the missing surface assertions.

| Matrix rows / rule | Generic API | TMF621 | Browser |
| --- | --- | --- | --- |
| 14.1/shipped-configuration; priority-cell-override | Existing local-rule replacement test in the matrix; S6 checks all nine cells after replacement | S6 checks the replacement cell and every unchanged cell, independent numeric/readable priorities and retained major flag | Existing local-cell form verdict/PATCH/GET test, including preserved API flag |
| 14.1/concrete-class | Existing parent-endpoint test | Existing incident/problem state-group tests and S3 read through Ticket | B4 saves an incident from the Ticket form and compares parent/concrete reads |
| 14.1/tmf-over-itil; 14.2/form-vs-api | Existing form-vs-api tests | Existing form-vs-api tests | Existing incident/problem required-field tests; B1/B2 preserve the distinct browser path |
| 14.2/impact-urgency; nine priority cells; priority-explicit-wins; priority-form-read-only | Existing all-nine and explicit/same-value/JSON Patch provenance tests | Existing severity/urgency all-nine and explicit/same-value/JSON Patch provenance tests | Existing explicit nine-cell verdict/create/GET oracle; priority has no writable browser control |
| 14.2/states and every incident transitions row | Existing exhaustive generic state-pair matrix | Existing every-status-write matrix | B1: every pair of the six states, including unchanged states, 422 InvalidTransition, unchanged full stored record and revision on refusal |
| 14.3/states and every problem transitions row | Existing exhaustive generic state-pair matrix | Existing every-status-write matrix, including acknowledged and inProgress groups | B2: every pair of the eight states. From new, only new/assess/canceled are offered; the five other targets are absent and issue no write. All offered pairs save or return InvalidTransition without a stored change |
| 14.2/hold-reason, also inherited by Problem | Existing hold/default/explicit/clear tests; S3 | Existing held/pending and explicit-reason tests | Existing incident/problem hold/default/explicit/required/no-write/clear test; B1/B2 check hold and exit results |
| 14.2/resolution-required | Existing API resolve without details | Existing TMF resolve without details | Existing required/error/success tests and B3 |
| 14.2/resolved-at | Existing supplied-date/default/reopen/closed test; S3 | S3 checks explicit resolutionDate, reopen clearing and closed retention for all three classes | B1/B2 check reopen clearing, retained resolution fields, exact closed date and unchanged-state dates; B3/B4 check server-derived dates omitted from browser writes |
| 14.2/major-incident-role | Existing manager/agent access test | S5 refuses agent write, unchanged full record; existing manager success test | Existing manager/agent controls, correction and retained-flag notices |
| 14.2/major-incident-priority; major-incident-tmf621 | Existing priority edits retain flag | Existing manager characteristic/rendering/priority-retention test | Existing manager/agent tests and overridden-cell test |
| 14.2/major-incident-filter | Existing shipped-filter metadata/list assertion | There is no TMF named-saved-filter operation; its records expose the major characteristic | B7 checks the exact selected IDs across all six incident states, excluding the non-major child |
| 14.2/major-incident-children | S1 checks all six child states, unrelated incident and ordinary parent | S1 triggers via TMF621 and reads every child through both APIs, including resolution details/date | B5 triggers via Save, reads and opens all six children, checks identical copied resolution/date, terminal records, unrelated record and ordinary parent |
| 14.3/known-error-workaround; known-error-any-state | Existing every-state permissiveness test | Existing create/PATCH permissiveness test; S4 checks all eight concrete states | Existing empty-workaround refusal/success test; B8 checks no-write refusal then saved known error in all eight states |
| 14.3/root-cause-required | Existing fix/resolved writes without rootCause | Existing inProgress-group preservation and resolved-without-rootCause test | Existing fix and resolved required/error/success tests; B2 exercises permitted fixing/resolving transitions with details |
| 14.3/incident-link | Existing reference writes and cascade fixtures | Existing causedBy relationship test | B7 selects and saves both Problem and Parent incident, then independently reads and reopens them |
| 14.3/resolve-returns-incidents | S2 partitions all incident states, four hold reasons, other problem and no problem | S2 triggers via TMF621 and reads every case through both APIs | B6 triggers via Save; reads and opens every case, resumes exactly awaiting_problem, clears hold, never resolves a linked incident automatically |
| 14.4/ticket-derive-short-description; ticket-derive-status-changed-at | Existing title/date test and S3 | S3 checks bounded Unicode first-line titles, inherited defaults, and status-change dates against independent stored dates for all three classes | B3 creates Ticket, Incident and Problem, checks the saved Unicode title/defaults; B1/B2 check status-date changes and retention for unchanged status |
| 14.2/transition-guards-kind; 14.3/transition-guards-kind; 14.4/guards-users-only | Existing settled-save, record-rules and aggregate-finalize tests distinguish changed-image derives from persistence | Ordinary TMF writes and cascades use the same engine, covered by S1/S2 and lifecycle tests | Ordinary saves and cascades use the same engine, covered by B1/B2/B5/B6. There is no browser or TMF input exposing internal settled-save mode |

## Inherited ticket rules

Ticket owns description/title, priority, impact, urgency, resolution and status dates and the common form rules. Incident and Problem inherit these. The hold default/clear derives attach separately to Incident and Problem; a plain Ticket has no ITIL transition guard or hold default (decision 0035). S3 asserts that distinction rather than requiring new behavior.

B3 checks the inherited form-state read-only flags for priority, resolvedAt, statusChangedAt, ticketType, statusChangeHistory, severityLabel and priorityLabel on all three classes, and checks that none has an editable control. Some are omitted by the shipped layout. The Ticket layout omits hold and resolution fields; its portion of B3 stops after creation/default/title/lock observations. The Incident and Problem portions additionally exercise the inherited required description, hold reason, resolution code and resolution notes. B4 uses already stored resolution details when saving from the parent layout. This is not a claim that omitted controls can be edited.

Existing form-vs-api tests independently prove that UI-locked fields stay API-writable. Status dates are server-derived on status changes; explicit resolution dates remain writable. Existing ticket-part ownership and author tests remain authoritative for Contracts 3.2/4.9 and the access clarification in 14.2; no ticket-part behavior changes here. Description's schema-required/SQL NOT NULL follow-up, service-assigned read-only metadata and the manager's assignment limitation remain as recorded in decision 0034 and Contracts 14.2.

## Exact added test references

All browser references below have prefix `apps/web/test/browser/`.

- **B1:** `itil-lifecycle.test.ts#every incident browser state pair saves or refuses without changing the stored record, including reopen and closed dates`
- **B2:** `itil-lifecycle.test.ts#every problem browser state pair respects Assess choices or saves or refuses without changing the stored record`
- **B3:** `itil-lifecycle.test.ts#ticket forms and both subclasses inherit title derivation, defaults, locked fields and hold and resolution form rules`
- **B4:** `itil-lifecycle.test.ts#an incident saved from the parent Ticket form keeps its concrete priority and derives its resolution date`
- **B5:** `itil-cascades.test.ts#resolving a major in the browser resolves exactly its open children with the same resolution and leaves terminal and unrelated records unchanged`
- **B6:** `itil-cascades.test.ts#resolving a problem in the browser resumes only its awaiting-problem incidents and never resolves an incident automatically`
- **B7:** `itil-cascades.test.ts#browser incident links persist their parent and problem and the open-major filter lists exactly open major states`
- **B8:** `itil-lifecycle.test.ts#a known error can be saved from every problem state while the browser requires its workaround`
- **Live:** `itil-lifecycle.test.ts#development DevTools report the saved hold default and its removal after browser resume`

All server references below have prefix `packages/server/test/itil-surfaces.test.ts#`.

- **S1:** `generic and TMF621 major resolution select every open child and preserve all terminal and unrelated records`
- **S2:** `generic and TMF621 problem resolution resume exactly linked awaiting-problem incidents across every incident state and hold reason`
- **S3:** `ticket derives and API-writable resolution dates hold for tickets, incidents and problems through both APIs`
- **S4:** `TMF621 known-error writes preserve every concrete problem state without requiring a workaround`
- **S5:** `TMF621 refuses an agent's major flag write without changing the record`
- **S6:** `a local priority replacement changes only its cell through both APIs and TMF621 retains the major flag`

The `Live` test starts a development Vite server over a disposable database, drives actual browser create/resume saves, reads the saved Model through DevTools MCP, checks the form/save Messages, and compares the final independent API read. Story/scene tests continue to cover the pure update/view and command interfaces; these tests add cross-surface acceptance evidence without changing them.

## Limits of this checklist

Exact running assertions and source applicability justify the umbrella row; test-title discovery alone does not. This checklist adds no matrix exclusion. The remaining TMF630 gate backlog, fresh external CTK/remote CI, licensed ITIL edition review, and release completeness approval are separate facts. Local CI does not establish any of those external results.
