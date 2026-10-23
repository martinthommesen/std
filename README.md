<img src="assets/icon.svg" width="64" height="64" alt="">

# STD

STD (a code name) is an open source alternative to ServiceNow: a platform core of generic tables, records, forms, access rules and history that apps sit on. It is at Step 1, the platform core: tables, records, access rules and history work through the HTTP API, and the web app (Step 2) has its foundation: sign-in, the signed-in shell and sign-out. The helpdesk example (below) is Step 2's app: tables, choices, layouts, saved filters and an agent role, defined as an app set. The plan is in [docs/plan.md](docs/plan.md), the contracts in [docs/contracts.md](docs/contracts.md), and the engineering conventions in [docs/architecture.md](docs/architecture.md).

Stack: TypeScript 7 and Effect 4 on Node 26, a pnpm 12 workspace, Postgres 18.

## Quickstart

Requires Docker, bash, curl and jq.

```sh
docker compose up --build                  # Postgres 18, then `std upgrade` once, then `std serve` and `std worker`
examples/quickstart.sh                     # in a second terminal, from the repository root
```

`docker compose up` starts Postgres, runs the one-shot `upgrade` service (`std upgrade --set examples/helpdesk/v2`, which applies the platform migrations and loads the core definition set and the helpdesk example; then `std bootstrap-admin`, which creates the first administrator; then `pnpm helpdesk:seed`, the helpdesk's demo users and incidents), and starts the `server` service (`std serve`) on <http://127.0.0.1:8080> and the `worker` service (`std worker`, the outbox worker that runs after-commit effects; decision 0023) once the upgrade has exited 0. Open <http://localhost:8080> in a browser and sign in as the administrator, as `admin` or `agent` from the helpdesk (below), or, after the script below, as `alice` or `bob`; the web app keeps its session in an HTTP-only cookie.

`examples/quickstart.sh` then works through the HTTP API only:

1. It creates the tables `acme.asset` and `acme.laptop` in one change set, and the roles `asset_manager` and `employee` with their access rules in a second one.
2. It creates the users Alice (`asset_manager`) and Bob (`employee`), and Alice adds laptops.
3. It renames the field `serial` to `serial_number` and retires the field `notes`, each in a change set.
4. It signs in as Alice and as Bob and prints what each sees through `/acme.asset` and `/acme.laptop`: Bob sees only his own assets, never their cost.
5. It prints a laptop's history as each of them, and ends with `std doctor`, exiting with its status.

Each step prints a heading. Every refusal it shows is checked for its exact status and error tag, and so are the facts it prints; anything unexpected stops it with `FAILED`. You can run it again against the same database: definitions, roles, rules, users and their role assignments are created only when missing (an existing user's password is never changed), and each run adds and shows its own laptops, tagged with the run's time.

| Setting | Default | Used by |
| --- | --- | --- |
| `STD_HTTP_PORT` | `8080` | compose (host port of the server) |
| `STD_POSTGRES_PORT` | `54329` | compose (host port of Postgres) |
| `STD_ADMIN_LOGIN`, `STD_ADMIN_PASSWORD` | `administrator`, `quickstart-admin-password` | compose (the first administrator) and the script |
| `STD_URL` | `http://127.0.0.1:8080` | the script |
| `STD_DOCTOR_COMMAND` | `docker compose exec -T server sh docker/quickstart-entrypoint.sh pnpm --silent std doctor` | the script |
| `STD_HELPDESK` | `1` | compose (`0` leaves the helpdesk example out) |
| `HELPDESK_ADMIN_PASSWORD`, `HELPDESK_AGENT_PASSWORD`, `HELPDESK_AGENT2_PASSWORD` | `helpdesk-admin-demo-password`, `helpdesk-agent-demo-password`, `helpdesk-agent2-demo-password` | compose (the helpdesk's demo users) |

The passwords are disposable demo credentials: set `STD_ADMIN_PASSWORD` (and `QUICKSTART_ALICE_PASSWORD`, `QUICKSTART_BOB_PASSWORD`) for anything but a demo. The script never puts a password or a session token into a command's arguments. The server reads `STD_DATABASE_URL`, `STD_HTTP_HOST`, `STD_HTTP_PORT`, `STD_TIME_ZONE` (UTC by default), `STD_WEB_ROOT` (the built web app; this checkout's `apps/web/dist` by default) and `STD_SESSION_COOKIE_SECURE` (`auto`, `always` or `never`; see docs/decisions/0018-web-foundation.md). Upgrades are offline (Contracts 8.5): to run `std upgrade` again, stop the server first, for example with `docker compose down` (the database volume stays) and `docker compose up` again.

The compose image (`docker/quickstart.Dockerfile`) is a development image that runs the TypeScript sources; the release image comes in Step 4. Without Docker, `pnpm quickstart:ci` runs the same script against `std serve` on a disposable database, as CI does. It needs Linux and `strace`: it traces every program the script starts and fails if a password reaches any program's arguments.

Postgres TLS settings are `STD_DATABASE_SSL_MODE` (`disable`, `require`, `verify-ca`, `verify-full`), `STD_DATABASE_SSL_CA_FILE` (PEM CA), `STD_DATABASE_SSL_SYSTEM_ROOTS` (explicit public-root opt-in for `verify-full`), and optional paired `STD_DATABASE_SSL_CERT_FILE` / `STD_DATABASE_SSL_KEY_FILE`. Remote hosts default to `verify-full` and require a CA or explicit system roots; `verify-ca` requires a CA. `require` with a CA verifies the chain; without a CA it can be intercepted by anyone on the path. Unix sockets ignore TLS modes; loopback defaults to plaintext. Remote `disable` requires the warned `STD_DATABASE_DANGEROUSLY_ALLOW_INSECURE_REMOTE=true` opt-out. Environment mode wins over URL `sslmode`; URL certificate and `ssl` parameters are refused. Settings and files are loaded once when configuration layers start.

The compose quickstart uses a separate `quickstart-postgres` service and data volume with a generated CA; `pnpm db:up` still starts the unchanged shared development database. Existing data in the shared volume is not moved into the new quickstart volume. For external `STD_COMPOSE_DATABASE_URL`, pass the TLS variables above and mount the certificate files with a compose override. Bundled CA settings apply only to the bundled URL. See [release verification and TLS configuration](docs/runbooks/verify-release.md).

## Helpdesk

`examples/helpdesk` is the Step 2 example app (decision 0019): tickets and incidents (an incident is a ticket), auto-numbered `TKT0000001` and `INC0000001`, with status, priority, category and impact choices, an assignee, form and list layouts, saved list filters and an `agent` role. `docker compose up` loads it with demo data, so you can sign in at <http://localhost:8080> right away:

| Login | Password (disposable demo credential) | Role | What it shows |
| --- | --- | --- | --- |
| `admin` | `helpdesk-admin-demo-password` | built-in `admin` | everything, including each ticket's internal cost |
| `agent` | `helpdesk-agent-demo-password` | `agent` | every ticket, but never the internal cost; the customer email only on the agent's own tickets; changes only tickets assigned to the agent or to no one |
| `agent2` | `helpdesk-agent2-demo-password` | `agent` | the same, for a second agent who owns two of the incidents |

Set `HELPDESK_ADMIN_PASSWORD`, `HELPDESK_AGENT_PASSWORD` and `HELPDESK_AGENT2_PASSWORD` before the first `docker compose up` to use your own; the seed never changes an existing user's password. `STD_HELPDESK=0 docker compose up` leaves the helpdesk out. It does not clash with `examples/quickstart.sh`, which uses its own namespace, roles and users.

The set has two versions, `v1` and `v2` (the current one, which compose loads). Without Docker, against your own database: `pnpm std upgrade --set examples/helpdesk/v2`, then `pnpm helpdesk:seed`. Tests load it with `helpdeskTestLayer()` from `@std/testing/helpdesk-fixture`, which the web app's browser tests use too.

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
