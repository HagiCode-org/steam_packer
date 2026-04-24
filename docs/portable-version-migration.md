# Portable Version Migration

`steam_packer` stays independent. `portable-version` is just the current upstream caller for Portable Version packaging and Azure publication.

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

### Force rebuild

Regenerate the handoff payload with `repos/portable-version/scripts/resolve-build-plan.mjs`, set `force_rebuild=true` in that input, and pass the plan to `steam_packer`. The rebuild intent stays in the handoff payload and `steam_packer` executes the same release tag again while preserving root-index upsert semantics.

### Platform matrix

`portable-version` continues to normalize platform intent. The delegated handoff already contains `platforms[]` and `platformMatrix.include[]`, so `steam_packer` should not infer or expand platforms interactively.

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

`hagicode-desktop` builds and ships `portable-fixed/toolchain`. `steam_packer` must not actively download Node, run npm installs, or preinstall OpenSpec/Skills/Omniroute. Its packaging flow validates the Desktop-authored `toolchain-manifest.json` with `owner=hagicode-desktop` and `source=bundled-desktop`, then carries that validated directory into the final archive.

The reusable `package-release` workflow now consumes the shared Steam dataset from `https://index.hagicode.com/steam/index.json` directly during publication. Local and standalone runs use the same online source by default, while `--steam-data-path` remains available when a maintainer needs to pin a local JSON fixture or a different explicit URL.

### Primary Troubleshooting Entry Points

- Handoff shape or release intent problems: `repos/portable-version/scripts/resolve-build-plan.mjs`
- Packaging / publication problems: `repos/steam_packer/scripts/run-release-plan.mjs`
- Steam hydration problems: `repos/portable-version/scripts/prepare-steam-release-input.mjs`
