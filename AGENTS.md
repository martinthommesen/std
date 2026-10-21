# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `pnpm exec ultracite fix`
- **Check for issues**: `pnpm exec ultracite check`
- **Diagnose setup**: `pnpm exec ultracite doctor`

Oxlint + Oxfmt (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns
- Avoid import cycles; move shared code into a module both sides import

### Security

- Add `rel="noopener noreferrer"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**

- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**

- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**

- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Oxlint + Oxfmt Can't Help

Oxlint + Oxfmt will catch most mechanical issues automatically. Focus your attention on:

1. **Business logic correctness** - Oxlint + Oxfmt can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Oxlint + Oxfmt. Run `pnpm exec ultracite fix` before committing to ensure compliance.

---

# STD project rules

Read `docs/architecture.md` first. It fixes the toolchain, layout, package boundaries and workflow; `docs/plan.md` and `docs/contracts.md` are the requirements.

- Run everything through pnpm so the pinned Node 26 is used: `pnpm check`, `pnpm fix`, `pnpm typecheck`, `pnpm --filter <pkg> test`, `pnpm check:tooling`. `pnpm ci:local` runs every CI step.
- Postgres 18 for tests: `pnpm db:up` (127.0.0.1:54329, std/std).
- Commit with `git commit -s`. Never use `--no-verify`. Never weaken `oxlint.config.ts` or a tsconfig's strictness or Effect allow lists.

## Frontend: Foldkit

STD's web app (`apps/web`, `@std/web`, Step 2) is built with **[Foldkit](https://foldkit.dev)**, not React. Foldkit is a TypeScript frontend framework built on Effect that uses The Elm Architecture: one immutable Model defined with Schema, a single `update` function, side effects returned as Commands (`Command.define`, each running an Effect), Subscriptions, typed bidirectional routing, and Vite with `@foldkit/vite-plugin`. The React and JSX guidance in the Ultracite section above does not apply to it.

- Before writing Foldkit code, read the docs: `https://foldkit.dev/llms.txt` (index), `https://foldkit.dev/llms-full.txt` (every page), or any page as Markdown by appending `.md` to its URL. Start with get-started, `core/architecture`, `core/routing-and-navigation`, `core/submodel`, `testing` and `ui/overview`.
- Use Foldkit's agent skills (`foldkit`, `generate-program`, `audit-program`; https://foldkit.dev/ai/skills) for Foldkit work, as with the Effect skills below. The web workstream vendors them into `.agents/skills/` (from `repos/foldkit/skills/`) and pins the Foldkit source as a read-only subtree, as recommended at https://foldkit.dev/ai/overview. Import from the installed npm packages, never from the vendored tree.
- **UI components: [Foldkit UI](https://foldkit.dev/ui/overview)** (`@foldkit/ui`, versioned with `foldkit`). Use it for every interactive control instead of hand-rolling one or adding another component library. Its stateful Submodels (Radio Group, Slider, Listbox, Combobox, Dialog, Menu, Popover, Tooltip, Toast, Tabs, Drag and Drop, File Drop, Calendar, Date Picker, Animation, Hover Intent, Virtual List) carry their own Model, Message, `update` and OutMessage; embed them with `h.submodel` and fold their OutMessages into the parent's `update`. Its stateless render helpers (Button, Input, Textarea, Checkbox, Fieldset, Switch, Meter, Progress, Select, Disclosure, Nav) are called directly with a `ViewConfig` and return Html; never turn a render helper into a Submodel. The components are headless: they supply ARIA attributes, keyboard behavior and state, and STD supplies the markup through `toView` and styles them through its own CSS and the components' `data-*` state attributes. Read each component's page (`https://foldkit.dev/ui/<component>.md`) before using it. `@foldkit/ui` 0.169.0 also pins `effect` to exactly 4.0.0 as a peer, so the version note below covers it too.
- **[DevTools](https://foldkit.dev/core/devtools)** stay on in development: `@foldkit/devtools` is a dev dependency of `apps/web`, and `@foldkit/vite-plugin` mounts its overlay (Message timeline, Model, Message, Commands and Mounts tabs, time travel). Keep the default `show: 'Development'`, so production builds carry no overlay and no MCP bridge. Pass the app's `Message` Schema in `Runtime.makeApplication({ devTools: { Message } })` so agents can dispatch Messages.
- **[DevTools MCP](https://foldkit.dev/ai/mcp)** (`@foldkit/devtools-mcp`, registered as the `foldkit-devtools` MCP server for Claude Code in `.mcp.json` and for Codex in its MCP config, run through pnpm so the pinned Node is used) gives agents the running app's state: `foldkit_get_model`, `foldkit_list_messages`, `foldkit_diff_models`, `foldkit_replay_to_keyframe`, `foldkit_dispatch_message(s)` and the rest. When you work on the web app, start `pnpm --filter @std/web dev`, open it in a browser, and use these tools to check what your change actually does to the Model and Messages, alongside story and scene tests. Use the default per-user relay registry; never set a fixed `devToolsMcpPort`, which listens on every interface without a token.
- **No secrets in browser state.** DevTools and its MCP server expose every Model, Message payload and Command argument to whoever is connected, agents included. Session tokens stay in the HTTP-only cookie (`docs/architecture.md`, Sessions) and never enter the Model. A password typed into the sign-in form is held only as Effect `Redacted` (`Schema.Redacted`), unwrapped with `Redacted.value` only where the request is built. `excludeFromHistory` is not redaction. Demo and test data use disposable credentials.
- Test the web app with Foldkit's story tests (`foldkit/story`: dispatch Messages, assert on the Model and Commands) and scene tests (`foldkit/scene`: drive the view through accessible locators). Keep `update` pure.
- Commands and Subscriptions are Effect code, so the Effect skills and idioms below apply to them in full.
- **Effect version: STD stays on 4.0.5 (decided 2026-10-21).** Foldkit's packages pin Effect 4.0.0: `foldkit`, `@foldkit/ui`, `@foldkit/devtools` and `@foldkit/devtools-mcp` as exact peers (`effect`, `@effect/platform-browser`), and `@foldkit/vite-plugin` as hard dependencies (`@effect/platform-node`, `@effect/platform-node-shared`). Moving STD to 4.0.0 was considered and rejected. In 4.0.0, `@effect/sql-pg` and many root modules carry no `@stability` tags, so the unstable-API diagnostics this toolchain relies on (Contracts 9) would stop firing for them. 4.0.0 also lacks fixes STD depends on: `@effect/sql-pg` connection-pin safety and connection-leak fixes, `TestClock` sleeps skipped after scheduler hops, and `Effect.cached` crashes under interruption. The web workstream instead keeps the single 4.0.5 copy that `check-lockfile` and `duplicatePackage` enforce. It sets pnpm `peerDependencyRules.allowedVersions` for the Foldkit packages' Effect peers and `overrides` that resolve the vite plugin's `@effect/platform-node*` dependencies to 4.0.5. It proves Foldkit on 4.0.5 with the app's story, scene and browser tests. It records all this in `docs/decisions/`, and adds `@effect/platform-browser` to the `web` profile's allow list with a reason in `docs/decisions/0001-effect.md`. Drop the overrides as soon as Foldkit releases on 4.0.5 or later.

## Effect skills: always use them

The repo ships Effect agent skills in `.agents/skills/` (linked into `.claude/skills/`, pinned in `skills-lock.json`). **Always use them when you write, change or review Effect code**, in every package, test and script:

1. Load the `effect` skill before touching Effect code (Claude Code: the Skill tool; other agents: read `.agents/skills/effect/SKILL.md`). Then read every `references/*.md` file its branch chooser matches for the task (services and layers, schema, config, scheduling, caching, streams, HTTP clients, testing) before editing.
2. When an API may be an Effect 3 name, or you are unsure it exists in v4, follow the `effect-v3-to-v4` skill's lookup discipline (`.agents/skills/effect-v3-to-v4/SKILL.md`) against `vendor/effect/MIGRATION.md` and `vendor/effect/migration/v3-to-v4.md`: search the reference, never read it whole, and never invent an API.
3. Reviewers check Effect code against the `effect` skill's Core Defaults, Boundary Rules and Do Nots, as well as the rules below.
4. The skills were reviewed against Effect 4.0.0. Where they differ from the pinned 4.0.5 source or from this file, the source and this file win. Plain packages keep their import limits (only the `effect` modules listed below), so skill advice that needs `Data`, `Config`, `Context` or `Stream` applies to `server`, `api`, `web` and tests, not to plain `src/`.

## Effect 4 idioms

This repository uses the Effect TypeScript library. Effect 4.0.5 is installed, but most published Effect material and most model memory is Effect 3. Before writing any Effect code, first read `node_modules/effect/AGENTS.md` **completely**, and follow the links in the file when required. If you need to learn more about particular Effect APIs and concepts that the guide doesn't cover, search the source in `node_modules/effect/src` (also at `vendor/effect/packages/*/src`, the `effect@4.0.5` tag), `node_modules/effect/ai-docs/src/`, and the v3-to-v4 rename map in `vendor/effect/migration/v3-to-v4.md`. Check every API before you use it.

- Inline code: `Effect.gen(function* () { ... })`. Reusable functions: `Effect.fn("name")(function* (...) { ... }, ...combinators)` (combinators as extra arguments, not `.pipe`), or `Effect.fnUntraced` on hot paths.
- Errors: `class X extends Schema.TaggedError<X>()("X", { ... }) {}`, failed with `return yield* new X({ ... })`, handled with `Effect.catch`, `Effect.catchTag` or `Effect.catchTags`.
- Services: `class S extends Context.Service<S, Shape>()("std/<package>/S") {}` with an explicit `static readonly layer = Layer.effect(S, ...)`. Effect 3's `Context.Tag`, `Effect.Tag` and `Effect.Service` (and its generated `Default` layer) do not exist.
- Renamed from Effect 3: `catchAll` → `catch`, `catchAllCause` → `catchCause`, `either` → `result` (`Either` → `Result`), `zipRight` → `andThen`, `fork` → `forkChild`, `forkDaemon` → `forkDetach`, `async` → `callback`. Schema: `Literal(a)` and `Literals([a, b])`, `Union([a, b])`, `Record(key, value)`, `parseJson` → `fromJsonString`, `filter` → `check(makeFilter(...))`, `transform` → `decodeTo(target, SchemaTransformation.transform({ decode, encode }))`.
- Decode typed input with `Schema.decodeSync` or `Schema.decodeResult`; the `decodeUnknown*` forms are for `unknown` input.
- Unstable modules have no `unstable` path segment: `effect/sql`, `effect/http`, `effect/http-api`, `effect/observability`, and every module of `@effect/sql-pg`, `@effect/platform-node`, `@effect/opentelemetry` and `@effect/vitest`. A package may use them only as its profile allows (`tooling/tsconfig/`, `docs/decisions/0001-effect.md`); `tsc` fails otherwise. Never install `@effect/sql` or `@effect/platform`.
- Plain packages' `src/` import only `Schema`, `SchemaAST`, `SchemaGetter`, `SchemaIssue`, `SchemaParser`, `SchemaTransformation`, `Option` and `Result` from `effect`, no Node built-ins or host globals (`process`, `globalThis`, `import.meta`, ...), only their own `src/` files, plain packages and the npm packages in `tooling/plain-allowed-deps.json` (`pnpm check:tooling`).
- `tsc` also fails on an un-yielded Effect (`floatingEffect`), an Effect 3 API (`outdatedApi`) and a second copy of `effect` (`duplicatePackage`).
- Tests: `it.effect` from `@effect/vitest`, inside a `describe`; use its `assert` inside `it.effect` bodies (lint flags `expect` there).
