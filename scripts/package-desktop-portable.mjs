#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createArchive } from './lib/archive.mjs';
import { createArtifactRecord } from './lib/artifacts.mjs';
import { writeChecksumFile } from './lib/checksum.mjs';
import { ensureDir, pathExists, readJson, writeJson } from './lib/fs-utils.mjs';
import { annotateError, appendSummary } from './lib/summary.mjs';
import { buildDeterministicAssetName, getPlatformConfig } from './lib/platforms.mjs';

async function validateUniversalBundle(bundle, stagedCurrentPath) {
  if (!Array.isArray(bundle?.members) || bundle.members.length === 0) {
    throw new Error('Universal macOS payload metadata is missing bundle members.');
  }

  for (const member of bundle.members) {
    const memberRoot = path.join(stagedCurrentPath, member.relativePath);
    for (const requiredPath of member.requiredPaths ?? []) {
      const absolutePath = path.join(memberRoot, requiredPath);
      if (!(await pathExists(absolutePath))) {
        throw new Error(
          `Universal macOS payload validation failed for ${member.platform}. Missing ${requiredPath} under ${memberRoot}.`
        );
      }
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      platform: { type: 'string' },
      workspace: { type: 'string' },
      'force-dry-run': { type: 'boolean', default: false }
    }
  });

  if (!values.plan || !values.platform || !values.workspace) {
    throw new Error('package-desktop-portable requires --plan, --platform, and --workspace.');
  }

  const plan = await readJson(path.resolve(values.plan));
  const workspacePath = path.resolve(values.workspace);
  const workspaceManifest = await readJson(path.join(workspacePath, 'workspace-manifest.json'));
  getPlatformConfig(values.platform);
  const stagedCurrentPath = path.join(workspaceManifest.portableFixedRoot, 'current');
  const stagedToolchainPath = workspaceManifest.toolchainRoot ?? path.join(workspaceManifest.portableFixedRoot, 'toolchain');
  const toolchainManifestPath =
    workspaceManifest.toolchainManifestPath ?? path.join(stagedToolchainPath, 'toolchain-manifest.json');
  const toolchainValidationPath = path.join(workspacePath, `toolchain-validation-${values.platform}.json`);
  if (!(await pathExists(stagedCurrentPath))) {
    throw new Error(`Portable payload is not staged at ${stagedCurrentPath}.`);
  }
  if (!(await pathExists(stagedToolchainPath))) {
    throw new Error(`Portable toolchain is not staged at ${stagedToolchainPath}.`);
  }
  if (!(await pathExists(toolchainManifestPath))) {
    throw new Error(`Portable toolchain manifest is missing at ${toolchainManifestPath}.`);
  }
  if (!(await pathExists(toolchainValidationPath))) {
    throw new Error(`Portable toolchain validation report is missing at ${toolchainValidationPath}.`);
  }
  const toolchainValidation = await readJson(toolchainValidationPath);
  if (!toolchainValidation.validationPassed) {
    throw new Error(`Portable toolchain validation failed for ${values.platform}.`);
  }
  const payloadValidationPath = path.join(workspacePath, `payload-validation-${values.platform}.json`);
  if (!(await pathExists(payloadValidationPath))) {
    throw new Error(`Portable payload validation report is missing at ${payloadValidationPath}.`);
  }
  const payloadValidation = await readJson(payloadValidationPath);
  const bundle = payloadValidation.bundle ?? null;
  if (bundle?.kind === 'macos-universal') {
    await validateUniversalBundle(bundle, stagedCurrentPath);
  }

  await ensureDir(workspaceManifest.outputDirectory);

  const dryRun = values['force-dry-run'] || Boolean(plan.build.dryRun);
  const packagedFileName = buildDeterministicAssetName(
    plan.release.tag,
    values.platform,
    workspaceManifest.desktopAssetName
  );
  const packagedArchivePath = path.join(workspaceManifest.outputDirectory, packagedFileName);
  await createArchive(workspaceManifest.desktopWorkspace, packagedArchivePath);
  const inventory = [
    await createArtifactRecord({
      archivePath: packagedArchivePath,
      platformId: values.platform,
      metadata: bundle
        ? {
            bundledPlatforms: [...bundle.includedPlatforms]
          }
        : {}
    })
  ];

  const inventoryPath = path.join(workspacePath, `artifact-inventory-${values.platform}.json`);
  const checksumsPath = path.join(workspacePath, `artifact-checksums-${values.platform}.txt`);
  await writeJson(inventoryPath, {
    releaseTag: plan.release.tag,
    platform: values.platform,
    dryRun,
    payloadValidationPath,
    toolchainValidationPath,
    bundle,
    artifacts: inventory
  });
  await writeChecksumFile(inventory, checksumsPath);

  const summaryLines = [
    `### Packaging complete for ${values.platform}`,
    `- Release tag: ${plan.release.tag}`,
    `- Mode: ${dryRun ? 'dry-run' : 'publish-ready'}`,
    `- Inventory: ${inventoryPath}`,
    `- Checksums: ${checksumsPath}`,
    `- Toolchain validation: ${toolchainValidationPath}`,
    `- Artifacts: ${inventory.map((entry) => entry.fileName).join(', ')}`
  ];
  if (bundle?.kind === 'macos-universal') {
    summaryLines.push(`- Bundled architectures: ${bundle.includedPlatforms.join(', ')}`);
    summaryLines.push(`- Publication platform: ${bundle.publicationPlatform}`);
  }
  await appendSummary(summaryLines);

  console.log(JSON.stringify({ inventoryPath, checksumsPath, artifactCount: inventory.length }, null, 2));
}

main().catch(async (error) => {
  annotateError(error.message);
  await appendSummary([
    '## Packaging failed',
    `- ${error.message}`
  ]);
  console.error(error);
  process.exitCode = 1;
});
