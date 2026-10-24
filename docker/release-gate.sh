#!/usr/bin/env bash
set -euo pipefail
if [[ "$GITHUB_REF_TYPE" != tag ]]; then
  echo "Release publication requires a tag; got ref type '$GITHUB_REF_TYPE'." >&2
  exit 1
fi
version="$(jq -r .version packages/server/package.json)"
if [[ "$GITHUB_REF_NAME" != "v$version" ]]; then
  echo "Release tag '$GITHUB_REF_NAME' must match server version '$version' (v$version)." >&2
  exit 1
fi
pnpm check:release
mkdir -p dist
echo "tag=$GITHUB_REF_NAME" >> "$GITHUB_OUTPUT"
