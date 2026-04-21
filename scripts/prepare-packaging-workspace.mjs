#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { downloadFromSource, resolveAssetDownloadUrl, sanitizeUrlForLogs } from './lib/azure-blob.mjs';
import { extractArchive } from './lib/archive.mjs';
import {
  cleanDir,
  ensureDir,
  findFirstMatchingDirectory,
  pathExists,
  readJson,
  writeJson
} from './lib/fs-utils.mjs';
import { annotateError, appendSummary } from './lib/summary.mjs';
import { getPlatformConfig, getRequestedAssetPlatforms } from './lib/platforms.mjs';
import { resolveToolchainRoots } from './lib/toolchain.mjs';

async function directoryContainsPortableRoot(rootPath, portableFixedSegments) {
  return pathExists(path.join(rootPath, ...portableFixedSegments));
}

async function resolveDesktopAppRoot(extractionRoot, platform) {
  if (await directoryContainsPortableRoot(extractionRoot, platform.portableFixedSegments)) {
    return extractionRoot;
  }

  if (platform.appBundleName) {
    const directAppRoot = path.join(extractionRoot, platform.appBundleName);
    if (await directoryContainsPortableRoot(directAppRoot, platform.portableFixedSegments)) {
      return directAppRoot;
    }
  }

  const discoveredRoot = await findFirstMatchingDirectory(
    extractionRoot,
    async (candidate) => directoryContainsPortableRoot(candidate, platform.portableFixedSegments)
  );
  if (discoveredRoot) {
    return discoveredRoot;
  }

  throw new Error(`Unable to find Desktop app root for ${platform.id} under ${extractionRoot}.`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      platform: { type: 'string' },
      workspace: { type: 'string' },
      'azure-sas-url': { type: 'string' },
      'desktop-asset-source': { type: 'string' }
    }
  });

  if (!values.plan || !values.platform || !values.workspace) {
    throw new Error('prepare-packaging-workspace requires --plan, --platform, and --workspace.');
  }

  const planPath = path.resolve(values.plan);
  const workspacePath = path.resolve(values.workspace);
  const platformId = values.platform;
  const plan = await readJson(planPath);
  const platform = getPlatformConfig(platformId);
  const [desktopAssetPlatform] = getRequestedAssetPlatforms(platformId, 'desktop');
  const desktopAsset = plan.upstream.desktop.assetsByPlatform?.[desktopAssetPlatform];
  if (!desktopAsset) {
    throw new Error(`No Desktop asset mapped for platform ${platformId} (source platform ${desktopAssetPlatform}).`);
  }

  const azureSasUrl =
    values['azure-sas-url'] ??
    process.env.STEAM_PACKER_DESKTOP_AZURE_SAS_URL ??
    process.env.DESKTOP_AZURE_SAS_URL ??
    process.env.DESKTOP_AZURE_BLOB_SAS_URL ??
    process.env.AZURE_BLOB_SAS_URL ??
    process.env.AZURE_SAS_URL;
  const downloadDirectory = path.join(workspacePath, 'downloads');
  const extractDirectory = path.join(workspacePath, 'extracted');
  const outputDirectory = path.join(workspacePath, 'release-assets');
  const desktopArchivePath = path.join(downloadDirectory, desktopAsset.name);
  const desktopWorkspace = path.join(extractDirectory, 'desktop');

  await cleanDir(workspacePath);
  await ensureDir(downloadDirectory);
  await ensureDir(outputDirectory);
  await ensureDir(desktopWorkspace);

  const assetSource = resolveAssetDownloadUrl({
    asset: desktopAsset,
    sasUrl: azureSasUrl,
    overrideSource: values['desktop-asset-source']
  });
  await downloadFromSource({ sourceUrl: assetSource, destinationPath: desktopArchivePath });
  await extractArchive(desktopArchivePath, desktopWorkspace);

  const desktopAppRoot = await resolveDesktopAppRoot(desktopWorkspace, platform);
  const portableFixedRoot = path.join(desktopAppRoot, ...platform.portableFixedSegments);
  if (!(await pathExists(portableFixedRoot))) {
    throw new Error(`Desktop asset ${desktopAsset.name} does not contain ${portableFixedRoot}.`);
  }
  const toolchainRoots = resolveToolchainRoots(portableFixedRoot);

  const workspaceManifest = {
    planPath,
    platform: platform.id,
    runtimeKey: platform.runtimeKey,
    desktopWorkspace,
    desktopAppRoot,
    portableFixedRoot,
    downloadDirectory,
    extractDirectory,
    outputDirectory,
    desktopVersion: plan.upstream.desktop.version,
    desktopAssetPlatform,
    desktopAssetName: desktopAsset.name,
    desktopAssetPath: desktopAsset.path,
    desktopArchivePath,
    desktopDownloadSource: sanitizeUrlForLogs(assetSource),
    bundle: platform.bundle ?? null,
    toolchainRoot: toolchainRoots.toolchainRoot,
    toolchainBinRoot: toolchainRoots.toolchainBinRoot,
    toolchainManifestPath: toolchainRoots.toolchainManifestPath,
    dryRun: plan.build.dryRun
  };
  const workspaceManifestPath = path.join(workspacePath, 'workspace-manifest.json');
  await writeJson(workspaceManifestPath, workspaceManifest);

  await appendSummary([
    `### Workspace prepared for ${platform.id}`,
    `- Desktop version: ${plan.upstream.desktop.version}`,
    `- Desktop asset: ${desktopAsset.name}`,
    `- Desktop asset platform: ${desktopAssetPlatform}`,
    `- Download source: ${sanitizeUrlForLogs(assetSource)}`,
    `- Workspace: ${workspacePath}`,
    `- Portable root: ${portableFixedRoot}`
  ]);

  console.log(JSON.stringify({ workspaceManifestPath, desktopWorkspace }, null, 2));
}

main().catch(async (error) => {
  annotateError(error.message);
  await appendSummary([
    '## Workspace preparation failed',
    `- ${error.message}`
  ]);
  console.error(error);
  process.exitCode = 1;
});
