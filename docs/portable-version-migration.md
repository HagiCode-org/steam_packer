# Portable Version Migration

`steam_packer` stays independent. `portable-version` is just the current upstream caller for Portable Version packaging and Azure publication.

`steam_packer` can also poll for server updates directly. Its `package-release` workflow runs on a repository schedule, resolves the latest Desktop and Service manifests from direct Azure authority by default, derives the Portable Version release tag from the Service version, and continues into the existing package/publish flow only when that release is missing. If the release already exists, the workflow records `should_build=false` and the skip reason, then stops before package and publish jobs.

## What Moved

- Packaging-safe workspace assembly
- Desktop archive repacking
- Portable payload and toolchain staging
- Artifact inventory and checksum generation
- Azure Blob upload and root `index.json` refresh

## What Stays In `portable-version`

- Version resolution and release-tag derivation
- Build-plan / handoff payload generation
- Steam release hydration and Steam upload workflows

## Maintainer Workflow

### Dry run

From `repos/steam_packer`:

```bash
npm run verify:dry-run
```

This validates packaging without Azure writes and confirms that the merged metadata remains complete enough for publication and later Steam hydration.

For GitHub Actions, maintainers can run `package-release` with `workflow_dispatch` and `dry_run=true` to exercise the same Azure-authority version resolution and packaging path without publishing to the Azure Steam container.

If the Steam package needs additional runtime flags, set `env_config` on `workflow_dispatch` to a JSON object such as `{"HAGICODE_LOG_LEVEL":"info"}`. The workflow and the local resolver use the same normalization contract, so the resulting plan always carries `HAGICODE_MODE=steam` and `HAGICODE_STEAM_ACHIEVEMENT_SYNC_ENABLED=true` unless the package explicitly sets the achievement-sync value to `false`.

### Force rebuild

Regenerate the handoff payload with `repos/portable-version/scripts/resolve-build-plan.mjs`, set `force_rebuild=true` in that input, and pass the plan to `steam_packer`. The rebuild intent stays in the handoff payload and `steam_packer` executes the same release tag again while preserving root-index upsert semantics.

For the repository-local manual path, use `workflow_dispatch` with `force_rebuild=true`. This keeps the scheduled-run default skip gate unchanged while allowing a maintainer to rebuild a release that already exists.

The same repository-local path also accepts `env_config`, and the equivalent CLI entrypoint is:

```bash
node scripts/resolve-dispatch-build-plan.mjs \
  --event-name workflow_dispatch \
  --desktop-azure-sas-url "<desktop-sas>" \
  --service-azure-sas-url "<service-sas>" \
  --env-config '{"HAGICODE_LOG_LEVEL":"info"}' \
  --output build/build-plan.json
```

Unless maintainers explicitly override the manifest source, both the workflow and the CLI resolver read `index.json` directly from the Desktop / Service Azure containers using the supplied SAS URLs. This bypasses the cached `index.hagicode.com` Desktop / Service routes. Explicit overrides remain valid for diagnostics, but they do not change the default source-of-truth behavior.

### Platform matrix

`portable-version` continues to normalize platform intent. The delegated handoff already contains `platforms[]` and `platformMatrix.include[]`, so `steam_packer` should not infer or expand platforms interactively.

Repository-local scheduled and manual runs use the same default platform matrix when no handoff artifact is provided: `linux-x64`, `win-x64`, and `osx-universal`.

### Failure attribution

For local diagnostics or CI assertions, use:

```bash
node scripts/run-release-plan.mjs \
  --plan <path-to-build-plan.json>
```

Failure stages are attributed as:

- `build-plan-validation`
- `delegated-packaging`
- `azure-publication`

`azure-publication` now reads both the canonical `steamAppId` and the per-platform `steamDepotIds` from the shared Steam dataset before dry-run or real publication writes the root index contract. `steamAppKey` defaults to `hagicode`; `--steam-app-key` remains only as an override when a caller needs a different shared dataset entry.

### Toolchain ownership boundary

`hagicode-desktop` builds and ships `extra/toolchain`. `steam_packer` must not actively download Node, run npm installs, or preinstall OpenSpec/Skills/Omniroute. Its packaging flow validates the Desktop-authored `toolchain-manifest.json` with `owner=hagicode-desktop` and `source=bundled-desktop`, then carries that validated directory into the final archive.

Current Desktop builds bundle the Node/npm runtime and defer managed CLI packages such as OpenSpec, Skills, and OmniRoute through manifest metadata (`installMode=manual`, `installState=pending`). `steam_packer` therefore validates Node/npm plus Desktop-authored package metadata; it must not require preinstalled `openspec`, `skills`, or `omniroute` executables in the archive.

Desktop also owns the consumer default-enable matrix in `defaultEnabledByConsumer`. Current Desktop-authored manifests set `desktop=true` and `steam-packer=true`. `steam_packer` treats `defaultEnabledByConsumer['steam-packer'] = true` as the supported explicit contract and rejects explicit `false`; manifests that predate the field are accepted with an enabled legacy fallback so older Desktop artifacts can still be repacked.

Workspace preparation persists the effective decision in `workspace-manifest.json` as `toolchainActivationPolicy`, `bundledToolchainEnabled`, and the selected toolchain root. Later verification and packaging stages consume that metadata and the Desktop-authored `extra/toolchain`; they must not create another Node staging area or run a second package installation path.

Workspace preparation now also writes `hagicode.env` beside the packaged executable, records `envFilePath` plus the normalized `envConfig` in `workspace-manifest.json`, and packaging fails if that file is missing from the final archive.

The reusable `package-release` workflow now consumes the shared Steam dataset from `https://index.hagicode.com/steam/index.json` directly during publication. Local and standalone runs use the same online source by default, while `--steam-data-path` remains available when a maintainer needs to pin a local JSON fixture or a different explicit URL. Those fixtures and overrides are validation tools only; they do not promote any local copy to the default Steam identity source.

After Azure uploads succeed and `hagicode-steam/index.json` exposes the refreshed release entry, `steam_packer` also creates or updates the matching GitHub Release notes for that tag. The GitHub Release remains metadata-only: package archives, checksums, and manifests stay in Azure Blob storage and are not uploaded as GitHub Release assets. Dry-run executions skip the GitHub Release sync.

### Primary Troubleshooting Entry Points

- Handoff shape or release intent problems: `repos/portable-version/scripts/resolve-build-plan.mjs`
- Packaging / publication problems: `repos/steam_packer/scripts/run-release-plan.mjs`
- Steam hydration problems: `repos/portable-version/scripts/prepare-steam-release-input.mjs`
