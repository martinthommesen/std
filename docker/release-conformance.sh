#!/usr/bin/env bash
set -euo pipefail

version="$(bash docker/release-version.sh)"

# docs/plan.md's Steps 3, 4 and 5 each name their release tag. Other
# versions need an explicit policy there before they can publish.
case "$version" in
  0.0.3) stage=step3 ;;
  0.0.4) stage=step4 ;;
  0.1.0) stage=step5 ;;
  *)
    echo "No conformance stage is documented for release version '$version'; docs/plan.md maps only 0.0.3=step3, 0.0.4=step4, 0.1.0=step5." >&2
    exit 1
    ;;
esac

pnpm check:conformance --gate "$stage"
