# steam_packer

`steam_packer` is the execution repository for Portable Version packaging and Azure publication.

It accepts a normalized handoff payload from `portable-version`, assembles the packaging workspace, stages the payload and bundled toolchain, repacks deterministic platform archives, uploads them to Azure Blob Storage, and refreshes the root `hagicode-steam/index.json` entry without changing the downstream Steam hydration contract.

## Repository Role

- Owns Portable Version packaging-safe workspace assembly
- Owns archive generation, artifact inventory, and checksum emission
- Owns Azure Blob publication and root-index refresh
- Exposes a reusable workflow for delegated CI execution
- Keeps release metadata compatible with `portable-version-steam-release`

`portable-version` remains responsible for trigger orchestration, version selection, release-tag derivation, and Steam publication entrypoints.

## Handoff Contract

The delegated input is the build-plan artifact emitted by `repos/portable-version/scripts/resolve-build-plan.mjs`.

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
- `handoff.schema = portable-version-steam-packer-handoff/v1`

`steam_packer` validates the handoff before any workspace mutation. Missing fields fail fast at the `build-plan-validation` stage.

## Workflow Entry

Reusable workflow:

- `.github/workflows/portable-version-package.yml`

Expected caller behavior:

1. `portable-version` resolves the build plan and uploads it as an artifact.
2. `portable-version` calls the reusable workflow in `steam_packer`.
3. `steam_packer` validates the handoff and fans out packaging by platform.
4. `steam_packer` publishes merged metadata and refreshes the Azure root index.

## Local Verification

From `repos/steam_packer`:

```bash
npm test
npm run verify:dry-run
npm run verify:publication
npm run verify:handoff
```

## Local Delegated Run

For fixture-driven diagnostics:

```bash
node scripts/run-portable-version-handoff.mjs \
  --plan /path/to/build-plan.json \
  --desktop-asset-source /path/to/desktop.zip \
  --service-asset-source /path/to/service.zip \
  --toolchain-config /path/to/portable-toolchain.json \
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
- `steamDepotIds.linux`
- `steamDepotIds.windows`
- `steamDepotIds.macos`
- `artifacts[]`

See [docs/portable-version-migration.md](/home/newbe36524/repos/hagicode-mono/repos/steam_packer/docs/portable-version-migration.md) for maintainer migration notes.
