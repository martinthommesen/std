<img src="assets/icon.svg" width="64" height="64" alt="">

# STD

STD (a code name) is an open source alternative to ServiceNow: a platform core of generic tables, records, forms, access rules and history that apps sit on. It is at Step 1, the platform core: tables, records, access rules and history work through the HTTP API, with no web app yet. The plan is in [docs/plan.md](docs/plan.md), the contracts in [docs/contracts.md](docs/contracts.md), and the engineering conventions in [docs/architecture.md](docs/architecture.md).

Stack: TypeScript 7 and Effect 4 on Node 26, a pnpm 12 workspace, Postgres 18.

## Quickstart

Requires Docker, bash, curl and jq.

```sh
docker compose up --build                  # Postgres 18, then `std upgrade` once, then `std serve`
examples/quickstart.sh                     # in a second terminal, from the repository root
```

`docker compose up` starts Postgres, runs the one-shot `upgrade` service (`std upgrade`, which applies the platform migrations and loads the core definition set, then `std bootstrap-admin`, which creates the first administrator), and starts the `server` service (`std serve`) on <http://127.0.0.1:8080> once the upgrade has exited 0.

`examples/quickstart.sh` then works through the HTTP API only:

1. It creates the tables `acme.asset` and `acme.laptop` in one change set, and the roles `asset_manager` and `employee` with their access rules in a second one.
2. It creates the users Alice (`asset_manager`) and Bob (`employee`), and Alice adds laptops.
3. It renames the field `serial` to `serial_number` and retires the field `notes`, each in a change set.
4. It signs in as Alice and as Bob and prints what each sees through `/acme.asset` and `/acme.laptop`: Bob sees only his own assets, never their cost.
5. It prints a laptop's history as each of them, and ends with `std doctor`, exiting with its status.

Each step prints a heading, and the script stops at the first failure. You can run it again against the same database: definitions, roles, rules and users are created only when missing, and each run adds and shows its own laptops, tagged with the run's time.

| Setting | Default | Used by |
| --- | --- | --- |
| `STD_HTTP_PORT` | `8080` | compose (host port of the server) |
| `STD_POSTGRES_PORT` | `54329` | compose (host port of Postgres) |
| `STD_ADMIN_LOGIN`, `STD_ADMIN_PASSWORD` | `admin`, `quickstart-admin-password` | compose (the first administrator) and the script |
| `STD_URL` | `http://127.0.0.1:8080` | the script |
| `STD_DOCTOR_COMMAND` | `docker compose exec -T server pnpm --silent std doctor` | the script |

The passwords are disposable demo credentials: set `STD_ADMIN_PASSWORD` for anything but a demo. The server reads `STD_DATABASE_URL`, `STD_HTTP_HOST`, `STD_HTTP_PORT` and `STD_TIME_ZONE` (UTC by default). Upgrades are offline (Contracts 8.5): to run `std upgrade` again, stop the server first, for example with `docker compose down` (the database volume stays) and `docker compose up` again.

The compose image (`docker/quickstart.Dockerfile`) is a development image that runs the TypeScript sources; the release image comes in Step 4. Without Docker, `pnpm quickstart:ci` runs the same script against `std serve` on a disposable database, as CI does.

## Getting started

For development: requires pnpm 12 and Docker. pnpm downloads the pinned Node 26 itself.

```sh
pnpm install     # also patches tsc to report Effect diagnostics
pnpm db:up       # Postgres 18 on 127.0.0.1:54329 (std/std)
pnpm ci:local    # every CI step: lint, tooling checks, type check, tests, canaries, quickstart
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[Apache-2.0](LICENSE). Created in [T3 Code](https://t3.codes).
