# steam_packer

`steam_packer` is an independent packaging and Azure publication repository.

It accepts a normalized release plan from any non-interactive caller, assembles the packaging workspace, stages the payload and bundled toolchain, repacks deterministic platform archives, uploads them to Azure Blob Storage, and refreshes the root `hagicode-steam/index.json` entry without changing the downstream Steam hydration contract.

## Repository Role

- Owns Portable Version packaging-safe workspace assembly
- Owns archive generation, artifact inventory, and checksum emission
- Owns Azure Blob publication and root-index refresh
- Exposes reusable CI and CLI entrypoints for external callers
- Keeps release metadata compatible with downstream Steam hydration consumers

`portable-version` is currently one caller, but `steam_packer` is not coupled to that repository.

## Release Plan Contract

The primary input is a build-plan JSON artifact. The caller is responsible for producing it.

The plan must contain:

- `release.tag`
- `platforms[]`
- `platformMatrix.include[]`
- `upstream.desktop.*`
- `upstream.service.*`
- `downloads.desktop.containerUrl`
- `downloads.service.containerUrl`
- `build.shouldBuild`
- `build.forceRebuild`
- `build.dryRun`
- `handoff.schema = steam-packer-handoff/v1`

`steam_packer` validates the release plan before any workspace mutation. Missing fields fail fast at the `build-plan-validation` stage.

## Workflow Entry

Reusable workflow:

- `.github/workflows/package-release.yml`

Compatibility note:

- `.github/workflows/portable-version-package.yml` remains as a legacy compatibility entrypoint for existing callers.
- `scripts/run-portable-version-handoff.mjs` and `scripts/resolve-portable-version-handoff.mjs` remain as legacy aliases.

Expected caller behavior:

1. Produce a normalized build plan and upload it as an artifact.
2. Call the reusable workflow in `steam_packer`.
3. `steam_packer` validates the plan and fans out packaging by platform.
4. `steam_packer` publishes merged metadata and refreshes the Azure root index.

## Local Verification

From `repos/steam_packer`:

```bash
npm test
npm run verify:dry-run
npm run verify:publication
npm run verify:release-plan
```

## Local Run

For fixture-driven diagnostics:

```bash
node scripts/run-release-plan.mjs \
  --plan /path/to/build-plan.json \
  --desktop-asset-source /path/to/desktop.zip \
  --service-asset-source /path/to/service.zip \
  --toolchain-config /path/to/portable-toolchain.json \
  --steam-data-path ../index/src/data/public/steam/index.json \
  --force-dry-run
```

Result stages are attributed as:

- `build-plan-validation`
- `delegated-packaging`
- `azure-publication`

## Azure Publication Contract

`steam_packer` preserves the existing publication layout:

- `hagicode-steam/<releaseTag>/<archive>.zip`
- `hagicode-steam/<releaseTag>/<releaseTag>.build-manifest.json`
- `hagicode-steam/<releaseTag>/<releaseTag>.artifact-inventory.json`
- `hagicode-steam/<releaseTag>/<releaseTag>.checksums.txt`
- `hagicode-steam/index.json`

The root index entry remains compatible with current Steam hydration consumers:

- `version`
- `metadata.buildManifestPath`
- `metadata.artifactInventoryPath`
- `metadata.checksumsPath`
- `steamAppId`
- `steamDepotIds.linux`
- `steamDepotIds.windows`
- `steamDepotIds.macos`
- `artifacts[]`

Publication now resolves both `steamAppId` and `steamDepotIds` from the shared Steam dataset:

- default `steamAppKey`: `hagicode`
- optional override: `--steam-app-key`, `STEAM_PACKER_STEAM_APP_KEY`, or `STEAM_APP_KEY`
- `--steam-data-path` or `STEAM_PACKER_STEAM_DATA_PATH`
- By default, the dataset path resolves to `../index/src/data/public/steam/index.json` from the `steam_packer` repository root.

`steam_packer` resolves the canonical `steamAppId` from `applications[].key` and maps `applications[].platformAppIds` to `steamDepotIds`. The resolved values are reused for dry-run output, publication result metadata, and every `versions[]` entry written back to `hagicode-steam/index.json`. Legacy entries that predate `steamAppId` are backfilled from the same resolved value, while any conflicting non-empty `steamAppId` still aborts the write.

## Example Integration

The current Portable Version integration is documented in [docs/portable-version-migration.md](/home/newbe36524/repos/hagicode-mono/repos/steam_packer/docs/portable-version-migration.md).
