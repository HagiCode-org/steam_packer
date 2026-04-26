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
import { fetchIndexManifest, getAssetEntries, resolveVersionEntry } from './lib/index-source.mjs';
import { annotateError, appendSummary } from './lib/summary.mjs';
import { getPlatformConfig, getRequestedAssetPlatforms } from './lib/platforms.mjs';
import { resolveToolchainRoots } from './lib/toolchain.mjs';
import { validateDesktopToolchainContract } from './lib/desktop-toolchain-contract.mjs';

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

function supportsArchiveExtraction(assetName) {
  const normalized = String(assetName ?? '').toLowerCase();
  return normalized.endsWith('.zip') || normalized.endsWith('.tar.gz') || normalized.endsWith('.tar.xz');
}

function matchesPlatformDesktopAsset(asset, platform) {
  return platform.desktopAssetPatterns.some((pattern) => pattern.test(asset.name));
}

async function validatePreparedDesktopWorkspace({ desktopWorkspace, platform }) {
  const desktopAppRoot = await resolveDesktopAppRoot(desktopWorkspace, platform);
  const portableFixedRoot = path.join(desktopAppRoot, ...platform.portableFixedSegments);
  if (!(await pathExists(portableFixedRoot))) {
    throw new Error(`Desktop workspace does not contain ${portableFixedRoot}.`);
  }

  const toolchainRoots = resolveToolchainRoots(portableFixedRoot);
  const toolchainValidation = await validateDesktopToolchainContract({
    platformContentRoot: desktopAppRoot,
    platformId: platform.id
  });

  if (!toolchainValidation.valid) {
    throw new Error(toolchainValidation.errors.join('; '));
  }

  return {
    desktopAppRoot,
    portableFixedRoot,
    toolchainRoots,
    toolchainValidation
  };
}

async function listDesktopAssetCandidates({ manifestUrl, version, platformId, selectedAssetName, fetchImpl }) {
  const platform = getPlatformConfig(platformId);
  const manifest = await fetchIndexManifest(manifestUrl, { fetchImpl });
  const versionEntry = resolveVersionEntry({
    manifest,
    selector: version,
    sourceLabel: 'Desktop'
  });

  return getAssetEntries(versionEntry)
    .filter((asset) => asset?.name && asset.name !== selectedAssetName)
    .filter((asset) => supportsArchiveExtraction(asset.name))
    .filter((asset) => matchesPlatformDesktopAsset(asset, platform))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function attemptDesktopAsset({
  asset,
  sourceUrl,
  workspacePath,
  desktopWorkspace,
  downloadDirectory,
  platform
}) {
  const archivePath = path.join(downloadDirectory, asset.name);
  await cleanDir(desktopWorkspace);
  await downloadFromSource({ sourceUrl, destinationPath: archivePath });
  await extractArchive(archivePath, desktopWorkspace);

  const prepared = await validatePreparedDesktopWorkspace({
    desktopWorkspace,
    platform
  });

  return {
    ...prepared,
    desktopArchivePath: archivePath,
    asset,
    assetSource: sourceUrl
  };
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
  const desktopWorkspace = path.join(extractDirectory, 'desktop');

  await cleanDir(workspacePath);
  await ensureDir(downloadDirectory);
  await ensureDir(outputDirectory);
  await ensureDir(desktopWorkspace);

  const attemptedAssets = [];
  let selectedDesktopAsset = desktopAsset;
  let selectedAssetSource = resolveAssetDownloadUrl({
    asset: desktopAsset,
    sasUrl: azureSasUrl,
    overrideSource: values['desktop-asset-source']
  });
  let preparedDesktop;

  try {
    preparedDesktop = await attemptDesktopAsset({
      asset: selectedDesktopAsset,
      sourceUrl: selectedAssetSource,
      workspacePath,
      desktopWorkspace,
      downloadDirectory,
      platform
    });
    attemptedAssets.push({
      name: selectedDesktopAsset.name,
      path: selectedDesktopAsset.path,
      source: sanitizeUrlForLogs(selectedAssetSource),
      status: 'accepted'
    });
  } catch (initialError) {
    attemptedAssets.push({
      name: selectedDesktopAsset.name,
      path: selectedDesktopAsset.path,
      source: sanitizeUrlForLogs(selectedAssetSource),
      status: 'rejected',
      reason: initialError.message
    });

    if (values['desktop-asset-source']) {
      throw initialError;
    }

    const fallbackAssets = await listDesktopAssetCandidates({
      manifestUrl: plan.upstream.desktop.manifestUrl,
      version: plan.upstream.desktop.version,
      platformId: platform.id,
      selectedAssetName: selectedDesktopAsset.name
    });

    let fallbackError = initialError;
    for (const fallbackAsset of fallbackAssets) {
      const fallbackSource = resolveAssetDownloadUrl({
        asset: fallbackAsset,
        sasUrl: azureSasUrl
      });

      try {
        preparedDesktop = await attemptDesktopAsset({
          asset: fallbackAsset,
          sourceUrl: fallbackSource,
          workspacePath,
          desktopWorkspace,
          downloadDirectory,
          platform
        });
        selectedDesktopAsset = fallbackAsset;
        selectedAssetSource = fallbackSource;
        attemptedAssets.push({
          name: fallbackAsset.name,
          path: fallbackAsset.path,
          source: sanitizeUrlForLogs(fallbackSource),
          status: 'accepted'
        });
        fallbackError = null;
        break;
      } catch (candidateError) {
        attemptedAssets.push({
          name: fallbackAsset.name,
          path: fallbackAsset.path,
          source: sanitizeUrlForLogs(fallbackSource),
          status: 'rejected',
          reason: candidateError.message
        });
        fallbackError = candidateError;
      }
    }

    if (fallbackError) {
      throw new Error(
        `Desktop asset validation failed for ${platform.id}. Attempted assets: ${attemptedAssets
          .map((entry) => `${entry.name} [${entry.status}]${entry.reason ? ` ${entry.reason}` : ''}`)
          .join(' | ')}`
      );
    }
  }

  const {
    desktopAppRoot,
    portableFixedRoot,
    toolchainRoots,
    toolchainValidation,
    desktopArchivePath
  } = preparedDesktop;

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
    desktopAssetName: selectedDesktopAsset.name,
    desktopAssetPath: selectedDesktopAsset.path,
    desktopArchivePath,
    desktopDownloadSource: sanitizeUrlForLogs(selectedAssetSource),
    requestedDesktopAssetName: desktopAsset.name,
    requestedDesktopAssetPath: desktopAsset.path,
    desktopAssetFallbackUsed: selectedDesktopAsset.name !== desktopAsset.name,
    attemptedDesktopAssets: attemptedAssets,
    bundle: platform.bundle ?? null,
    toolchainRoot: toolchainRoots.toolchainRoot,
    toolchainBinRoot: toolchainRoots.toolchainBinRoot,
    toolchainManifestPath: toolchainRoots.toolchainManifestPath,
    toolchainActivationPolicy: toolchainValidation.activationPolicy,
    bundledToolchainEnabled: toolchainValidation.activationPolicy?.enabled ?? false,
    dryRun: plan.build.dryRun
  };
  const workspaceManifestPath = path.join(workspacePath, 'workspace-manifest.json');
  await writeJson(workspaceManifestPath, workspaceManifest);

  await appendSummary([
    `### Workspace prepared for ${platform.id}`,
    `- Desktop version: ${plan.upstream.desktop.version}`,
    `- Desktop asset: ${selectedDesktopAsset.name}`,
    `- Desktop asset platform: ${desktopAssetPlatform}`,
    `- Download source: ${sanitizeUrlForLogs(selectedAssetSource)}`,
    `- Workspace: ${workspacePath}`,
    `- Portable root: ${portableFixedRoot}`
  ]);

  if (selectedDesktopAsset.name !== desktopAsset.name) {
    await appendSummary([
      `- Requested asset: ${desktopAsset.name}`,
      `- Fallback asset selected: ${selectedDesktopAsset.name}`
    ]);
  }

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
