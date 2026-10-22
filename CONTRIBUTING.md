# Contributing to STD

Thank you for helping. STD is licensed under [Apache-2.0](LICENSE). There is no contributor license agreement: you keep your copyright and license your contribution under Apache-2.0 by signing off each commit.

## Sign off every commit (DCO)

Every commit carries a `Signed-off-by` line, which certifies the [Developer Certificate of Origin 1.1](https://developercertificate.org/): that you wrote the change or otherwise have the right to submit it under the project's license.

```sh
git commit -s
```

The name and email in the sign-off must match the commit author. To sign off commits you already made, use `git rebase --signoff main`.

## Before you open a pull request

Read [docs/architecture.md](docs/architecture.md) first; it fixes the toolchain, layout, package boundaries and workflow. Agents also follow [AGENTS.md](AGENTS.md).

Run everything through pnpm, so the pinned Node 26 is used. Every pull request must pass the same gates as CI:

| Gate | Command |
| --- | --- |
| Lint and format (Ultracite: Oxlint type-aware and Oxfmt), and a check that the Foldkit lint plugin runs on `apps/web` | `pnpm check` (`pnpm fix` fixes most findings) |
| Tooling checks: tsconfig profiles, Schema-only imports in plain packages, one Effect version in the lockfile, vendored Effect and Foldkit tags (`repos/`) and `FOLDKIT.md` | `pnpm check:tooling` |
| Type check with Effect diagnostics as errors | `pnpm typecheck` |
| Tests against Postgres 18 (start it with `pnpm db:up`) | `pnpm test` |
| Toolchain canaries | `pnpm test:canaries` |

`pnpm ci:local` runs all of them in the order CI does. The pre-commit hook runs `ultracite fix` on staged files. Never commit with `--no-verify`, and never weaken `oxlint.config.ts`, a tsconfig's strictness or an Effect allow list; a lint rule may be disabled only on one line, with `oxlint-disable-next-line <rule> -- <reason>`, when it is genuinely wrong for that line.

Each pull request names its workstream from [docs/plan.md](docs/plan.md) and adds or extends one of that workstream's proving tests, which passes in the same pull request.
