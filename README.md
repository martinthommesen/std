<img src="assets/icon.svg" width="64" height="64" alt="">

# STD

STD (a code name) is an open source alternative to ServiceNow: a platform core of generic tables, records, forms, access rules and history that apps sit on. It is at Stage 0, the architecture spike; nothing is usable yet. The plan is in [docs/plan.md](docs/plan.md), the contracts in [docs/contracts.md](docs/contracts.md), and the engineering conventions in [docs/architecture.md](docs/architecture.md).

Stack: TypeScript 7 and Effect 4 on Node 26, a pnpm 12 workspace, Postgres 18.

## Getting started

Requires pnpm 12 and Docker. pnpm downloads the pinned Node 26 itself.

```sh
pnpm install     # also patches tsc to report Effect diagnostics
pnpm db:up       # Postgres 18 on 127.0.0.1:54329 (std/std)
pnpm ci:local    # every CI step: lint, tooling checks, type check, tests, canaries
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[Apache-2.0](LICENSE). Created in [T3 Code](https://t3.codes).
