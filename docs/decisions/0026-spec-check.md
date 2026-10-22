# 0026. Spec check of Contracts 10 to 15 against the TM Forum member documents

Status: findings recorded, 2026-10-22 (workstream 3T, branch `ws/3t-conformance-matrix`). The corrections marked "applied" are in this branch, one commit per contract section. Contracts 10 is not edited here: its proposals are routed to workstream 3G. Items under "Needs Martin" change nothing until he decides.

## Why

Decision 0021 and Contracts 10 to 15 were written mostly from public material (TM Forum's document bucket, the `tmforum-apis` repositories, the Canvas source). Martin, a TM Forum member, supplied the member documents on 2026-10-22. This note checks every contract statement, pin, `[unverified]` marker and decision-0021 assumption that those documents can settle.

## Sources

Licence: the TM Forum documents below are member material (RAND). This note and the matrix cite them by document ID, version, section and page, paraphrase them, and quote at most a short phrase. Nothing from them is copied into the repository. The OpenAPI documents are Apache-2.0 and vendored in `packages/tmf/specs/`. The Canvas source is Apache-2.0.

| Label | Document | Version |
| --- | --- | --- |
| TMF630 P1, P4 to P8 | REST API Design Guidelines, parts 1, 4, 5, 6, 7, 8 | v5.0.0, July 2026, pre-production |
| TMF630 v4 P2, P3 | REST API Design Guidelines parts 2 (polymorphism, extension) and 3 (hypermedia), the fallback because v5 parts 2 and 3 are unpublished | v4.0.0 (in the v4.2.0 bundle) |
| TMF621 UG, CP | Trouble Ticket user guide; conformance profile TMF621B | UG v5.0.1; CP cover v5.0.0 (file name v5.0.1) |
| TMF688 spec, CP | Event Management specification; conformance profile TMF688B | v4.0.0, pre-production |
| TMF632, TMF669 UG, CP | Party; Party Role | v5.0.0 |
| TMF672 UG, CP | User Role Permission | v5.1.0 |
| TMF638, TMF639 UG, CP | Service Inventory; Resource Inventory | v5.0.0 |
| TMF641 spec, CP | Service Ordering REST specification | v4.2.0 |
| TMF622 UG, CP | Product Ordering | v5.0.0 |
| IG1171 | ODA Component Definition | v5.0.0 |
| IG1329 | ODA Canvas Definition | v1.1.0 |
| IG1330 | ODA Technical Capability: Identity and Access Management | v2.0.0 |
| GB1008 | ODA Governance, Security and Privacy Architecture Principles | v1.1.0 (cover; some running headers say v2.0.0) |
| CRD | ODA Canvas source extract: `oda-component-crd.yaml` and its child CRDs (oda-crds 1.3.4), design notes, the BDD test kit | main, Apache-2.0 |
| Terms | TM Forum certification contract terms (updated 3 July 2025) and the Open API conformance overview | web pages |
| Kit | The eight CTK zips: their `config.json` and `docker-compose.yaml` were read, nothing was run | as pinned |

Page numbers are the documents' printed page numbers unless a finding says otherwise. Conformance profiles are cited by section title, because their sections are unnumbered.

## Summary

145 findings: TMF630 33 (F630), TMF621 22 (F621), TMF688 10 (F688), the party APIs 21 (F632, F669, F672), the inventory and order APIs 24 (F638, F639, F641, F622), ODA 21 (FODA), and 14 from the matrix work itself (FMX). 19 need Martin; the Contracts 10 changes go to 3G; the corrections to Contracts 11 to 15, decision 0021 and the decision log are applied in this branch; a few design choices are left to the owning workstreams; the rest confirm the contracts as written.

The most important:

1. **Version conflicts are 412 in TMF630 v5, not 409** (F630-01). Part 1 §1.5.3 p.14 makes ETag and `If-Match` a SHOULD, and once used a mismatch MUST be `412` with the current ETag and a missing `If-Match` `428`. STD's v2 answers `409 VersionConflict`.
2. **`tmf-oas-contract` cannot pass as written** (F621-09). STD's `415`, `422`, `428` and `429` are not declared in the TMF621 or TMF688 documents, so every refusal through a TMF route would fail the contract test.
3. **The kit probably tests `troubleTicketSpecification`** (F621-02). The profile does not require it, but the kit ships create and patch payloads for it, and the runner passes a kit only when every test passes. With E20 the TMF621 gate likely cannot pass.
4. **The kit posts `severity: sample_severity`** (F621-04), which 11.2 refuses; TMF621 `severity` is free text.
5. **Event envelopes carry the event type as `@type`** (F621-19, F630-20), with `@baseType` `Event`; 12.1 said `@type` `Event`. Applied.
6. **A refused cancellation is `done`, not `terminatedWithError`** (F641-04, F622-02). In TMF641 v4.2.0 (p.53) and TMF622 (UG p.9), `terminatedWithError` means the assessment failed, not that the cancellation was denied. Applied to 11.5 and 14.4; Martin is told because 14.4's rules were part of the accepted re-plan.
7. **TMF672 POST permissionSet is mandatory and needs `permission[]`** (F672-02), which 11.3 makes `NotRepresentable` without a set.
8. **The ODA Component's `id` and `name` must name a published TM Forum component specification** by the v1 CRD's field descriptions (FODA-01), which STD's custom component cannot.
9. **TMF638's base path is `/tmf-api/serviceInventoryManagement/v5`** by its kit's default URL (F638-04), which 11.1's own rule makes binding. Applied, with `pins.json`.
10. **TMF630 v5 parts 1 and 4 to 8 are published** (Team Approved; Part 1 on 4 September 2025), so the v4.2.0 baseline of decision 1 can be replaced by v5 (F630-32). Needs Martin.

## Needs Martin

Each item changes scope, a pin, an exclusion or a decision he made. Nothing here is applied.

| # | Finding | Question | Recommendation |
| --- | --- | --- | --- |
| M1 | F630-32 | TMF630 baseline. Decision 1 builds on v4.2.0 and has v5 checked by a member before `v0.1.0`. The member has now supplied v5 parts 1 and 4 to 8 (Team Approved, pre-production), and parts 2 and 3 exist only as v4.0.0. | Make v5.0.0 parts 1 and 4 to 8, plus v4.0.0 parts 2 and 3, the baseline for Contracts 10 now; keep the v4.2.0 rows that v5 does not change. The Step 5 item "TMF630 v5 rules checked by a TM Forum member" is then met by 3G's matrix. Changes `pins.json` (TMF630 4.2.0 to 5.0.0) and 3G's file name. |
| M2 | F630-01 | v5 answers a version mismatch with `412` and the current ETag, and a missing `If-Match` (once ETags are used) with `428`. STD's v2 uses `409 VersionConflict`; TMF APIs make `If-Match` optional (E18 covers only the generic API). | v2 and TMF APIs answer `412` for a stale `If-Match`, v1 keeps `409`; record "`If-Match` optional on TMF APIs" as a new exclusion, since the kits send none. |
| M3 | F630-09 | v5 Part 1 §2.5 p.22: resource type names UpperCamelCase, URI segments lowerCamelCase, and no implementation details in names. STD's `/api/v2/{table}` (`helpdesk.ticket_note`) and `@type` `helpdesk.incident` break both. | Keep the qualified names on the generic API (they are what makes it generic) and record a new exclusion; TMF APIs are unaffected. |
| M4 | F621-02 | `troubleTicketSpecification` is optional in the profile (CP, API Mandatory Resources p.2) but the kit carries payloads for it, so its suite very likely tests it; the runner (11.1) passes a kit only when every test passes. | Serve a minimal `troubleTicketSpecification` in Step 3 (list, retrieve, create with `name`, merge-patch, delete; `lifecycleStatus` free text) and withdraw that half of E20. The alternative is a runner rule that tolerates failures the matrix attributes to an unserved optional resource, which gives up the full-suite pass. Read the kit's titles first (see "Kit cases"). |
| M5 | F621-04 | `severity` is free text (OAS has no enum; UG p.8 gives Critical, Major, Minor as examples); 11.2 refuses anything else, and the kit's default payload posts `sample_severity`. | Accept any non-blank severity: the three known values set `impact`, any other value is stored as given and leaves `impact` at its default. |
| M6 | F621-05 | UG pp.73 to 74 lists `ticketType` as patchable; 11.2 makes it read-only after create, and the kit's PATCH payload carries one. | Refuse only a value that would change the concrete class; let any other value update `ticket_type`; record the rest as a deviation. |
| M7 | F621-11 | Merge-patch (RFC 7396) replaces arrays, which clashes with append-only notes (E22) and with parts generally (`relatedParty`). The guide's samples add notes with client-chosen ids and edit them in place. | For arrays of aggregate parts, a merge-patch keeps existing items not named, adds items without a known `id`, and refuses changes to existing notes; record the RFC 7396 deviation in the matrix. |
| M8 | F688-06 | TMF688 defines its own notifications (`EventCreateEvent`, `TopicCreateEvent`, `TopicChangeEvent`, `TopicDeleteEvent`; spec p.17); none is mandatory. Contracts 12.3 offers none. | New exclusion: not offered in v0.1. |
| M9 | F672-02, F672-12 | TMF672 POST `permissionSet` is mandatory and its required input is `user` (with `role`) and `permission[]`; a set reference is not required (CP pp.6, 9, 21 to 22; OAS `PermissionSet_FVO`). 11.3 refuses a PermissionSet without a set as `NotRepresentable` (E23). E23's reason covers only read-only rules, but its refusals also reach two mandatory POSTs. | Accept a `permission[]` that names exactly one role's projected specifications (or a subset) as a grant of that role; refuse anything else as `NotRepresentable`; widen E23's reason and fill its rows. |
| M10 | F641-02, F622-06 | TMF641 `category` is free text (spec p.10, for example a product line) and non-patchable (p.74); 11.5 maps it onto the ITIL change type choice, so a client's "Broadband" is refused. TMF622 `category` is left undefined. | Store `category` as text; carry the ITIL change type as an STD extension attribute defaulting to `normal`. |
| M11 | F622-01 | TMF622 makes DELETE and PATCH of `productOrder` mandatory (CP p.18); 11.5 says nothing about deleting a request. | Allow DELETE of a request aggregate to its requester and admins, as 11.1 describes for TMF deletes. |
| M12 | F622-03 | TMF622 decides acceptance per order (UG p.8: no mix of rejected and acknowledged items), as TMF641 does (spec p.50). 14.4 lets one item be rejected while others proceed. | A rejected item rejects the whole request; otherwise record an exclusion. |
| M13 | FODA-01 | The v1 Component CRD's descriptions of `componentMetadata.id` and `name` say they must refer to a published TM Forum component specification. The schema accepts STD's values. | Record a proposed exclusion and accept it (no golden specification exposes TMF621); the alternative is to omit both fields, which the schema allows. |
| M14 | FODA-07 | Uninstall: 15.2 lists it, 13 has no contract or test (BDD UC002-F004, F006; IG1329 §3.2 to 3.3 p.16). | Add an uninstall contract: the Canvas removes the component's APIs and Keycloak client; the bundled database volume is kept by default, an external database is never touched; add an uninstall case to `oda-helm-lifecycle`. |
| M15 | FODA-10 | GB1008 §5.2.6 p.24 and §5.2.11 p.27 prefer one authentication mechanism as the choke point, with break-glass access as an option; 13.4 keeps password sessions beside OIDC. | In the ODA chart, password sign-in defaults to off when `STD_OIDC_ISSUER` is set; when on, it is logged break-glass access. |
| M16 | FODA-11 | GB1008 §5.2.2 pp.20 to 22 and §5.2.9 p.26 expect data protected in transit (also inside the component) and signed deliverables; nothing in the plan covers TLS to Postgres or image signing. | TLS to Postgres (`verify-full` for an external database) now; sign the release image and chart before `v0.1.0`. |
| M17 | FODA-16 | IG1329 §4.3.1 p.24 lists rolling updates and rollbacks among the bootstrap scenarios (informative). 13.1's offline upgrades and restore-based rollback differ. | Record it as an accepted deviation in the ODA matrix. |
| M18 | F621-09 | Statuses on TMF routes (see the summary, item 2). Not a scope question, but it changes Contracts 3.8's statuses on TMF routes, which Martin approved. | Answer only statuses the pinned document declares: `ValidationFailed` and `InvalidReference` become `400` on TMF routes with the `_tag` kept in `code`, an unsupported PATCH media type `400`; `429` for hub registrations becomes a recorded deviation. |
| M19 | F621-05, F621-06 | Contracts 11.2 keeps `priority`, `statusChangeHistory`, `resolutionDate` and (after create) `ticketType` read-only, although the TMF621 guide lists them as patchable (UG pp.73-74). The new proposed exclusion E26 in the decision log covers the four matrix rows; until Martin decides it, the Step 3 gate fails on them. | Accept E26; the guide itself calls `priority` system-set and `statusChangeHistory` server-populated (p.8), and an unchanged value is not a write. If M6 lets `ticketType` change within a class, drop that row from E26. |

## Proposed changes to Contracts 10 (route to 3G)

Contracts 10 is 3G's; nothing below is applied. `[unverified]` and `[unverified for v5]` markers that the v5 text settles are listed first.

Markers:

- 10.3, `<attr>=<v1>,<v2>` and repeated parameters: `[checked: TMF630 v5.0.0 Part 1 §4.4 pp.57-58]`, and add the third OR form, a semicolon list (F630-10).
- 10.3, `.gt`, `.gte`, `.lt`, `.lte`: `[checked: TMF630 v5.0.0 Part 1 §4.4 pp.58-60]`, and add `.eq` and the URL-encoded forms (`%3E`, `%3E%3D`, `%3C`, `%3C%3D`, `%3D`) (F630-10).
- 10.3, `fields`: `[checked: TMF621 CP v5.0.0, API GET Operation Conformance p.7: every first-level attribute except href]` (F621-17).
- 10.3, `<attr>=<v>`: `[checked: TMF621 CP v5.0.0, Definitions for Filter p.7: filters AND; no particular attribute filter is mandatory]` (F621-17).
- 10.4, both count headers: also cite the TMF688 swagger lists (F688-09); `X-Total-Count` is a SHOULD on lists and a MUST on offset pages (Part 1 §1.5.5 p.15, §4.5.1 p.77; F630-02, F630-12).
- 10.5, PATCH media types: `[checked: TMF621 UG v5.0.1 p.73, CP v5.0.0 p.9: merge-patch mandatory, JSON Patch optional]` (F621-08).
- 10.5, non-patchable list: `[checked: TMF621 UG v5.0.1 pp.73-74: creationDate, href, id, lastUpdate, statusChangeDate, @baseType, @schemaLocation, @type]` and v5 Part 1 §5.2 pp.101-103 (F621-07, F630-17).
- 10 introduction: the definitions of `[unverified]` and `[unverified for v5]` become a citation rule once M1 is decided; the free-login `[unverified]` falls away with v4.2.0 (F630-32).

Changes:

| Finding | 10.x | Contract says | Document says (paraphrase) | Proposal |
| --- | --- | --- | --- | --- |
| F630-01 | 10.5, 3.8 | `409 VersionConflict`; precondition is STD's judgment | Part 1 §1.5.3 p.14: a mismatch MUST be 412 with the current ETag; a missing `If-Match` 428 | M2 |
| F630-03 | 10.5 | `PUT` 405 [judgment: optional] | Part 1 §3.1 p.27 and §5.1 p.101: PUT should not be used, and must not be used to modify | Mark checked |
| F630-04 | 10.5 | `application/json` accepted as merge-patch | Part 1 §3.2 p.28: deprecated in v5, not to be supported in v6 | Note the deprecation |
| F630-05 | 10.4 | no `206` in v4 or v5 | true of the OpenAPI documents only; Part 1 §3.3.1 p.30 and §4.5.2 pp.81-84 keep 206 for range-header paging | Reword: STD offers no range paging, so never answers 206 |
| F630-06 | 10.6 | Error: `code`, `reason` required | Part 1 §3.4 pp.34-35: also `@type`; `status` is a string such as "400-2"; `referenceError` a documentation URL; `@schemaLocation` should be used when extending | Add `@schemaLocation` per `_tag` subtype; `status` a string |
| F630-07 | 10.6 | 3.8 statuses | Part 1 §3.3 pp.29-33 agrees except for version conflicts | none beyond M2 |
| F630-08 | 10.2 | empty fields not addressed | Part 1 §4.1 p.39: an attribute without a value must be left out, never `null` or empty | Empty fields are absent in v2; `withheld` tells restricted from empty; `null` in merge-patch still clears |
| F630-09 | 10.1, 10.2 | qualified table names in paths and `@type` | Part 1 §2.5 p.22 naming rules | M3 |
| F630-10 | 10.3 | `.regex`, `.exact` are `InvalidFilter` | Part 1 §4.4 pp.57-62: `.eq .gt .gte .lt .lte .regex` (MAY), no `.exact`, `.ne` or `.in`; date-only values allowed on date-times; values with commas or semicolons need escaping | Drop `.exact` from the text (it does not exist); keep refusing `.regex` (E17); define escaping |
| F630-11 | 10.3 | `fields` comma list | Part 1 §4.3 pp.50-57: `fields=none`; `!name` excludes; including and excluding the same attribute is 409; `fields` also on POST and PATCH responses; a leading dot escapes attribute names that collide with directives | Add these, or reserve directive names as API names |
| F630-12 | 10.3 | `count=false` drops `X-Total-Count` | Part 1 §4.5.1 p.77: both headers MUST be on offset pages | `count=false` only on cursor pages |
| F630-13 | 10.4 | next-page `Link` [judgment] | Part 1 §4.5.1 p.77, §4.5.3 p.92: `Link` with self, first, next, prev, last on offset pages, self, next, prev on cursor pages | Checked; add the relations |
| F630-14 | 10.3 | paging limits | Part 1 §4.5 pp.75-94: negative offset 400; offset past the end 200 empty; non-positive limit 400; unknown cursor 400; `after` with `before` selects a range | Specify each; choose clamp or 400 for a limit over 1,000 |
| F630-15 | 10.3 | `sort=-a,b` | Part 1 §4.8 p.99: also `+` prefix and dotted paths | Add |
| F630-17 | 10.5 | PATCH | Part 1 §5.2-5.3 pp.101-103, §8.5 p.129: `@type` in a PATCH body, 200 with the full representation, malformed JSON Patch 400 | Accept an unchanged `@type`, refuse a different one |
| F630-18 | 10.5 | POST 201 with `Location`; DELETE 204 | Part 1 §6.1 p.117, §7 p.126: and DELETE must not take a body | A DELETE body is 400 |
| F630-19 | 10.1 | `formStateCheck`, `changeSet` task resources | Part 1 §9.1 p.138, §9.4 pp.146-148: task names are verbs; non-persisted tasks answer 200, persisted ones 201 with `Location` and a `state` lifecycle | `checkFormState` (200) and `applyChangeSet` (201, with `state`) |
| F630-23 | 10.1, 10.4 | `/history`, `ChangeEntry` | Part 1 §12 pp.206-238: optional history pattern with `revision`, `action`, `creationDate`, `revisedBy`, `entity`, `history/{id}` and link relations | `ChangeEntry` with `@baseType` `History` and the TMF attributes added |
| F630-24 | 10.1 | major version in the path | Part 1 §13.1.4 p.240; a minor version may also appear | Mark checked |
| F630-25 | 10.2 | numeric `version` | Part 4 §3 pp.28-33: `version` is the entity version designation (a string), and `?version=` selects a version | Rename STD's counter (for example `revision`); keep it in `ETag` |
| F630-26 | 10.3 | JSONPath `filter` refused with 400 `InvalidFilter` | Part 6 §8 p.53, Part 5 §4 p.9: an unsupported JSONPath must be 501 | 501 (also inside hub queries); E14 unchanged |
| F630-27 | 10 (events) | `eventTime` | Part 7 §4.1 pp.61-63 calls it the occurrence time, Part 1 the notification time | Keep STD's choice as [judgment] |
| F630-28 | 10.2 | EntityRef `id` required | Part 7 §1.4.4 p.16 requires `id` and `@referredType`; the v5 OAS files only `id` | Always emit `@referredType` |
| F630-29 | 10.2 | `createdAt`, `updatedAt` | Part 7 §2.1.3 p.18: a creation timestamp is `creationDate`; examples use `lastUpdate`; no attribute may be named `type` | Rename; reserve `type` |
| F630-30 | 10.2, 11.1 | local subclasses | Part 8 rules 3 and 6 to 9 pp.11-13 support the pattern; `@baseType` is the direct parent; a subclass may not shadow a parent attribute | Add both |
| F630-31 | 10.2 | polymorphic create | v4.0.0 Part 2 §1 p.7, §1.2 p.9: supported; an entity read through another URI declares its own in a header | Add `Content-Location` on reads through a parent endpoint; record `depth` and `expand` as unsupported |
| F630-33 | 10 | none | Part 1: unsupported `Accept` gets the default JSON; rate limits answer 429 with `X-Rate-Limit-*` | Add |
| F621-07, F621-08, F621-17 | 10.3, 10.5 | markers | see Markers | see Markers |
| F688-09 | 10.4 | marker | see Markers | see Markers |

## Applied to Contracts 11 to 15, decision 0021 and the decision log

Each item cites its source in the contract text. Commits: 11.1 and pins, 11.2, 11.3, 11.4 and 11.5 with 14.4, 12, 13, 15, 0021 and the decision log.

- **11.1 pins and base paths** (F638-04, F632-01, F639-03, F622-07, F688-07, F621-22, FMX-01): base paths follow each kit's default `url` in its `config.json`, and TMF688's swagger `basePath`; TMF638 becomes `/tmf-api/serviceInventoryManagement/v5`; the [unverified] markers on TMF669, TMF638 and TMF622 become checked; the OpenAPI `servers` defaults are not the source (none contains `/tmf-api`); the TMF621 labels are checked against the CP cover and the UG release history. `pins.json` matches.
- **11.1 json and array filters** (F621-17): sub-resource filtering is optional in every profile checked.
- **11.2 TMF621** (F621-03, F621-06, F621-10, F621-12, F621-13, F621-14, F621-15, F621-16, F621-18, F621-21): mandatory operations; `status` is a closed enum of eight values that the guide calls an example set; rendering of sub-resources with `@type` and `id`; related parties with `partyOrPartyRole`; attachments' conditional attributes; unknown relationship types kept as given; read-only attributes the guide lists as patchable recorded as deviations; every ticket renders the profile's mandatory attributes however it was created (new test `tmf621-mandatory-output`); events checked.
- **11.3 party APIs** (F632-02, F632-04, F669-01, F669-03, F672-01, F672-03, F672-04, F672-05, F672-06, F672-07, F672-09, F672-10, F672-11): `tradingName` rendering; TMF632 DELETE is mandatory, so the kit deletes parties it created; `permissionSpecificationSet` on a party role specification is an array; PartyRoleSpecification is optional in TMF669; TMF672 PATCH and DELETE are optional; PermissionSet's attribute is `permissionSetSpecification`; `user` and `granter` are related principals with a `role`; PermissionSpecification `name` is mandatory and its details go in `specificationCharacteristic`; a set needs at least one specification; unknown `function` or `action` is refused; TMF672 has no StateChange events for its managed resources; party roles grant no access, unlike the guide's intent.
- **11.4 CMDB** (F638-01, F638-02, F638-03, F639-01, F639-02): `serviceDate`; the full create and response lists; relationship rendering; `software_resource` and `resource_function` extend `logical_resource`; TMF639's profile tables are unrendered placeholders, so its "only `@type`" is cited from the guide.
- **11.5 and 14.4 orders** (Martin should know: 14.4's `cancel-refused` rules, part of the accepted re-plan, now end in `done`) (F641-01, F641-04, F641-05, F641-06, F641-07, F622-02, F622-04, F622-05): item action `other`; a refused cancellation is `done` with the reason, `terminatedWithError` only for internal failures; fields a POST must not set; item state mapping; TMF622 cancellation states have no `accepted` (renders `acknowledged`); `inProgress.accepted` and item `partial` never shown.
- **12 events** (F621-19, F630-20, F630-21, F630-22, F621-20, F688-01 to F688-05, F688-08, F688-09): envelope `@type` is the event type with `@baseType` `Event`; payload per event kind; hub responses; TMF688 operations, topics, events and its conformance profile.
- **13 ODA** (FODA-03, 04, 05, 06, 08, 09, 12, 13, 14, 15, 19, 20, 21): markers; the security API entry; BDD feature IDs and how they run against STD; token claims; published-event entries; API names.
- **15** (FODA-02, FMX-02 to FMX-08): what the ODA rows cover; what `pins.json` holds; `awaitingMatrix`; the row and decision consistency checks; gate mode on missing files and empty steps; `--summary`.
- **0021** (F630-05, F630-10, F630-32 facts only, F621-01, F621-10, F621-21, F688-01, F688-10, F639-04, F622-04, F641-07, F672-11, FODA-17, FODA-18): research findings and the nine-API table corrected; decision 20's "as far as checked" is now checked for both resources.
- **Decision log**: the proposed exclusion E26 (M19) with its four TMF621 rows; E16's reason cites TMF630 v5 Part 1 §4.4.1 p.68 and the profiles (F630-16, F621-17), E24's the TMF688 profile and swagger (F688-08), E20's the TMF621 and TMF641 profiles (F621-01, F641-07); rows filled (FMX-09).

## Proposed, not applied

Design choices the documents leave open; the owning workstream decides.

- F621-09 is M18 above.
- F672-08 (4D): CheckPermission returns 200 when granted and 403 when denied, and nothing holds the deciding rule; the profile is inconsistent about persisting the task. Proposal: do not persist; answer 200 with `state` `done` or 403; put the deciding rule in a characteristic. Revisit if the kit asserts 201.
- F669-04 (4D): PartyRole subtypes (Supplier, Producer, Consumer, BusinessPartner) need a storage and rendering rule.
- F638-06 (4C): `serviceOrderItem` is patchable in TMF638's profile; keep it read-only and say so.
- F641-03 (4O): TMF641 `priority` is free text and TMF622's is "0" to "4"; define the mapping onto STD's priority.
- FODA-04 (5O, partly applied): which field the component operator matches for the security API is not in the extract; the probe confirms it.
- FODA-08 (5S): the Keycloak claim layout and `aud` for users without client roles stay unverified until the probe records a real token.
- FODA-13 (5O): pin the Component CRD from the canvas-oda 1.2.5 package with its oda-crds version and SHA-256 (applied as a requirement in 13.5).
- FODA-14, FODA-15 (5O): applied as requirements; their exact values are 5O's.
- F630-11 to F630-15, F630-19, F630-23, F630-25, F630-29: Contracts 10 (3G).

## Confirmed as written

TMF621's create-mandatory attributes, merge-patch mandatory and JSON Patch optional, the six TroubleTicket events (none mandatory), hub `201`/`200`/`204`, the TMF688 base path and E24's `405` (F621 summary); the TMF632 status enums and required attributes (F632-03); TMF669's free-text status and required attributes (F669-02); no profile among TMF632, TMF669 and TMF672 makes a filter or notification mandatory, so E16 costs no mandatory case there (F632-05); TMF641 and TMF622 make no Milestone, Jeopardy or ErrorMessage event and no cancellation state mandatory, so E21 costs no mandatory case (F638 summary); the 0021 events paragraph; `apiType` `prometheus` on a management API (FODA-21).

## Kit cases

The eight kit zips hold only `README.md`, `run.sh`, `run.bat`, `config.json`, `.env` and `docker-compose.yaml`. The test cases are a Cypress suite inside each kit's Docker image (`tmforumorg/tmf621-v5.0.0-ctk:1.0.1` and so on, recorded in `pins.json`), so the mandatory case titles are not readable without the image. The matrix therefore has one pending `KIT/mandatory-cases` row per kit, and `kitCases` stay empty. The CTK-runner workstream gets the titles in one of two ways: run the kit once (against STD or TM Forum's reference implementation) and read `reports/index.json`; or pull the pinned image by digest and list its spec files without running it. Each mandatory case then becomes its own row with its exact title in `kitCases`. This also settles M4 (whether the kit tests `troubleTicketSpecification`) and F621-20's open point (whether it PATCHes a hub). The kits' default payloads use placeholder values (`sample_severity`, `sample_function`, `sample_action`), so STD's `config.json` must set real values (F621-04, F672-07).

## The matrix tooling (Contracts 15, Step 3)

- **`@std/tmf` is a plain package.** The TMF API framework that grows there (attribute and state maps, TMF630 query translation onto the condition AST, event rendering, payload shapes) is pure functions over definitions and records; routes, record-service calls and every other effect live in `server/http/tmf/` (11.1). So the plain profile fits now and later, and the import check keeps Effect's runtime out of it. Its only module today is `pins.ts`, the schema of `specs/pins.json` (reason recorded in decision 0001).
- **`pins.json` is the single source of pins** (15.1, FMX-02). It names every specification with a matrix file: TMF630, the nine Open APIs, `STD-ITIL@14` and `ODA-Component@v1`, each with the step whose gate first covers it. Open APIs add the base path, the resources STD serves, the vendored OpenAPI document (file, upstream repository and commit, raw URL, SHA-256, licence) and the kit (name, zip URL and SHA-256, image, default URL). The package's tests check every hash, the documents' own versions, and that each base path equals its kit's default URL.
- **The OpenAPI documents are vendored** byte for byte from `github.com/tmforum-apis` at the commit recorded per file. Each repository states Apache-2.0 (its LICENSE file; TMF639 and TMF672 also in `info.license`); there is no NOTICE file. They are excluded from formatting so their hashes hold. All nine are vendored now, because the pins name them; Step 4 workstreams use them as they are.
- **`awaitingMatrix`** [judgment] (FMX-03): Contracts 15.4 fails on a pinned specification without a file, but the TMF630 file belongs to 3G and the Step 4 and 5 files to 4D, 4C, 4O and 5O. A pin may name the workstream that will write its file; outside gate mode the check then prints a note instead of failing, and a gate that covers the specification fails it. When the file arrives, the check notes that the marker can go; remove it in the same merge.
- **Row and decision consistency** [judgment] (FMX-04): beyond 15.4, an excluded row must be listed in its decision's `rows`, and a decision's `rows` must be rows it excludes (rows of a file not yet written are not checked).
- **Row steps** [judgment] (FMX-05): a row may carry `step`, at or after its specification's step, so `STD-ITIL@14` holds Step 3 and Step 4 rows; `--gate stepN` covers rows with a step up to N.
- **Empty specifications** [judgment] (FMX-06): a gate fails a specification of its step whose file is missing or has no rows for the step, so a skeleton cannot pass a gate.
- **Test titles** (FMX-07): only `describe`, `it` and `it.effect` calls whose first argument is a string literal or a template without expressions count; `it.skip`, `it.only`, `describe.skip`, `it.each` and `test` do not [judgment: conservative reading of 15.4].
- **Levels** (FMX-08): rows use the three levels of 15.1. A profile's conditional item (mandatory when its parent is present) is `mandatory`, with the condition in the requirement.
- **Rows** (FMX-09): `TMF621@5.0.1.yaml` 87 rows (CP 29, OAS 53, UG 4, KIT 1), `TMF688@4.0.0.yaml` 48 (CP 22, OAS 26), `STD-ITIL@14.yaml` 46 (Step 3: 14.1, 14.2, 14.3 and the Step 3 rule kinds of 14.4). All are `pending` except 20 excluded: 16 by accepted decisions (E14 1, E15 1, E16 2, E20 9, E22 2, E24 1) and 4 by the proposed E26 (M19). The TMF rows cover the profiles' mandatory and optional items and the OpenAPI documents' operations, status codes, media types, required properties and enumerations; the ITIL rows cite the ITIL 4 practice concept each implements, in STD's words.
- **`--gate step3` fails today** because 161 rows are `pending`, `TMF630@4.2.0.yaml` is not written yet (3G), and 4 rows are excluded by E26, which is `proposed` (M19). It passes when 3G's file lands, every Step 3 row names a passing test, and Martin has decided E26 and the other Needs Martin items that add exclusions.
- FMX-10: the matrix treats TMF621's listener paths as what STD delivers to callbacks (an event body valid against the event schema), not as endpoints STD serves (12.2: STD subscribes to nothing).
- FMX-11: TMF688's profile requires `id` and `href` on events, which its swagger's Event lacks; the matrix follows the profile for responses (F688-03).
- FMX-12: E14 and E15 are TMF630 decisions that also cover TMF621's `filter` parameter and its `json-patch-query` media type; their `rows` now hold those TMF621 rows. 3G adds its TMF630 rows to the same lists, so the two branches touch the same `rows` lines of `decisions.yaml`; the merge keeps both lists.
- FMX-13: the generic API (`STD-API`) has no pin of its own: its rules are TMF630's.
- FMX-14: the TMF639 conformance profile's mandatory-attribute tables did not render in the published PDF (F639-02); 4C takes TMF639's mandatory items from its guide and kit.
