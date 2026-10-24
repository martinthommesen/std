#!/usr/bin/env bash
set -euo pipefail
mkdir -p dist
test "$GITHUB_REF_TYPE" = tag
version="$(jq -r .version packages/server/package.json)"
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
[[ "$GITHUB_REF_NAME" == "v$version" ]]
echo "tag=$GITHUB_REF_NAME" >> "$GITHUB_OUTPUT"
