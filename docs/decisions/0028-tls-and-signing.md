# 0028 — Postgres TLS and signed Step 3 deliverables

Date: 2026-10-22. Owner: Martin. Workstream: 3S. Implements spec-check M16, ODA governance GB1008 §5.2.2 and §5.2.9. The owner requires protection in transit inside the component and signed deliverables in Step 3. The matching plan and contract edits belong to another writer; this change leaves those files untouched.

## Postgres transport

`packages/server/src/sql/tls.ts` is the transport policy. It reads Effect `Config` using the existing environment `ConfigProvider`. The database URL and client key path use `Config.Redacted` (the installed Effect 4.0.5 spelling). Private key contents are read only when building the driver TLS options. Neither URLs nor certificate/key contents are included in TLS diagnostics.

| Setting | Meaning |
| --- | --- |
| `STD_DATABASE_SSL_MODE` | `disable`, `require`, `verify-ca`, `verify-full` |
| `STD_DATABASE_SSL_CA_FILE` | PEM trust anchors; omitted means Node's default roots |
| `STD_DATABASE_SSL_CERT_FILE` | Optional PEM client certificate/chain |
| `STD_DATABASE_SSL_KEY_FILE` | Optional PEM private key; required together with the client certificate |
| `STD_DATABASE_DANGEROUSLY_ALLOW_INSECURE_REMOTE` | Explicit boolean override permitting `disable` on a remote host, with a warning |

[judgment] Use one policy for pooled, reserved LISTEN, dedicated coordinator, CLI, test admin/session and values codec connections, and the tooling wire client. This closes the less obvious paths used by `upgrade`, `doctor`, `bootstrap-admin`, cancellation and the database test harness. Each connection builder enforces it even when a caller supplies an explicit URL.

[judgment] Default to `disable` only for literal `localhost`, IPv4 127/8, IPv6 `::1`, or a Unix socket directory; default to `verify-full` otherwise. Do not infer locality from DNS resolution: a remote hostname resolving to a local address must still authenticate its certificate. Resolve libpq `host` and `port` query overrides consistently with the driver. IPv4-mapped IPv6 and other names are conservatively treated as remote.

[judgment] An explicit STD mode wins over URL `sslmode`; otherwise the URL may choose one of the same four modes before the host default is applied. Reject URL certificate parameters and the ambiguous `ssl` parameter, directing users to the STD settings. Do not support `prefer` or `allow`: mandatory explicit `ssl` options prevent opportunistic plaintext fallback in the driver.

[judgment] `require` encrypts without authenticating the server; `verify-ca` checks its chain but omits hostname checks; `verify-full` checks both the chain and the effective hostname or IP SAN. This gives the requested mode semantics instead of the driver's single boolean SSL setting. Set the minimum protocol to TLS 1.2 and allow TLS 1.3 negotiation. Prefer `verify-full` for production; `require` is a deliberate weaker compatibility choice.

[judgment] Reject disabled remote TLS before any connection or password exchange, even for a direct URL when the pooled URL is local. The deliberately named escape hatch logs a warning about exposed credentials and data. Validate both endpoints in `DatabaseConfig.fromEnv`; retain `Effect.orDie` at the startup configuration boundary so invalid deployment settings stop startup rather than becoming retryable SQL errors. Typed `DatabaseTlsError` diagnostics do not retain raw filesystem/URL exceptions, which can include credentials or paths.

[judgment] `doctor` reports the actual diagnostic backend's `pg_stat_ssl` protocol/cipher as informational check 15. Local plaintext remains compatible with the existing clean exit code; the startup policy rejects remote plaintext unless the operator has explicitly overridden it. This finding describes the observed connection, not a claim that Postgres can report client-side CA policy.

The optional statement-log wire tap already stops at SSLRequest. It cannot observe encrypted statements; production has no tap. TLS harness connections remain encrypted even when tests install a StatementLog. Wire-log assertion suites run on the existing local development database; the TLS suite asserts connection state directly. The tap now also respects Unix sockets and libpq host/port overrides instead of silently dialing the URL authority.

## Compose quickstart

[judgment] Keep `postgres:18` and the existing volume/ports/commands. An entrypoint wrapper generates a throwaway CA and server certificate on first start, including SANs `postgres`, `localhost`, `127.0.0.1`, `::1`. The private server material stays in the Postgres volume (directory 0700, key 0600); the CA private key is deleted after issuance. Only `ca.crt` is copied into a separate public volume, mounted read-only by upgrade and server. Both use `verify-full`. This secures the internal compose connection without distributing private keys to the app.

[judgment] Keep accepting local plaintext on bundled Postgres so existing local development and the previous release's commands continue working unchanged. The application containers always request and verify TLS. The self-generated certificate is a demo trust bootstrap, not a production PKI; production mounts an operator-managed CA and optional client credentials. Its server certificate lasts one year, its CA ten years. To rotate the demo identity, stop the demo, remove its `std-tls` directory and public CA, then restart Postgres and the apps; never remove database data to rotate certificates.

`examples/quickstart.sh` has no changed arguments, credentials interface or wire requests. Existing quickstart/release compatibility checks remain in CI. For an external `STD_COMPOSE_DATABASE_URL`, mount that server's CA at `/std-ca/ca.crt` with a compose override instead of trusting the bundled CA.

## Release signing

`.github/workflows/release.yml` automatically runs only for `v*` tag pushes. A manual invocation defaults to `dry_run=true`; a publishing manual invocation must reference a version tag. It builds the server image, pushes `ghcr.io/martinthommesen/std:<tag>`, signs the immutable digest with cosign keyless signing, and attaches an SPDX SBOM and SLSA build provenance. Both GitHub attestations and cosign's SBOM attestation bind to that same digest.

[judgment] Use GitHub OIDC (`id-token: write`), short-lived Sigstore certificates and transparency log inclusion instead of a stored signing key. Job permissions are only `contents: read`, `packages: write`, `attestations: write`, and `id-token: write`. Disable optional artifact storage records so no `artifact-metadata: write` permission is needed. The verifier pins the exact repository workflow and release tag, not just an issuer or repository owner.

[judgment] A dry run exports an OCI archive, signs the archive and SBOM as blobs, and generates GitHub provenance and SBOM attestations without logging into GHCR or pushing an image, chart or registry attestation. It still contacts OIDC, Fulcio, Rekor and the GitHub attestations/artifacts APIs: this tests the real signing path and saves verification bundles for inspection.

[judgment] Reuse the working quickstart Dockerfile for the Step 3 server artifact. The smaller production image, broader architectures and deployment hardening remain Step 5 packaging work. Do not delay signing until that packaging exists. The Dockerfile's pinned Node/pnpm, lockfile integrity and unprivileged runtime are preserved. Release-only build/sign tools are downloaded at exact versions and checked against fixed publisher SHA-256 hashes in `docker/release-tools.sh`: cosign 2.6.1, Syft 1.33.0, Helm 3.19.0, Buildx 0.31.1. BuildKit 0.26.3 is pinned by OCI index digest. Actions use full commit SHAs with release version comments. Runner-provided shell, curl, checksum utilities and Docker daemon are supplied by GitHub's `ubuntu-24.04` runner rather than downloaded by this workflow.

[judgment] The marked Step 5 hook checks `deploy/oda/std/Chart.yaml`. Until it exists the chart step is skipped. When present it builds chart dependencies, lints, packages, signs the exact `.tgz` with a Sigstore bundle, and pushes only in publishing mode. This uses keyless signatures rather than Helm's OpenPGP `.prov` format, avoiding a new long-lived secret. Signed bundles are retained with workflow artifacts for 30 days; the image signatures, SBOM and provenance also reside in GHCR. Step 5 must define durable chart/bundle distribution.

## Evidence and limits

`pnpm test:tls` creates one uniquely named Postgres 18 container, uses a random loopback port and temporary certificates, waits for the final TCP server (not initdb's temporary Unix-socket server), and removes that container and its fixture on exit. It never invokes compose or touches other containers. The same command runs in CI. TLS tests prove CA and hostname failures, encrypted `require`, pool/LISTEN/dedicated/doctor connections and configured test harness connections. Unit tests prove defaults, remote startup refusal, direct endpoint checks and the explicit override. The TLS fixture also proves optional client certificates, runs the tooling Postgres check and the values codec suite against the configured TLS URL, and checks compose certificate generation and key modes.

Actionlint 1.7.7 is downloaded from the official rhysd/actionlint release outside the repository and verified against SHA-256 `023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757` before validating both workflows. Release tool downloads are independently exercised with a temporary Docker config. No image or tag is pushed in this workstream. Actual OIDC issuance, GitHub attestations and registry publication require a GitHub workflow run; they cannot be exercised as a local signed release.

## Proposed contract text for the coordinating writer

[judgment] Add to the transport/security contract: every STD Postgres connection uses the shared TLS policy. Remote endpoints default to `verify-full` and reject plaintext unless `STD_DATABASE_DANGEROUSLY_ALLOW_INSECURE_REMOTE=true` is explicitly set and warned about. Loopback/socket development may use plaintext. `require` never falls back; `verify-ca` authenticates the CA and `verify-full` also authenticates the target name. `doctor` reports observed encryption.

[judgment] Add to the release contract: Step 3 release images are signed by GitHub OIDC through Sigstore at their immutable digest and carry signed SBOM and build provenance attestations. Verification checks issuer, workflow identity, tag and digest. The Step 5 chart is packaged and signed through the same release workflow once it exists. This makes GB1008's in-transit and signed-deliverable requirements independently testable gates.
