---
name: STD web app
description: A calm, dense, professional service-desk UI over runtime metadata.
colors:
  canvas: "#f3f4f6"
  surface: "#ffffff"
  surface-sunken: "#f7f8fa"
  surface-hover: "#eef1f5"
  sidebar: "#f7f8fa"
  header: "#1d2530"
  header-text: "#f2f4f7"
  header-muted: "#b6bfcb"
  header-hover: "#2c3644"
  text: "#1b2129"
  text-muted: "#55606e"
  border: "#dde1e7"
  border-strong: "#c7cdd5"
  border-control: "#7a8491"
  accent: "#2357c4"
  accent-hover: "#1c469f"
  accent-text: "#ffffff"
  accent-subtle: "#e9effb"
  accent-subtle-text: "#1c469f"
  danger: "#b3261e"
  danger-surface: "#fcebea"
  danger-border: "#ecb4b0"
  danger-solid: "#b3261e"
  danger-solid-hover: "#8f1d17"
  danger-solid-text: "#ffffff"
  success: "#1b6a3a"
  warning: "#7d5200"
  warning-surface: "#fdf3dc"
  warning-border: "#e9cf8f"
  badge: "#eceff3"
  badge-text: "#3a4350"
  dark-canvas: "#111418"
  dark-surface: "#191d23"
  dark-header: "#0c0f13"
  dark-text: "#e5e9ee"
  dark-text-muted: "#a2acb8"
  dark-border-control: "#737e8b"
  dark-accent: "#7ea8ff"
  dark-accent-text: "#0b1426"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, "DejaVu Sans", sans-serif'
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "{typography.body.fontFamily}"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.45
  page-title:
    fontFamily: "{typography.body.fontFamily}"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  section-title:
    fontFamily: "{typography.body.fontFamily}"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.25
  small:
    fontFamily: "{typography.body.fontFamily}"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.45
  mono:
    fontFamily: 'SFMono-Regular, Menlo, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace'
    fontSize: "0.75rem"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  pill: "999px"
spacing:
  "0": "2px"
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-text}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-quiet:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "32px"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
    height: "32px"
  button-danger-solid:
    backgroundColor: "{colors.danger-solid}"
    textColor: "{colors.danger-solid-text}"
    rounded: "{rounded.md}"
    height: "32px"
  button-danger-solid-hover:
    backgroundColor: "{colors.danger-solid-hover}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "4px 8px"
  badge:
    backgroundColor: "{colors.badge}"
    textColor: "{colors.badge-text}"
    rounded: "{rounded.sm}"
    typography: "{typography.small}"
    padding: "0 8px"
  nav-item-current:
    backgroundColor: "{colors.accent-subtle}"
    textColor: "{colors.accent-subtle-text}"
    rounded: "{rounded.md}"
  header:
    backgroundColor: "{colors.header}"
    textColor: "{colors.header-text}"
    height: "48px"
---

# Design System: STD web app

The tokens above are the light theme as `apps/web/src/styles.css` ships it (`:root`); the `dark-*` entries are the dark theme's counterparts of the same names (`@media (prefers-color-scheme: dark)`). The stylesheet is the source of truth; this file describes it.

## Overview

An Operate surface: agents and administrators spend their day in it, opening, changing and creating records. The look is a calm, dense, professional service-desk tool, as Martin's brief pins it: a neutral, cool grey palette with one accent (blue), compact controls, a clear hierarchy, and nothing decorative. The world contributes type, palette, density and one signature move only; navigation, controls and layout are the standard ones of the category: a dark header, a left navigation, dense tables with sortable headers, and two-column forms.

**Signature move: the record bar.** The form's actions live in one floating bar at the bottom of the window, which also carries the record's save state ("Unsaved changes", "Saving…", "Saved.", "Not saved: the reason is at the top of the form."), so the outcome of a save is always where the user just clicked. Save is also Ctrl+S or Cmd+S. Below 48 rem the bar stops floating and closes the form instead (see Layout).

## Colors

Restrained: neutrals and one accent, plus state colours only where they carry meaning.

### Primary

- **Accent** (`accent`, `#2357c4`; dark `#7ea8ff`): primary buttons, links, the current navigation item, the focus ring, pressed toggles and the filter count. Nothing else is blue.

### Neutral

- **Canvas** (`canvas`) behind pages; **surface** (`surface`) for panels, tables and the action bar; **sunken** (`surface-sunken`) for table header rows, the filter panel and the sidebar; **hover** (`surface-hover`) for row and item hover.
- **Header** (`header`, near-black slate): the one dark band, so the shell reads at a glance and the page below stays calm.
- **Text** and **text-muted** for content and secondary text; **border** for separators, **border-control** (3:1 or more) for inputs and quiet buttons.

### State

- **Danger** for refusals and destructive actions, **warning** for notices and unsaved changes, **success** for the action bar's "Saved." Danger and warning have a surface tint for their message boxes.

### Named Rules

- **One accent.** A second hue for emphasis is a state colour or nothing.
- **Badges are neutral.** Choice values (Priority, Status, Category) show as grey badges: their keys and meanings come from metadata, so the UI cannot know which one is "critical".

### Contrast

Measured with the WCAG 2.2 relative-luminance formula for every pair the stylesheet uses, in both themes (a script over the hex values, 2026-10-23): body text 13.9:1 to 16.9:1, muted text 5.6:1 to 8.0:1, accent text on surfaces 5.9:1 to 7.9:1, white on the accent 6.5:1, badge text 8.7:1 and 9.3:1, state text on its tint 5.7:1 to 8.7:1; control borders 3.6:1 to 4.3:1 and focus rings 5.9:1 to 8.9:1 against their surfaces (WCAG 1.4.11).

## Typography

One family: the platform's UI sans, named face by face (San Francisco, Segoe UI, Roboto, Noto Sans, Helvetica Neue, Arial, then DejaVu Sans), with no web-font download. `system-ui` and a bare `sans-serif` are left out on purpose: on a Linux host whose fontconfig has no alias rules, Chromium takes whatever fontconfig substitutes for them, which can be a serif; that is why the earlier UI rendered its body in DejaVu Serif.

### Hierarchy

A fixed rem scale, steps of about 1.15 to 1.2: 12 px (small labels, badges), 13 px (control labels, secondary text), 14 px (body, the default), 16 px (section titles in pages), 20 px (page titles), 24 px (the sign-in title). Weights 400, 500 (labels, buttons) and 600 (headings, current item). Tables use tabular numerals.

## Layout

- **Shell:** a 48 px header (product name, user menu), a 15 rem left navigation, `main` up to 90 rem wide. The navigation comes after `main` in the document (the page's `h1` is first) and is placed left by the grid; a skip link leads to `main`.
- **Navigation:** Home, then each app namespace's tables under its name, then a collapsible Administration group whose open state the browser remembers: its pages first (Dead letters, for whoever may read `core.subscription`), then the `core` tables.
- **Narrow screens (below 48 rem):** the navigation becomes a modal drawer (Foldkit UI Dialog) behind the header's menu button: the page behind it is inert, Tab and Shift+Tab stay inside it, it opens on its first link, and Escape, the backdrop, its close button or a link close it and give focus back to the menu button. Forms go to one column, and the action bar sits at the form's end instead of floating: wrapped at 320 px or at 200 % zoom it was 173 px tall over the fields (review of a4068ab1). The list's table scrolls sideways in its own container and its header row stops sticking.
- **Touch screens (`pointer: coarse`):** controls, navigation rows and sort buttons grow to 44 px. Navigation rows take their height from `--nav-row-height`, which the touch rule sets, so no later rule can undo it.
- **Focus clearance (WCAG 2.2, 2.4.11):** `scroll-padding` keeps a focused control clear of the sticky header and of the floating action bar at the bar's real height (`--action-bar-block-size`, kept by the form while the bar is shown). Browsers scroll only to a control outside the window, so the form also scrolls a focused control that is in the window but under the header or the bar into the clear part.
- **Lists:** one panel: the toolbar (Filter, saved filters, count, page size, pager), the filter builder below it when opened, then the table with a header row that sticks under the app header on wide screens.
- **Forms:** up to 64 rem wide; each layout section is a panel with its fields in two columns, long values (long text, JSON, conditions, write-only fields) across both; the action bar floats at the bottom; related lists and history follow as disclosures. A form opened from a list keeps that list's filter, sort and page size in its address, so "Back to the list", a delete and a create return to the same list.
- **Spacing:** a 4 px grid (`--space-*`); more space between sections than inside them.

## Elevation & Depth

Flat by default. Three shadows only: `--shadow-raised` (panels, a 1 px hint), `--shadow-popover` (menus, pickers, the dialog and the floating action bar), and the dialog's backdrop. No coloured glows.

## Shapes

Radii of 4 px (badges, checkboxes), 6 px (controls, buttons, nav items) and 8 px (panels, popovers, the dialog). Borders are 1 px.

## Components

### Buttons

Foldkit UI Button. Primary (accent, one per view), quiet (bordered), danger (red text, for Delete), ghost (borderless, for toolbars and the saved filters), icon-only (the pager). 32 px high; `data-disabled` dims to 60 %. A pressed toggle (`aria-pressed`) takes the accent's tint.

### Chips

Saved filters are ghost buttons in a group named "Saved filters": "All records" first, then each saved filter; the applied one is pressed. One click applies one.

### Cards / Containers

Panels: surface, 1 px border, 8 px radius, the raised hint. Never nested.

### Inputs / Fields

Foldkit UI Input, Select, Textarea, Checkbox, Combobox, Date Picker. 32 px high, `border-control` borders, the focus ring on the border, `data-invalid` red with an inset line. Labels above, "(required)" in the label, help text and problems below, linked by `aria-describedby`.

### Navigation

Foldkit UI Nav (`aria-current`, `data-current`); the current item takes the accent's tint. The Administration group is a Foldkit UI Disclosure; the narrow screens' drawer is a Foldkit UI Dialog whose header continues the app header's band, with the close button where the menu button was. The navigation is rendered in one place at a time (beside the page, or in the open drawer), so its IDs stay unique. When the browser cannot read, decode or store whether Administration is open, the navigation says so in a status line and the group starts closed.

### Tables

Dense rows (36 px), a sticky header row with sort buttons (`aria-sort` on the header, icons only show it), hover on rows. The first cell's link covers its row, so a click anywhere opens the record and the keyboard and middle-click use the real link.

### The record bar

See Overview. Its status is a live region; "Unsaved changes" and the refusal note are not announced (the alert at the top is). After a refusal, "Show the reason" moves focus to the alert, and so into view.

### Filter

One "Filter" button opens the builder (pressed look while open) and counts the applied conditions. Opened on an empty filter, the builder starts with its first condition, so a field can be picked at once.

### Messages

Alerts (refusals, failures) in the danger tint, notices in the warning tint, at the top of what they are about; the save's outcome in the action bar; the sign-out state in the header.

## Do's and Don'ts

### Do:

- Use the tokens; add one when a value repeats.
- Keep one primary button per view.
- Put a refusal's message where its cause is (the top of the form, or the field).
- Use Foldkit UI for every interactive control and authored SVG icons (`src/view/icons.ts`) for every pictogram.

### Don't:

- Don't use Unicode glyphs or emoji as icons.
- Don't add a second accent, gradients, glass, or coloured side stripes.
- Don't colour choice badges by guessing what a key means.
- Don't put status messages at the bottom of long pages.

## Decisions made in place of a person

No one could answer Impeccable's question rounds during this run (an unattended subagent without a question tool, and no browser to serve the decision page to). These are the choices made instead, each from Martin's brief, `docs/plan.md` and the Operate mode's rules:

- **Direction:** pinned by the brief ("a neutral palette, one accent colour, compact density, a clear hierarchy, and nothing decorative"), so the concept roll (`impeccable concept-seed`, seed:c7b6bb8dbe9ba73b) was recorded but not followed; "a user- or brief-pinned decision beats the roll". Code-led, as every Operate surface is.
- **Light and dark:** both, from the same tokens, chosen by `prefers-color-scheme`: agents work at desks under office light (light by default) and some keep their OS in dark.
- **Header:** a dark slate band rather than a white header, so the shell is unmistakable and the content area stays calm; still neutral.
- **Success after a save:** in the action bar, beside Save, not a Toast. The user's eyes are on the button they pressed; the status stays until the next edit, so it is never missed; a Toast would duplicate the live region.
- **Group name:** "Administration" for the `core` tables, which also fits the dead-letter admin page coming from `ws/3b-dead-letter-admin`.
- **Saved filters:** one button each instead of a select: one click instead of two.
- **Required fields:** keep "(required)" in the label text: explicit, and the accessible name the browser tests use.
- **Badges:** every choice value, neutral grey (above).

## Where Impeccable and the hard constraints differed

- The Operate mode says "a grey screen with one accent colour is the category default without the category's polish"; Martin's brief pins exactly that palette, and the brief wins. Its polish is carried by the dark header band, the record bar and the state colours.
- The craft floor bans a system display face as an own-world display voice; STD's brief asks for the system UI sans and no web-font download, and Operate surfaces permit system faces.
- The finish flow writes `.impeccable/design.json` and surface briefs under `.impeccable/`; the repository rules forbid committing `.impeccable/` runtime state, so neither is committed.
