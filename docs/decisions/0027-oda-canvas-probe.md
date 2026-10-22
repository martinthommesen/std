# 0027. The ODA Canvas probe (Step 3, 3K)

Status: accepted, 2026-10-22 (workstream `ws/3k-oda-canvas-probe`). The GitHub measurements are pending: Martin dispatches 10 runs after the merge and fills "Results on GitHub" below. Code: `.github/workflows/oda-canvas-probe.yml`, `deploy/oda/probe/probe.sh`, `deploy/oda/probe-stub/`, `deploy/oda/crds/`, `tooling/oda-canvas-probe-summary.ts` with `tooling/lib/oda-probe-summary.ts`, `tooling/check-oda-component-schema.ts` with `tooling/lib/structural-schema.ts`. Tests: `tooling/test/oda-component-schema.test.ts`, `tooling/test/oda-probe-summary.test.ts`.

The plan's Step 3 gate: "a stub component is deployed on the pinned ODA Canvas on kind in GitHub Actions, and the measurements are committed (time, disk, failure rate over 10 runs). This step's gate needs the measurements, not a green deployment" (3K; Contracts 13.6). The Step 5 Canvas gate (`oda-canvas-deploy`, 5O) is designed from these numbers: its timeouts, its retry budget for infrastructure steps, and whether it fits a public runner's disk.

## What the probe does

`deploy/oda/probe/probe.sh` runs five phases, each in its own subshell with `errexit`, each logged to `logs/<phase>.log`. A failed phase stops the probe; later phases are recorded as skipped. **Nothing retries** (`curl --retry 0`, one `helm install` each), because the probe measures the true failure rate; the Step 5 workflow adds the two infrastructure retries of Contracts 13.6.

1. **`tools`**: downloads kind, kubectl, Helm, cloud-provider-kind, the three Istio charts and the `canvas-oda` chart by pinned URL, checks each SHA-256, and checks that the Component CRD inside the chart is byte-identical to `deploy/oda/crds/oda-component-crd.yaml`.
2. **`cluster`**: `kind create cluster` with the pinned node image (`--wait 600s`), with its kubeconfig in the probe's state directory, then starts cloud-provider-kind in the background.
3. **`istio`**: `istio/base`, `istio/istiod` (`--wait`) and `istio/gateway` (`--wait`, labels `app=istio-ingress`, `istio=ingressgateway`, namespace `istio-ingress` with sidecar injection), exactly the commands of the Canvas's installation guide and CI, then waits up to 5 minutes for the ingress Service's load-balancer address.
4. **`canvas`**: `helm install canvas canvas-oda-1.2.5.tgz -n canvas --create-namespace --set preqrequisitechecks.istio=false --set canvas-vault.enabled=false`, without `--wait` (the Canvas's post-install hooks would deadlock), with `--timeout 1800s` for the hooks; then every Deployment in `cert-manager` and `canvas` must be `Available` and every StatefulSet in `canvas` rolled out, except the secrets-management operator (below).
5. **`component`**: renders the stub chart, validates it on the live API server (`kubectl apply --dry-run=server`, which runs the CRD's schema, CEL rules and the Canvas's webhook), installs it into `components` and polls the Component's `deployment_status` every 5 s, recording each transition, until `Complete` (15 minutes at most).

After a successful run it also requests the exposed API's `openapi.json` through the Canvas gateway at the URL the Canvas published (`status.coreAPIs[0].url`). That observation is recorded but does not decide the outcome: the gate's measure is `Complete`, and the gateway is the Step 5 workflow's first assertion.

`result.json` (schema version 1) holds: the outcome and the failed phase with the last 60 lines of its log; each phase's start, duration, exit code and the disk after it; the component's status transitions; disk before, after, at its peak and after cleanup (the root file system, `df`), plus the kind node's own footprint (its image and its container's writable layer, which do not depend on what else uses the disk); the runner (`ImageOS`, `ImageVersion`, OS, kernel, CPUs, memory); the version of every tool, the Kubernetes server included; the pins; and every container image the cluster ran, with the image ID it resolved to. On failure `logs/diagnostics.log` adds every resource, recent events, the pods that are not ready and the logs of the component, API and identity operators. The cluster is always deleted at the end, with cloud-provider-kind and its load-balancer containers for that cluster only.

The workflow `oda-canvas-probe` runs the script on `ubuntu-latest`, `workflow_dispatch` only (Contracts 13.6: the Canvas runs nightly and on release candidates only from Step 5), `timeout-minutes: 120` against the phases' own limits of about 85 minutes, `permissions: contents: read`, no concurrency group (dispatching 10 at once gives 10 runners). It uploads `result.json` and the logs as the artifact `oda-canvas-probe` whatever the outcome, and the job fails when the probe fails. `pnpm oda-probe:summary [--runs 10]` downloads the artifacts of the last completed runs with `gh` and prints the Markdown for the results section; a run that left no result (cancelled, or killed by the job timeout) counts as a failure.

### Why a shell script [judgment]

The probe orchestrates CLIs (kind, Helm, kubectl, Docker), and its numbers include the runner's disk. A TypeScript probe would need Node and `pnpm install` on the runner first, which costs minutes and about a gigabyte that the measurement would then have to subtract, and the same script must run unchanged on this machine. So it is one Bash script (shellcheck-clean, `set -euo pipefail`, `inherit_errexit`) that needs only bash 5, curl, sha256sum, tar, jq and Docker, all on the runner image. The summary, which runs on a developer's machine, is TypeScript under `tooling/` like the other tooling.

## The stub component

`deploy/oda/probe-stub/` [judgment on the location: `deploy/oda/` is where the architecture puts the ODA chart and Canvas workflow inputs; the real chart is `deploy/oda/std/` in Step 5]. A Helm chart whose templates have no Helm directives, so the files are what `helm template` renders and the schema check below needs no Helm. Its names are fixed (`std-probe`), so one stub fits a namespace; it is installed into `components`, the namespace the Canvas creates and watches.

- **Component** (`oda.tmforum.org/v1`): `componentMetadata` `id` `STD-PROBE`, `name` `std-probe`, `functionalBlock` `Production` (as Contracts 13.1 chooses for STD); one `coreFunction.exposedAPIs` entry, `probe` (`id` `STD-PROBE-API`, `apiType` `openapi`, `apiSDO` `STD`, `implementation` `std-probe-api`, `path` `/std-probe/probe/v1`, port 8080, one `specification` whose URL is the document the stub itself serves, by its in-cluster Service address [judgment: the stub has no published specification]); no dependent APIs, no management or security APIs, no events; `securityFunction.canvasSystemRole` `canvas_system` (the name Contracts 13.2 gives STD's) and two static `componentRole` entries, `probe_reader` and `probe_admin`.
- **The API**: busybox `httpd` from the official image `docker.io/library/busybox:1.38.0`, pinned by its multi-platform index digest `sha256:fd7dc98638c8e305f4dc34e979f1c0fdfdcaeb0fbf8fcff77ae834b6da3d7e6e`, serving a 20-line OpenAPI 3.0 document from a ConfigMap at `/std-probe/probe/v1/openapi.json`. It runs as `nobody`, read-only, with no capabilities, no service-account token and a readiness probe on that path. Istio adds its sidecar.

What `Complete` takes in canvas-oda 1.2.5 (read in the component operator's source at the tag): every exposed API has a URL and a ready implementation (the Istio API operator builds the URL from the ingress's load-balancer address and marks the API ready when the Service has a ready endpoint), the identity operator has configured Keycloak (`identityConfig.identityProvider` set), and there are no secrets-management or dependent-API requests left. Static roles need no TMF672 or TMF669 API: the component operator copies `componentRole` into the `IdentityConfig` (TMFOP003). IG1171 v5.0.0 describes the same split of a component into core, management and security functions with exposed and dependent APIs; the probe relies only on the Canvas's CRD and operators, not on the guide.

### `oda-component-schema` for the stub

`pnpm check:tooling` now runs `tooling/check-oda-component-schema.ts`: the stub's Component must validate against the `v1` schema of the pinned CRD, which must be served and the storage version. The validator (`tooling/lib/structural-schema.ts`) handles the keywords that schema uses (`type`, `properties`, `required`, `items`, `enum`, `minItems`, `x-kubernetes-preserve-unknown-fields`, `x-kubernetes-validations`, and the descriptive ones) and is stricter than the API server in one way: a field the schema does not declare fails, where the server would silently drop it. The schema is decoded with Effect Schema and `onExcessProperty: "error"`, so a keyword it does not handle fails the check, and the CRD's two CEL rules (an exposed API names `apiType`, `implementation`, `path` and `port` at its root or in its first specification; a dependent API names `apiType`) are evaluated by matching their exact text, so a changed rule fails the check instead of passing unchecked. The probe's server-side dry run checks the same component against the real API server, CEL included. It cost one root dev dependency, `yaml` 2.9.1, already in the lockfile as a transitive dependency. Step 5 (5O) replaces the stub's check with the rendered real chart and the 11.1 path and URL rules.

`deploy/oda/crds/oda-component-crd.yaml` is the CRD byte for byte (Apache-2.0; `deploy/oda/crds/NOTICE` gives the source, chart and file hashes). It is a Helm template, so `oxfmt.config.ts` and `lefthook.yml` exclude that directory from formatting, as they exclude `repos/`.

## Pins and where they come from

The Canvas's own CI is `trigger_tests.yml`, whose composite action `.github/actions/run-bdd-tests/action.yml` installs the cluster, Istio and the Canvas; its release workflow `Chart-Releaser-ReleasedChartTester-TrivyScanner.yml` installs the released chart from the chart repository, and `installation/README.md` is the installation guide (all in [tmforum-oda/oda-canvas](https://github.com/tmforum-oda/oda-canvas), `main` read on 2026-10-22).

| What | Pin | Checksum or digest | Source |
| --- | --- | --- | --- |
| Runner | `ubuntu-latest` | recorded per run (`ImageOS`, `ImageVersion`) | plan 3K, Contracts 13.6 |
| kind | v0.23.0 | `kind-linux-amd64` sha256 `1d86e306…4a68c` | upstream action |
| Kubernetes | `kindest/node:v1.30.0` | `@sha256:047357ac0cfea04663786a612ba1eaba9702bef25227a794b52890dd8bcd692e` | upstream action (tag); digest from kind v0.23.0's release notes |
| kubectl | v1.30.0 | sha256 `7c3807c0…b5d1c5` (`dl.k8s.io` `.sha256`) | upstream action |
| Helm | v3.18.4 | `helm-v3.18.4-linux-amd64.tar.gz` sha256 `f8180838…966c1` (`get.helm.sh` `.sha256sum`) | upstream action |
| cloud-provider-kind | v0.10.0 | `cloud-provider-kind_0.10.0_linux_amd64.tar.gz` sha256 `8b88095d…d58b` (release asset digest) | upstream action, which pins v0.10.0 because newer versions broke its load balancer in CI |
| Istio charts | `base`, `istiod`, `gateway` 1.26.3 | sha256 `4176fb64…f0d8c`, `f2df1ac1…779b1`, `2afa5f17…c4988` (Istio chart index) | upstream action pins the gateway chart to 1.26.3 [judgment for the other two, below] |
| ODA Canvas | `canvas-oda` 1.2.5 | sha256 `c16d5f6bbfe0a885d3d06f77f08349c469c52376858e5706002d67ccc9f9d145` (chart index; GitHub release asset) | Contracts 13.5 |
| Component CRD | `oda-crds` 1.3.2 inside the chart | file sha256 `52933790…376ac` | the chart; `deploy/oda/crds/NOTICE` |
| Vault | disabled (`canvas-vault.enabled=false`) |  | Contracts 13.5 |
| Stub image | `busybox:1.38.0` | `@sha256:fd7dc986…7e6e` | Docker Hub official image |
| `actions/checkout` | v5.1.0 | `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09` | ci.yml uses v5 |
| `actions/upload-artifact` | v7.0.2 | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | latest release (Node 24) |

The full hashes are in `deploy/oda/probe/probe.sh`. The probe pins actions by commit SHA, which `ci.yml` and `quickstart-compose.yml` do not yet do (they use major tags); moving them is a separate change.

Differences from upstream, each a [judgment]:

- **Istio 1.26.3 for all three charts.** Upstream pins only the gateway chart and installs `base` and `istiod` unversioned, so its control plane is whatever Istio released last (1.30.7 on 2026-10-22), paired with a 1.26.3 gateway. "Istio as the Canvas CI pins it" (Contracts 13.5) therefore has one reading that is reproducible: 1.26.3 everywhere. Istio 1.26 supports Kubernetes 1.29 to 1.33, so 1.30 is inside its range; upstream's floating control plane, 1.30, supports Kubernetes 1.32 and later and lists 1.30 only as "tested, but not supported" ([Istio supported releases](https://istio.io/latest/docs/releases/supported-releases/), read 2026-10-22). Every Istio release that supports Kubernetes 1.30 (1.22 to 1.28) is past its end of life on 2026-10-22; 1.26 ended on 2025-12-22. That is a consequence of the Canvas's Kubernetes 1.30 ceiling, and a Step 5 risk (below).
- **cloud-provider-kind as the release binary**, checked by SHA-256, instead of `git clone --branch v0.10.0` and `make` (same version; no Go toolchain or build time in the measurement).
- **The released chart, not the Git checkout.** `trigger_tests.yml` installs `./charts/canvas-oda` from its own checkout after `helm dependency update` (it tests the Canvas's `main`); Contracts 13.5 pins the released chart, which upstream's release workflow and installation guide install from the chart repository. The probe downloads the chart archive from the GitHub release the chart index points to and checks the index's digest, so `helm repo add` and the `helm-git` plugin are not needed.
- **`preqrequisitechecks.istio=false`** (sic, the chart's key), as both upstream workflows and the guide's kind section set it, even though cloud-provider-kind gives the ingress an address before the Canvas is installed.
- **Readiness without the secrets-management operator.** With Vault disabled, `canvas-smanop` stays in `CreateContainerConfigError`, as the installation guide says; components that request no secrets management are unaffected. The probe waits for every other Deployment and StatefulSet. Seen in every local run.
- **Waits.** Upstream sleeps fixed times (30 s, 90 s) and then lists resources; the probe waits on conditions with limits (kind 10 min; each Istio chart 15 min; load-balancer address 5 min; Canvas hooks 30 min; Canvas readiness 15 min per namespace; `Complete` 15 min; gateway observation 2 min).

## Local run on this machine

Three runs of the same script on the development machine (16 CPUs, 62 GiB, Ubuntu 26.04.1, Docker 29.9.1), with unique cluster names, tools downloaded into `/tmp`, nothing else touched; each cluster and its load-balancer containers were deleted at the end, and the `kind` network the first run created was removed again. The first run pulled the kind node image; the later runs found it in Docker's cache, but every run pulls the Canvas's images afresh inside a new node. The machine is shared with other agents' builds and tests, so the root file system numbers include their activity; the kind node's own footprint does not.

LOCAL_RESULTS

Findings from the local runs:

- The Canvas came up and the stub reached `Complete` in every run, with its API answering 200 through the Canvas gateway at the published `https://<ingress address>/std-probe/probe/v1` URL.
- `canvas-smanop` is in `CreateContainerConfigError` with Vault disabled, as expected.
- The Canvas's workloads come from 18 Docker Hub images (TM Forum's `tmforumodacanvas/*`, Bitnami's frozen `bitnamilegacy/*` Keycloak, PostgreSQL and `kubectl:latest`, `mongo:6.0`, `busybox:1.35`, Istio), three from quay.io (cert-manager 1.11.0) and the Kubernetes images from registry.k8s.io. The chart pins them by tag, not digest, and two are moving tags (`kubectl:latest`, `mongo:6.0`); the result records the image ID each run resolved, so drift between runs is visible.

## Results on GitHub (10 runs)

To be filled after the 10 dispatched runs: the output of `pnpm oda-probe:summary --runs 10` (run IDs, runner image versions, failure rate and failing phases, median, p90 and max per phase and for the bring-up, disk before and peak, kind node footprint), and the conclusions for Step 5 below.

RESULTS PENDING

## What this means for Step 5 (to confirm with the GitHub results)

- **Timeouts and retries.** The Step 5 workflow's per-phase limits and its two infrastructure retries (Contracts 13.6) should come from the p90 and max above, and the failure phases tell whether retrying the cluster, Istio or Canvas install is the right budget.
- **Disk.** Contracts and decision 0021 note 14 GB of free disk on a public runner against the Canvas's documented 50 GB; the measured peak, and the kind node footprint, say whether STD's image, the CTKs and their containers still fit, or whether the workflow must free disk first.
- **Docker Hub.** Each run pulls about 18 images from Docker Hub anonymously. Rate limiting would show as image-pull failures in the `canvas` phase.
- **End-of-life Istio.** The Canvas supports Kubernetes up to 1.30, and no Istio release that supports 1.30 is still maintained. Upstream works around it by running a current control plane on an unsupported Kubernetes version. Either way the Canvas's mesh in CI gets no security fixes; it is test infrastructure only, but the Step 5 docs must not recommend this combination for production.

## Proposed contract changes (for Martin; not applied)

1. **Contracts 13.5**: name the Istio version. Proposed: "Istio 1.26.3 (`base`, `istiod`, `gateway`), the version the Canvas CI pins for its gateway; the Canvas CI leaves `base` and `istiod` unpinned". Also list cloud-provider-kind v0.10.0 (the Istio API operator needs a load-balancer address before components are installed, or components stay at `In-Progress-CompCon`) and the Canvas values the probe sets (`preqrequisitechecks.istio=false`, `canvas-vault.enabled=false`).
2. **Contracts 13.6, `oda-canvas-deploy`**: with Vault disabled, Canvas readiness excludes the secrets-management operator, and STD's component must not request secrets management.
3. **Contracts 13.6**: the Canvas chart's images are pinned only by tag, some moving; Step 5 should either override them by digest in the workflow's values or record and compare the resolved image IDs as the probe does. The Keycloak, PostgreSQL and `kubectl` images come from Bitnami's frozen `bitnamilegacy` repository, which receives no security updates; worth a known-risk line next to the Canvas's.
