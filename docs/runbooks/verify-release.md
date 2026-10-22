# Verify an STD release

Use cosign 2.6.1 or a compatible newer release and a GitHub CLI with `gh attestation verify`. Install these from their official distributions and verify their published checksums. STD's pinned Linux release tools and checksums are in `docker/release-tools.sh`.

## Prepare the release version

Before tagging, set `packages/server/package.json`'s version to the intended release (main currently uses `0.0.3`). It is the sole source for `STD_VERSION`, PostgreSQL application names and delivery worker-version floors. Use canonical numeric `major.minor.patch`, without leading zeros, prerelease or build suffixes. Publish from the matching tag, for example `v0.0.3`; the release gate rejects any other tag/version pair before building or publishing. Keep old tags unchanged: release compatibility runs `v0.0.2` with its original code.

## Verify the image, SBOM and provenance

Set the version to the published tag and the digest to the immutable digest in the signed release workflow's `image-digest.txt`. Replace the example values; use the same digest when deploying. Do not verify one digest and run a tag.

```sh
VERSION=v0.1.0
DIGEST=sha256:REPLACE_WITH_THE_64_HEX_DIGIT_RELEASE_DIGEST
IMAGE=ghcr.io/martinthommesen/std
IDENTITY="https://github.com/martinthommesen/std/.github/workflows/release.yml@refs/tags/$VERSION"
ISSUER=https://token.actions.githubusercontent.com

cosign verify \
  --certificate-identity "$IDENTITY" \
  --certificate-oidc-issuer "$ISSUER" \
  "$IMAGE@$DIGEST"

cosign verify-attestation \
  --type spdxjson \
  --certificate-identity "$IDENTITY" \
  --certificate-oidc-issuer "$ISSUER" \
  "$IMAGE@$DIGEST"

gh attestation verify "oci://$IMAGE@$DIGEST" \
  --repo martinthommesen/std \
  --signer-workflow martinthommesen/std/.github/workflows/release.yml \
  --source-ref "refs/tags/$VERSION" \
  --predicate-type https://slsa.dev/provenance/v1

gh attestation verify "oci://$IMAGE@$DIGEST" \
  --repo martinthommesen/std \
  --signer-workflow martinthommesen/std/.github/workflows/release.yml \
  --source-ref "refs/tags/$VERSION" \
  --predicate-type https://spdx.dev/Document/v2.3
```

Every command must exit 0. Check that the reported subject digest and source commit match the release you intend to deploy. Cosign checks the signature, certificate identity/issuer and transparency evidence; GitHub's verifier checks attestations against the named repository and workflow. See the [Sigstore verification reference](https://docs.sigstore.dev/cosign/verifying/verify/) and [GitHub CLI attestation reference](https://cli.github.com/manual/gh_attestation_verify).

## Inspect a dry run

Manually run **Signed release** with `dry_run=true`. Download its `signed-release-<run-id>` artifact using the Actions UI or:

```sh
RUN_ID=REPLACE_WITH_RUN_ID
gh run download "$RUN_ID" --repo martinthommesen/std \
  --name "signed-release-$RUN_ID" --dir verified-dry-run
cd verified-dry-run
```

Set the identity to the ref selected for that run, for example `https://github.com/martinthommesen/std/.github/workflows/release.yml@refs/heads/main`. Dry-run signatures deliberately do not satisfy the release tag identity above. Verify the actual files with their accompanying bundles:

```sh
IDENTITY=https://github.com/martinthommesen/std/.github/workflows/release.yml@refs/heads/main
ISSUER=https://token.actions.githubusercontent.com
cosign verify-blob --bundle std-image.sigstore.json \
  --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER" \
  std-image.tar
cosign verify-blob --bundle sbom.sigstore.json \
  --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER" \
  sbom.spdx.json
```

The archive is an OCI archive. Dry runs create blob signatures only; they do not create GitHub image provenance or SBOM attestations and have no package or attestation write permission. A dry run signs real artifacts and records transparency evidence but does not publish anything to the container registry. Workflow artifacts expire after 30 days; retain copies if needed.

## Verify the Step 5 chart

The chart step currently skips because `deploy/oda/std/Chart.yaml` does not yet exist. When Step 5 adds it, the release artifact also contains the packaged chart and its `.sigstore.json` bundle. Download both from the same release run, set `IDENTITY` to its exact tag identity as above, and run:

```sh
CHART=std-0.1.0.tgz
cosign verify-blob --bundle "$CHART.sigstore.json" \
  --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER" \
  "$CHART"
```

Only install the verified archive. `helm verify` expects an OpenPGP `.prov` file and does not verify this keyless Sigstore bundle. Step 5 will define durable chart/bundle distribution alongside the OCI chart push.

## Protect release tags

Configure a repository tag ruleset for `v*` that restricts tag creation, updates and deletion to release maintainers, with tightly controlled bypass actors. The exact tag identity checked above is meaningful only when the project controls who can establish that tag. Publishing runs only in the tag-only job; branch dry runs have no GHCR or GitHub attestation write permission.

## Configure Postgres TLS

Use `STD_DATABASE_SSL_MODE=verify-full` and `STD_DATABASE_SSL_CA_FILE=/path/to/ca.pem`. To intentionally use Node's public root store instead, set `STD_DATABASE_SSL_SYSTEM_ROOTS=true`; `verify-full` refuses implicit public roots. `verify-ca` always requires an explicit, nonempty CA file, and checks the chain without matching the hostname.

With a CA file, `require` verifies the chain without a hostname check, matching libpq. Plain `require` without a CA can be intercepted by anyone on the path: it encrypts but does not authenticate the server. Prefer `verify-full` for production. Modes never fall back to plaintext if Postgres refuses TLS. Unix sockets ignore the mode and use socket transport.

Optional client authentication needs both `STD_DATABASE_SSL_CERT_FILE` and `STD_DATABASE_SSL_KEY_FILE`. Keep private keys mode 0600. STD reads files at configuration-layer startup; restart application processes after rotation. The bundled compose identity renews at startup when either certificate has fewer than 30 days remaining; restart application containers afterwards. External `STD_COMPOSE_DATABASE_URL` targets receive no bundled CA or mode: supply TLS settings and file mounts explicitly.
