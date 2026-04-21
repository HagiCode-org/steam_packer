# Portable Version Migration

`steam_packer` is now the execution owner for Portable Version packaging and Azure publication.

## What Moved

- Packaging-safe workspace assembly
- Desktop archive repacking
- Portable payload and toolchain staging
- Artifact inventory and checksum generation
- Azure Blob upload and root `index.json` refresh

## What Stays In `portable-version`

- Trigger entrypoints (`schedule`, `workflow_dispatch`, `repository_dispatch`)
- Version resolution and release-tag derivation
- Build-plan / handoff payload generation
- Steam release hydration and Steam upload workflows

## Maintainer Workflow

### Dry run

From `repos/steam_packer`:

```bash
npm run verify:dry-run
```

This validates delegated packaging without Azure writes and confirms that the merged metadata remains complete enough for publication and later Steam hydration.

### Force rebuild

Use `portable-version-release` with `force_rebuild=true`. The rebuild intent stays in the handoff payload and `steam_packer` executes the same release tag again while preserving root-index upsert semantics.

### Platform matrix

`portable-version` continues to normalize platform intent. The delegated handoff already contains `platforms[]` and `platformMatrix.include[]`, so `steam_packer` should not infer or expand platforms interactively.

### Failure attribution

For local diagnostics or CI assertions, use:

```bash
node scripts/run-portable-version-handoff.mjs --plan <path-to-build-plan.json>
```

Failure stages are attributed as:

- `build-plan-validation`
- `delegated-packaging`
- `azure-publication`

### Primary Troubleshooting Entry Points

- Handoff shape or release intent problems: `repos/portable-version/scripts/resolve-build-plan.mjs`
- Delegated packaging / publication problems: `repos/steam_packer/scripts/run-portable-version-handoff.mjs`
- Steam hydration problems: `repos/portable-version/scripts/prepare-steam-release-input.mjs`
