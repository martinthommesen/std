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

## Effect 4 idioms

Effect 4.0.5 is installed, but most published Effect material and most model memory is Effect 3. Check every API before you use it: `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/src/` first, then the source at `vendor/effect/packages/*/src` (the `effect@4.0.5` tag) and the v3-to-v4 rename map in `vendor/effect/migration/v3-to-v4.md`.

- Inline code: `Effect.gen(function* () { ... })`. Reusable functions: `Effect.fn("name")(function* (...) { ... }, ...combinators)` (combinators as extra arguments, not `.pipe`), or `Effect.fnUntraced` on hot paths.
- Errors: `class X extends Schema.TaggedError<X>()("X", { ... }) {}`, failed with `return yield* new X({ ... })`, handled with `Effect.catch`, `Effect.catchTag` or `Effect.catchTags`.
- Services: `class S extends Context.Service<S, Shape>()("std/<package>/S") {}` with an explicit `static readonly layer = Layer.effect(S, ...)`. Effect 3's `Context.Tag`, `Effect.Tag` and `Effect.Service` (and its generated `Default` layer) do not exist.
- Renamed from Effect 3: `catchAll` → `catch`, `catchAllCause` → `catchCause`, `either` → `result` (`Either` → `Result`), `zipRight` → `andThen`, `fork` → `forkChild`, `forkDaemon` → `forkDetach`, `async` → `callback`. Schema: `Literal(a)` and `Literals([a, b])`, `Union([a, b])`, `Record(key, value)`, `parseJson` → `fromJsonString`, `filter` → `check(makeFilter(...))`, `transform` → `decodeTo(target, SchemaTransformation.transform({ decode, encode }))`.
- Decode typed input with `Schema.decodeSync` or `Schema.decodeResult`; the `decodeUnknown*` forms are for `unknown` input.
- Unstable modules have no `unstable` path segment: `effect/sql`, `effect/http`, `effect/http-api`, `effect/observability`, and every module of `@effect/sql-pg`, `@effect/platform-node`, `@effect/opentelemetry` and `@effect/vitest`. A package may use them only as its profile allows (`tooling/tsconfig/`, `docs/decisions/0001-effect.md`); `tsc` fails otherwise. Never install `@effect/sql` or `@effect/platform`.
- Plain packages' `src/` import only `Schema`, `SchemaAST`, `SchemaGetter`, `SchemaIssue`, `SchemaParser`, `SchemaTransformation`, `Option` and `Result` from `effect` (`pnpm check:tooling`).
- `tsc` also fails on an un-yielded Effect (`floatingEffect`), an Effect 3 API (`outdatedApi`) and a second copy of `effect` (`duplicatePackage`).
- Tests: `it.effect` from `@effect/vitest`, inside a `describe`; use its `assert` inside `it.effect` bodies (lint flags `expect` there).
