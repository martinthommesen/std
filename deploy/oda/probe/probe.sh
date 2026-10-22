#!/usr/bin/env bash
# The ODA Canvas probe (Contracts 13.6, docs/decisions/0027-oda-canvas-probe.md).
#
# Creates a kind cluster with Kubernetes 1.30, installs Istio and the pinned
# canvas-oda chart the way the Canvas's own CI does, deploys the stub
# component (deploy/oda/probe-stub/) and waits for it to reach `Complete`.
# It measures every phase and writes one JSON result, whatever happens:
#
#   $PROBE_OUT_DIR/result.json   phases and durations, disk, runner, tool
#                                versions, outcome, failing phase and log excerpt
#   $PROBE_OUT_DIR/logs/         one log per phase, diagnostics on failure
#
# Nothing retries: the probe measures the true failure rate. Each phase is
# bounded by its tools' own timeouts (kind --wait, helm --timeout, kubectl
# wait, polling deadlines). The workflow .github/workflows/oda-canvas-probe.yml
# runs it on GitHub; a local run needs bash 5, curl, sha256sum, tar, jq and
# Docker, and touches nothing outside its own cluster, its own containers and
# the directories below (kubeconfig and Helm settings stay in the state
# directory, never in ~/.kube or ~/.config/helm).
#
# Settings (environment variables, with defaults):
#   PROBE_OUT_DIR        results and logs          ./oda-canvas-probe-out
#   PROBE_TOOLS_DIR      downloaded tools, charts  $PROBE_OUT_DIR/tools
#   PROBE_CLUSTER        kind cluster name         std-oda-probe-<time>-<pid>
#   PROBE_KEEP_CLUSTER   1 keeps the cluster       0
#
# Exit status: 0 when the component reached `Complete`, 1 otherwise.
set -euo pipefail
shopt -s inherit_errexit

# --- Pins (docs/decisions/0027-oda-canvas-probe.md, "Pins") -----------------
# kind, its node image and kubectl as the Canvas's run-bdd-tests action pins
# them; the node image by the digest kind v0.23.0's release notes publish.
readonly KIND_VERSION=v0.23.0
readonly KIND_SHA256=1d86e3069ffbe3da9f1a918618aecbc778e00c75f838882d0dfa2d363bc4a68c
readonly KIND_NODE_IMAGE=kindest/node:v1.30.0@sha256:047357ac0cfea04663786a612ba1eaba9702bef25227a794b52890dd8bcd692e
readonly KUBECTL_VERSION=v1.30.0
readonly KUBECTL_SHA256=7c3807c0f5c1b30110a2ff1e55da1d112a6d0096201f1beb81b269f582b5d1c5
readonly HELM_VERSION=v3.18.4
readonly HELM_SHA256=f8180838c23d7c7d797b208861fecb591d9ce1690d8704ed1e4cb8e2add966c1
# The release binary of the version upstream builds from source.
readonly CLOUD_PROVIDER_KIND_VERSION=0.10.0
readonly CLOUD_PROVIDER_KIND_SHA256=8b88095d72f8dbb4ce65ecf34e4bde5c1c8a3de90c65e66dda7dcd65fba2d58b
# Upstream pins only the gateway chart (1.26.3); base and istiod use the same.
readonly ISTIO_VERSION=1.26.3
readonly ISTIO_BASE_SHA256=4176fb642b575315980caf8b422a9f06e7830a609b78a49c0880e28531af0d8c
readonly ISTIO_ISTIOD_SHA256=f2df1ac103bcc3d408ad2d5f6bc254149136afb01b10a5c2f76cd429b8c779b1
readonly ISTIO_GATEWAY_SHA256=2afa5f170b2d5a3a36dfea62d9128d329471fb09dbefa7e95f9424bf782c4988
# Contracts 13.5; the digest is the chart index's.
readonly CANVAS_VERSION=1.2.5
readonly CANVAS_SHA256=c16d5f6bbfe0a885d3d06f77f08349c469c52376858e5706002d67ccc9f9d145

# --- Phase limits, in seconds -----------------------------------------------
readonly CLUSTER_WAIT=600
readonly ISTIO_WAIT=900
readonly LOAD_BALANCER_WAIT=300
readonly CANVAS_HELM_WAIT=1800
readonly CANVAS_READY_WAIT=900
readonly COMPONENT_WAIT=900
readonly GATEWAY_WAIT=120
readonly POLL=5

readonly COMPONENT=std-probe
readonly COMPONENT_NAMESPACE=components
# Without Vault, the secrets-management operator cannot start (the Canvas
# installation guide, "HashiCorp Vault"); components that do not request
# secrets management are unaffected, so the readiness wait skips it.
readonly SKIPPED_DEPLOYMENT=canvas-smanop

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
readonly repo_root
readonly stub_chart="$repo_root/deploy/oda/probe-stub"
readonly pinned_crd="$repo_root/deploy/oda/crds/oda-component-crd.yaml"

out_dir=${PROBE_OUT_DIR:-$PWD/oda-canvas-probe-out}
mkdir -p "$out_dir"
out_dir=$(cd "$out_dir" && pwd)
readonly out_dir
tools_dir=${PROBE_TOOLS_DIR:-$out_dir/tools}
mkdir -p "$tools_dir"
tools_dir=$(cd "$tools_dir" && pwd)
readonly tools_dir
readonly cluster=${PROBE_CLUSTER:-std-oda-probe-$(date -u +%Y%m%d%H%M%S)-$$}
readonly keep_cluster=${PROBE_KEEP_CLUSTER:-0}
readonly log_dir="$out_dir/logs"
readonly state_dir="$out_dir/state"
readonly result="$out_dir/result.json"

rm -rf "$log_dir" "$state_dir"
mkdir -p "$log_dir" "$state_dir" "$tools_dir/bin"

export PATH="$tools_dir/bin:$PATH"
export KUBECONFIG="$state_dir/kubeconfig"
export HELM_CACHE_HOME="$state_dir/helm/cache"
export HELM_CONFIG_HOME="$state_dir/helm/config"
export HELM_DATA_HOME="$state_dir/helm/data"

now() { printf '%s' "$EPOCHREALTIME"; }
iso_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { printf '[probe %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# Prints `{"usedBytes":…,"availableBytes":…}` for the root file system.
disk_json() {
  local used avail
  read -r used avail < <(df -B1 --output=used,avail / | tail -n 1)
  jq -cn --argjson used "$used" --argjson avail "$avail" \
    '{usedBytes: $used, availableBytes: $avail}'
}

started_at=$(iso_now)
readonly started_at
disk_before=$(disk_json)
readonly disk_before
failed_phase=""
cluster_created=0
kind_network_existed=0
if docker network inspect kind >/dev/null 2>&1; then kind_network_existed=1; fi

# --- Phase runner ------------------------------------------------------------
# Runs one phase in a subshell with errexit (a subshell outside an `if`, so
# errexit holds), tees its output to logs/<phase>.log and appends a record to
# state/phases.jsonl. After a failure, later phases are recorded as skipped.
run_phase() {
  local name=$1
  shift
  if [[ -n $failed_phase ]]; then
    jq -cn --arg name "$name" '{name: $name, status: "skipped"}' >>"$state_dir/phases.jsonl"
    return 0
  fi
  say "phase $name: start"
  local start rc end
  start=$(now)
  local phase_started_at
  phase_started_at=$(iso_now)
  set +e
  (
    set -euo pipefail
    "$@"
  ) 2>&1 | tee "$log_dir/$name.log"
  rc=${PIPESTATUS[0]}
  set -e
  end=$(now)
  local status=success
  if [[ $rc -ne 0 ]]; then
    status=failure
    failed_phase=$name
  fi
  jq -cn --arg name "$name" --arg status "$status" --arg startedAt "$phase_started_at" \
    --argjson duration "$(awk -v a="$start" -v b="$end" 'BEGIN { printf "%.1f", b - a }')" \
    --argjson exitCode "$rc" --argjson disk "$(disk_json)" \
    '{name: $name, status: $status, startedAt: $startedAt, durationSeconds: $duration, exitCode: $exitCode, diskAfter: $disk}' \
    >>"$state_dir/phases.jsonl"
  say "phase $name: $status (exit $rc)"
}

# Downloads a URL into a file and checks its SHA-256.
fetch() {
  local url=$1 file=$2 sha=$3
  curl --fail --silent --show-error --location --retry 0 --max-time 300 -o "$file" "$url"
  printf '%s  %s\n' "$sha" "$file" | sha256sum --check --strict
}

# --- Phases -------------------------------------------------------------------
phase_tools() {
  local dl="$tools_dir/downloads"
  mkdir -p "$dl"
  fetch "https://github.com/kubernetes-sigs/kind/releases/download/$KIND_VERSION/kind-linux-amd64" \
    "$dl/kind" "$KIND_SHA256"
  install -m 0755 "$dl/kind" "$tools_dir/bin/kind"
  fetch "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/amd64/kubectl" "$dl/kubectl" "$KUBECTL_SHA256"
  install -m 0755 "$dl/kubectl" "$tools_dir/bin/kubectl"
  fetch "https://get.helm.sh/helm-$HELM_VERSION-linux-amd64.tar.gz" "$dl/helm.tar.gz" "$HELM_SHA256"
  rm -rf "$dl/helm" && mkdir -p "$dl/helm"
  tar -xzf "$dl/helm.tar.gz" -C "$dl/helm" linux-amd64/helm
  install -m 0755 "$dl/helm/linux-amd64/helm" "$tools_dir/bin/helm"
  fetch "https://github.com/kubernetes-sigs/cloud-provider-kind/releases/download/v$CLOUD_PROVIDER_KIND_VERSION/cloud-provider-kind_${CLOUD_PROVIDER_KIND_VERSION}_linux_amd64.tar.gz" \
    "$dl/cloud-provider-kind.tar.gz" "$CLOUD_PROVIDER_KIND_SHA256"
  rm -rf "$dl/cloud-provider-kind" && mkdir -p "$dl/cloud-provider-kind"
  tar -xzf "$dl/cloud-provider-kind.tar.gz" -C "$dl/cloud-provider-kind" cloud-provider-kind
  install -m 0755 "$dl/cloud-provider-kind/cloud-provider-kind" "$tools_dir/bin/cloud-provider-kind"

  local chart
  for chart in base:"$ISTIO_BASE_SHA256" istiod:"$ISTIO_ISTIOD_SHA256" gateway:"$ISTIO_GATEWAY_SHA256"; do
    fetch "https://istio-release.storage.googleapis.com/charts/${chart%%:*}-$ISTIO_VERSION.tgz" \
      "$tools_dir/istio-${chart%%:*}-$ISTIO_VERSION.tgz" "${chart#*:}"
  done
  fetch "https://github.com/tmforum-oda/oda-canvas/releases/download/canvas-oda-$CANVAS_VERSION/canvas-oda-$CANVAS_VERSION.tgz" \
    "$tools_dir/canvas-oda-$CANVAS_VERSION.tgz" "$CANVAS_SHA256"

  # The CRD that `pnpm check:tooling` validates the stub against must be the
  # one this chart installs.
  rm -rf "$dl/canvas" && mkdir -p "$dl/canvas"
  tar -xzf "$tools_dir/canvas-oda-$CANVAS_VERSION.tgz" -C "$dl/canvas" \
    canvas-oda/charts/oda-crds/templates/oda-component-crd.yaml
  cmp "$dl/canvas/canvas-oda/charts/oda-crds/templates/oda-component-crd.yaml" "$pinned_crd"
  echo "deploy/oda/crds/oda-component-crd.yaml equals the chart's Component CRD"

  kind version
  kubectl version --client
  helm version
}

phase_cluster() {
  kind create cluster --name "$cluster" --image "$KIND_NODE_IMAGE" \
    --kubeconfig "$KUBECONFIG" --wait "${CLUSTER_WAIT}s"
  # cloud-provider-kind gives LoadBalancer Services an address, as upstream
  # runs it; the Istio API operator builds every exposed API's URL from the
  # ingress address. Its output goes to its own log, never to the phase pipe.
  cloud-provider-kind >"$log_dir/cloud-provider-kind.log" 2>&1 &
  echo $! >"$state_dir/cloud-provider-kind.pid"
  kubectl get nodes -o wide
}

phase_istio() {
  kubectl create namespace istio-system
  helm install istio-base "$tools_dir/istio-base-$ISTIO_VERSION.tgz" -n istio-system
  helm install istiod "$tools_dir/istio-istiod-$ISTIO_VERSION.tgz" -n istio-system \
    --wait --timeout "${ISTIO_WAIT}s"
  kubectl create namespace istio-ingress
  kubectl label namespace istio-ingress istio-injection=enabled
  helm install istio-ingress "$tools_dir/istio-gateway-$ISTIO_VERSION.tgz" -n istio-ingress \
    --set labels.app=istio-ingress --set labels.istio=ingressgateway \
    --wait --timeout "${ISTIO_WAIT}s"
  local deadline=$((SECONDS + LOAD_BALANCER_WAIT)) address=""
  while [[ -z $address ]]; do
    address=$(kubectl get service istio-ingress -n istio-ingress \
      -o jsonpath='{.status.loadBalancer.ingress[0].ip}{.status.loadBalancer.ingress[0].hostname}')
    if [[ -z $address ]]; then
      if ((SECONDS > deadline)); then
        echo "istio-ingress has no load-balancer address after ${LOAD_BALANCER_WAIT}s" >&2
        return 1
      fi
      sleep "$POLL"
    fi
  done
  echo "$address" >"$state_dir/ingress-address"
  echo "istio-ingress address: $address"
}

phase_canvas() {
  # As the Canvas's installation guide and CI install it: no --wait (its
  # post-install hooks would deadlock), the Istio pre-install check off on
  # kind; Vault disabled (Contracts 13.5).
  helm install canvas "$tools_dir/canvas-oda-$CANVAS_VERSION.tgz" -n canvas --create-namespace \
    --set preqrequisitechecks.istio=false --set canvas-vault.enabled=false \
    --timeout "${CANVAS_HELM_WAIT}s"
  local namespace deployments
  for namespace in cert-manager canvas; do
    deployments=$(kubectl get deployments -n "$namespace" -o name | grep -v "/$SKIPPED_DEPLOYMENT\$" || true)
    if [[ -n $deployments ]]; then
      # shellcheck disable=SC2086 # one argument per deployment
      kubectl wait -n "$namespace" --for=condition=Available --timeout="${CANVAS_READY_WAIT}s" $deployments
    fi
  done
  local statefulset
  for statefulset in $(kubectl get statefulsets -n canvas -o name); do
    kubectl rollout status -n canvas "$statefulset" --timeout="${CANVAS_READY_WAIT}s"
  done
  kubectl get crd components.oda.tmforum.org \
    -o jsonpath='{range .spec.versions[*]}{.name} served={.served} storage={.storage}{"\n"}{end}'
  kubectl get pods -n canvas -o wide
}

component_status() {
  kubectl get component "$COMPONENT" -n "$COMPONENT_NAMESPACE" -o json 2>/dev/null |
    jq -r '.status["summary/status"].deployment_status // ""' || true
}

phase_component() {
  # The API server validates the rendered Component against the live CRD,
  # its CEL rules included, before anything is installed.
  helm template "$COMPONENT" "$stub_chart" -n "$COMPONENT_NAMESPACE" >"$state_dir/stub.yaml"
  kubectl apply --dry-run=server -n "$COMPONENT_NAMESPACE" -f "$state_dir/stub.yaml"
  local start=$SECONDS
  helm install "$COMPONENT" "$stub_chart" -n "$COMPONENT_NAMESPACE"
  local deadline=$((start + COMPONENT_WAIT)) previous="" current=""
  while true; do
    current=$(component_status)
    if [[ $current != "$previous" ]]; then
      echo "$((SECONDS - start))s: ${current:-<no status>}"
      jq -cn --arg status "$current" --argjson at "$((SECONDS - start))" \
        '{status: $status, atSeconds: $at}' >>"$state_dir/transitions.jsonl"
      previous=$current
    fi
    if [[ $current == Complete ]]; then
      break
    fi
    if ((SECONDS > deadline)); then
      echo "component $COMPONENT is '${current:-<no status>}' after ${COMPONENT_WAIT}s, not Complete" >&2
      return 1
    fi
    sleep "$POLL"
  done
  kubectl get components,exposedapis,identityconfigs -n "$COMPONENT_NAMESPACE"
}

# Not gating: whether the exposed API answers through the Canvas gateway, the
# first thing the Step 5 workflow needs beyond `Complete`.
observe_gateway() {
  local url status=""
  url=$(kubectl get component "$COMPONENT" -n "$COMPONENT_NAMESPACE" -o json |
    jq -r '.status.coreAPIs[0].url // ""')
  local deadline=$((SECONDS + GATEWAY_WAIT))
  while [[ -n $url ]]; do
    status=$(curl --insecure --silent --output /dev/null --max-time 10 --write-out '%{http_code}' \
      "${url%/}/openapi.json" || true)
    if [[ $status == 200 ]] || ((SECONDS > deadline)); then break; fi
    sleep "$POLL"
  done
  echo "gateway: ${url:-<no url>} -> ${status:-<none>}"
  jq -cn --arg url "$url" --arg status "$status" \
    '{url: $url, httpStatus: $status, ok: ($status == "200")}' >"$state_dir/gateway.json"
}

collect_diagnostics() {
  {
    echo "== kubectl get all,components,exposedapis,identityconfigs -A"
    kubectl get all,components,exposedapis,identityconfigs -A -o wide
    echo "== events"
    kubectl get events -A --sort-by=.lastTimestamp | tail -n 200
    echo "== pods that are not ready"
    kubectl get pods -A -o json |
      jq -r '.items[] | select(any(.status.conditions[]?; .type == "Ready" and .status != "True"))
        | "\(.metadata.namespace) \(.metadata.name)"' |
      while read -r namespace pod; do
        kubectl describe pod -n "$namespace" "$pod" | tail -n 40
      done
    local deployment
    for deployment in component-operator api-operator-istio identityconfig-operator-keycloak; do
      echo "== logs: $deployment"
      kubectl logs -n canvas "deployment/$deployment" --all-containers --tail=200
    done
    echo "== helm list"
    helm list -A
  } >"$log_dir/diagnostics.log" 2>&1 || true
}

collect_images() {
  kubectl get pods -A -o json 2>/dev/null |
    jq -c '[.items[].status | (.containerStatuses // []) + (.initContainerStatuses // []) | .[]
      | {image, imageID}] | unique' 2>/dev/null || echo '[]'
}

tool_versions() {
  jq -cn \
    --arg kind "$(kind version 2>/dev/null || true)" \
    --arg kubectl "$(kubectl version --client -o json 2>/dev/null | jq -r .clientVersion.gitVersion || true)" \
    --arg kubernetes "$(kubectl version -o json 2>/dev/null | jq -r '.serverVersion.gitVersion // ""' || true)" \
    --arg helm "$(helm version --short 2>/dev/null || true)" \
    --arg cloudProviderKind "$CLOUD_PROVIDER_KIND_VERSION" \
    --arg docker "$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)" \
    --arg jq "$(jq --version)" \
    --arg curl "$(curl --version | head -n 1)" \
    --arg bash "$BASH_VERSION" \
    '$ARGS.named'
}

runner_json() {
  local os=""
  if [[ -r /etc/os-release ]]; then os=$(. /etc/os-release && echo "${PRETTY_NAME:-}"); fi
  jq -cn \
    --arg imageOS "${ImageOS:-}" \
    --arg imageVersion "${ImageVersion:-}" \
    --arg runnerName "${RUNNER_NAME:-}" \
    --arg os "$os" \
    --arg kernel "$(uname -r)" \
    --argjson cpus "$(nproc)" \
    --argjson memoryBytes "$(awk '/^MemTotal:/ { print $2 * 1024 }' /proc/meminfo)" \
    '$ARGS.named'
}

pins_json() {
  jq -cn \
    --arg kind "$KIND_VERSION" --arg kindNodeImage "$KIND_NODE_IMAGE" \
    --arg kubectl "$KUBECTL_VERSION" --arg helm "$HELM_VERSION" \
    --arg cloudProviderKind "$CLOUD_PROVIDER_KIND_VERSION" --arg istio "$ISTIO_VERSION" \
    --arg canvasOda "$CANVAS_VERSION" --arg canvasOdaSha256 "$CANVAS_SHA256" \
    '$ARGS.named'
}

jsonl_array() {
  if [[ -s $1 ]]; then jq -cs . "$1"; else echo '[]'; fi
}

write_result() {
  local outcome=success excerpt=""
  if [[ -n $failed_phase ]]; then
    outcome=failure
    excerpt=$(tail -n 60 "$log_dir/$failed_phase.log" 2>/dev/null || true)
  fi
  local gateway='null'
  if [[ -s $state_dir/gateway.json ]]; then gateway=$(cat "$state_dir/gateway.json"); fi
  jq -n \
    --arg startedAt "$started_at" --arg finishedAt "$(iso_now)" \
    --arg outcome "$outcome" --arg failedPhase "$failed_phase" --arg excerpt "$excerpt" \
    --arg cluster "$cluster" \
    --argjson run "$(jq -cn --arg id "${GITHUB_RUN_ID:-}" --arg attempt "${GITHUB_RUN_ATTEMPT:-}" \
      --arg sha "${GITHUB_SHA:-$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || true)}" \
      --arg ref "${GITHUB_REF:-}" --argjson github "$([[ -n ${GITHUB_ACTIONS:-} ]] && echo true || echo false)" \
      '{githubActions: $github, runId: $id, runAttempt: $attempt, sha: $sha, ref: $ref}')" \
    --argjson runner "$(runner_json)" \
    --argjson pins "$(pins_json)" \
    --argjson tools "$(tool_versions)" \
    --argjson diskBefore "$disk_before" --argjson diskAfter "$(disk_json)" \
    --argjson phases "$(jsonl_array "$state_dir/phases.jsonl")" \
    --argjson transitions "$(jsonl_array "$state_dir/transitions.jsonl")" \
    --argjson gateway "$gateway" \
    --argjson images "$(collect_images)" \
    '{
      schemaVersion: 1,
      probe: "oda-canvas-probe",
      startedAt: $startedAt,
      finishedAt: $finishedAt,
      outcome: $outcome,
      failedPhase: (if $failedPhase == "" then null else $failedPhase end),
      failureExcerpt: (if $excerpt == "" then null else $excerpt end),
      cluster: $cluster,
      run: $run,
      runner: $runner,
      pins: $pins,
      tools: $tools,
      disk: {
        before: $diskBefore,
        after: $diskAfter,
        peakUsedBytes: ([$diskBefore.usedBytes, $diskAfter.usedBytes] + [$phases[] | .diskAfter.usedBytes // empty] | max)
      },
      phases: $phases,
      component: {transitions: $transitions},
      gateway: $gateway,
      images: $images
    }' >"$result"
}

cleanup() {
  if [[ $cluster_created -eq 1 && $keep_cluster != 1 ]]; then
    say "deleting cluster $cluster"
    if [[ -s $state_dir/cloud-provider-kind.pid ]]; then
      kill "$(cat "$state_dir/cloud-provider-kind.pid")" 2>/dev/null || true
    fi
    kind delete cluster --name "$cluster" --kubeconfig "$KUBECONFIG" || true
    # cloud-provider-kind's load-balancer containers are labelled with
    # "<cluster>/<namespace>/<service>"; remove this cluster's only.
    local container
    for container in $(docker ps -aq --filter label=io.x-k8s.cloud-provider-kind.loadbalancer.name); do
      if docker inspect --format '{{index .Config.Labels "io.x-k8s.cloud-provider-kind.loadbalancer.name"}}' \
        "$container" | grep -q "^$cluster/"; then
        docker rm -f "$container" >/dev/null || true
      fi
    done
    if [[ $kind_network_existed -eq 0 ]] &&
      [[ $(docker network inspect kind --format '{{len .Containers}}' 2>/dev/null || echo 1) == 0 ]]; then
      docker network rm kind >/dev/null || true
    fi
    jq --argjson disk "$(disk_json)" '.disk.afterCleanup = $disk' "$result" >"$result.tmp" &&
      mv "$result.tmp" "$result"
  fi
}

finish() {
  local rc=$?
  trap - EXIT
  if [[ -z $failed_phase && $rc -ne 0 ]]; then failed_phase=script; fi
  if [[ -n $failed_phase && $cluster_created -eq 1 ]]; then collect_diagnostics; fi
  write_result || say "could not write $result"
  cleanup || true
  say "outcome: $(jq -r .outcome "$result" 2>/dev/null || echo unknown) ${failed_phase:+(failed phase: $failed_phase)}"
  say "result: $result"
  if [[ -n $failed_phase ]]; then exit 1; fi
  exit 0
}
trap finish EXIT
trap 'exit 130' INT TERM

say "cluster $cluster, results in $out_dir"
run_phase tools phase_tools
# Set here, not in the phase's subshell: cleanup must delete even a cluster
# whose creation failed halfway.
if [[ -z $failed_phase ]]; then cluster_created=1; fi
run_phase cluster phase_cluster
run_phase istio phase_istio
run_phase canvas phase_canvas
run_phase component phase_component
if [[ -z $failed_phase ]]; then observe_gateway 2>&1 | tee "$log_dir/gateway.log" || true; fi
