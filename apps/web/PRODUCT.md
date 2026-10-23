# Product

<!-- impeccable:product-schema 1 -->

Every fact below comes from the repository (`README.md`, `docs/plan.md`, `docs/architecture.md`, `AGENTS.md`) or from Martin's brief for the web UX workstream. No interview took place: the agent that wrote this file ran without a question tool, so it stood in for the user and took nothing that those sources do not say.

## Platform

web

## Users

- **Agents** work tickets and incidents in an app built on STD, such as the helpdesk example. The helpdesk's `agent` role sees every ticket but never the internal cost, sees the customer email only on their own tickets, and changes only tickets assigned to them or to no one (`README.md`, "Helpdesk").
- **Administrators** maintain the platform: tables, fields, choices, layouts, roles, access rules and users, all edited through the same generic list and form pages, where writes to definition tables run as change sets (`docs/plan.md`, Step 2).

Both work in the signed-in web app at their desk, in long sessions, and open many records a day.

## Product Purpose

STD (a code name) is an open source alternative to ServiceNow: a platform core of generic tables, records, forms, access rules and history that apps sit on (`README.md`). Long term, companies should be able to switch to STD when ServiceNow no longer fits or costs too much (`docs/plan.md`).

The web app (`apps/web`) is STD's generic UI: list and form pages driven entirely by runtime metadata, so an app such as the helpdesk is built from definitions alone and behaves the same in the browser and the API (`docs/plan.md`, Step 2).

Success for this surface, in Martin's words: "a simple, easy to use and polished enterprise look. That means users want as few clicks as possible to get their job done."

## Positioning

STD copies ServiceNow's functionality, not its look, names, URLs, API or query syntax; it aims at feature parity as a ground-up modern "2.0" without ServiceNow's quirks and tech debt (`docs/plan.md`, "Direction").

## Operating Context

- Common jobs: open a record from a list, change a field such as Status, and save; create a record; filter, sort and page a list; apply a saved filter; read a record's history and related records.
- What the UI shows equals what the API returns for the same caller and filter. A field the caller may not read shows as "Restricted", never as empty, and never reaches the browser (`docs/plan.md`, Step 2 gate).
- A form opened before a relevant definition change is refused with `SchemaChanged`, keeps valid input, marks the changed fields and never resubmits by itself. A version conflict keeps the user's input and offers to reload (decision 0020).
- Users reach the app over a desktop browser; it must also work at phone width (390 px) and with a keyboard only.

## Capabilities and Constraints

- Every table, field, label, choice, layout, saved filter and related list comes from runtime metadata (`GET /api/v1/tableMetadata`). The web app never hard-codes an app's tables.
- Platform tables live in the `core` namespace (`core.class`, `core.field`, `core.user`, ...); app tables in their own namespace (`helpdesk.incident`, `helpdesk.ticket`).
- Stack: Foldkit (The Elm Architecture on Effect 4.0.5) and Foldkit UI's headless components, built with Vite. No React, no other component library, no CSS framework, no web-font download.
- Session tokens stay in an HTTP-only cookie and never enter browser state; the sign-in password is held only as Effect `Redacted`.
- Date-times are shown in UTC, because the browser knows neither the user's nor the instance's zone (decision 0020).
- Undecided: home-page counts, global search and inline list editing need server or API work and are not part of this surface yet.

## Brand Commitments

- The product name shown is "STD" (a code name; `README.md`). The repository icon is `assets/icon.svg`.
- Martin's brief for this workstream: a calm, dense, professional enterprise service-desk tool; a neutral palette with one accent colour, compact density, a clear hierarchy, and nothing decorative.

## Evidence on Hand

- The helpdesk example (`examples/helpdesk`, `pnpm helpdesk:seed`): demo users `admin`, `agent` and `agent2` with disposable demo credentials, five demo incidents, saved filters and form and list layouts.
- Screenshots of the UI before this workstream (outside the repository, not committed).
- There are no customers, testimonials, benchmarks or pricing to show, and none may be invented.

## Product Principles

1. Fewest clicks to the job: the tables a user works in come first, one click to a list, one to a record, one to create.
2. Show exactly what the API returns; never hide a refusal or restriction, and say what went wrong in the place the user is looking.
3. Metadata decides the content; the UI decides only how it is laid out.
4. Familiar enterprise patterns over novelty: a header, a side navigation, dense tables and two-column forms.

## Accessibility & Inclusion

WCAG 2.2 AA: every control reachable and usable by keyboard, visible focus, contrast of at least 4.5:1 for text and 3:1 for control borders, light and dark themes, reduced motion and forced colours respected (decision 0018, "Shell"). Scene tests find elements by accessible role and name.
