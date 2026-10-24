#!/usr/bin/env bash
set -euo pipefail

# Validate the JSON value before Bash can strip trailing LF or NUL bytes.
# \A and \z anchor the whole string, including any final newline.
jq -er '
  .version
  | if (if type == "string" then
      test("\\A(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\z")
    else false end) then .
    else error("Release version in packages/server/package.json must be canonical major.minor.patch as a JSON string without whitespace, prerelease or build suffixes; got \(tojson).")
    end
' packages/server/package.json || exit 1
