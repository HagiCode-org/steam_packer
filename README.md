# steam_packer

`steam_packer` is an independent packaging and Azure publication repository.

It accepts a normalized release plan from any non-interactive caller, assembles the packaging workspace, stages the payload, validates the Desktop-authored bundled toolchain, repacks deterministic platform archives, uploads them to Azure Blob Storage, and refreshes the root `hagicode-steam/index.json` entry without changing the downstream Steam hydration contract.

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

Scheduled trigger behavior:

- `package-release` runs automatically every 4 hours with `cron: 0 */4 * * *`.
- Scheduled runs auto-resolve the latest Desktop index release and the latest Service index release.
- Scheduled runs use the default publication targets: `linux-x64`, `win-x64`, and `osx-universal`.
- The derived Portable Version release tag is checked before packaging. If that release already exists and no manual override is present, `build.shouldBuild=false` and the package/publish jobs are skipped.
- The Actions summary records the trigger type, latest upstream versions, derived release tag, `should_build`, and the skip reason when packaging is skipped.

Expected caller behavior:

1. Produce a normalized build plan and upload it as an artifact.
2. Call the reusable workflow in `steam_packer`.
3. `steam_packer` validates the plan and fans out packaging by platform.
4. `steam_packer` publishes merged metadata and refreshes the Azure root index.

Manual trigger behavior:

- `workflow_dispatch` is supported for maintainers.
- Manual dispatch auto-resolves the latest Desktop index release and the latest Service index release.
- Manual dispatch defaults to the three supported publication targets: `linux-x64`, `win-x64`, and `osx-universal`.
- Manual dispatch only exposes `force_rebuild` and `dry_run`; it does not require a build-plan parameter.
- Set `force_rebuild=true` to package and publish even when the derived Portable Version release already exists.
- Set `dry_run=true` to run packaging and emit release metadata without writing to the Azure Steam container.
- Manual runs still require the same Azure SAS secrets as reusable runs.

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
  --force-dry-run
```

`steam_packer` does not download Node, install OpenSpec, or assemble the portable toolchain. The Desktop asset is the owner of `extra/toolchain`; this repository only verifies the Desktop-authored `toolchain-manifest.json` contract and packages the validated input.

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
- By default, `steam_packer` downloads the dataset from `https://index.hagicode.com/steam/index.json`.
- `--steam-data-path` / `STEAM_PACKER_STEAM_DATA_PATH` remain compatibility overrides, and can point to either a local JSON file or an explicit `https://...` URL.

`steam_packer` resolves the canonical `steamAppId` from `applications[].key` and maps `applications[].platformAppIds` to `steamDepotIds`. The resolved values are reused for dry-run output, publication result metadata, and every `versions[]` entry written back to `hagicode-steam/index.json`. Legacy entries that predate `steamAppId` are backfilled from the same resolved value, while any conflicting non-empty `steamAppId` still aborts the write.

## Example Integration

The current Portable Version integration is documented in [docs/portable-version-migration.md](/home/newbe36524/repos/hagicode-mono/repos/steam_packer/docs/portable-version-migration.md).
