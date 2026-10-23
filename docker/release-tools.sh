#!/bin/bash
# Downloads only fixed releases and verifies their publisher's SHA-256 values.
set -euo pipefail
release_tools_dir=${1:?usage: release-tools.sh destination}
mkdir -p "$release_tools_dir"
cd "$release_tools_dir"
fetch() {
  local url=$1 file=$2 checksum=$3
  curl --fail --silent --show-error --location --retry 3 "$url" -o "$file"
  printf '%s  %s\n' "$checksum" "$file" | sha256sum --check --strict
}
download_pids=()
fetch https://github.com/sigstore/cosign/releases/download/v2.6.1/cosign-linux-amd64 cosign 064954c5d8c7e3b28188eee5b1727b31c411550bc5fefd41aa672d3c761d103a &
download_pids+=("$!")
fetch https://github.com/anchore/syft/releases/download/v1.33.0/syft_1.33.0_linux_amd64.tar.gz syft.tar.gz adc1b944a827ed3432bcd9f1dbdbc8fa3c0dca7d3d449e7084c90248c2c6cb50 &
download_pids+=("$!")
fetch https://get.helm.sh/helm-v3.19.0-linux-amd64.tar.gz helm.tar.gz a7f81ce08007091b86d8bd696eb4d86b8d0f2e1b9f6c714be62f82f96a594496 &
download_pids+=("$!")
fetch https://github.com/docker/buildx/releases/download/v0.31.1/buildx-v0.31.1.linux-amd64 docker-buildx dc8eaffbf29138123b4874d852522b12303c61246a5073fa0f025e4220317b1e &
download_pids+=("$!")
download_status=0
for download_pid in "${download_pids[@]}"; do
  wait "$download_pid" || download_status=$?
done
if (( download_status != 0 )); then
  exit "$download_status"
fi
tar -xzf syft.tar.gz syft
tar -xzf helm.tar.gz linux-amd64/helm
mv linux-amd64/helm helm
chmod 755 cosign syft helm docker-buildx
mkdir -p "${DOCKER_CONFIG:-$HOME/.docker}/cli-plugins"
cp docker-buildx "${DOCKER_CONFIG:-$HOME/.docker}/cli-plugins/docker-buildx"
