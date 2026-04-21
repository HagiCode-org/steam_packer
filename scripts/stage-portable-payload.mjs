#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { downloadFromSource, resolveAssetDownloadUrl, sanitizeUrlForLogs } from './lib/azure-blob.mjs';
import { extractArchive } from './lib/archive.mjs';
import {
  cleanDir,
  copyDir,
  ensureDir,
  findFirstMatchingDirectory,
  pathExists,
  readJson,
  writeJson
} from './lib/fs-utils.mjs';
import { annotateError, appendSummary } from './lib/summary.mjs';
import { getBundleConfig, getRequestedAssetPlatforms } from './lib/platforms.mjs';

const REQUIRED_PAYLOAD_PATHS = [
  'manifest.json',
  path.join('config'),
  path.join('lib', 'PCode.Web.dll'),
  path.join('lib', 'PCode.Web.runtimeconfig.json'),
  path.join('lib', 'PCode.Web.deps.json')
];

async function resolveRuntimeRoot(extractedRoot) {
  const directManifest = path.join(extractedRoot, 'manifest.json');
  const directLibDll = path.join(extractedRoot, 'lib', 'PCode.Web.dll');
  if ((await pathExists(directManifest)) || (await pathExists(directLibDll))) {
    return extractedRoot;
  }

  const nested = await findFirstMatchingDirectory(extractedRoot, async (candidate) => {
    const manifestPath = path.join(candidate, 'manifest.json');
    const dllPath = path.join(candidate, 'lib', 'PCode.Web.dll');
    return (await pathExists(manifestPath)) || (await pathExists(dllPath));
  });

  return nested;
}

async function validatePayloadRoot(runtimeRoot, platformId) {
  const missing = [];
  for (const relativePath of REQUIRED_PAYLOAD_PATHS) {
    const absolutePath = path.join(runtimeRoot, relativePath);
    if (!(await pathExists(absolutePath))) {
      missing.push(relativePath);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Portable payload for ${platformId} is incomplete under ${runtimeRoot}. Missing: ${missing.join(', ')}`
    );
  }
}

async function loadSourceOverrideMap(value) {
  if (!value) {
    return {};
  }

  const candidatePath = path.resolve(value);
  if (await pathExists(candidatePath)) {
    return readJson(candidatePath);
  }

  return JSON.parse(value);
}

function resolvePlatformOverrideSource({ platformId, directOverride, overrideMap }) {
  if (overrideMap && typeof overrideMap === 'object' && typeof overrideMap[platformId] === 'string') {
    return overrideMap[platformId];
  }

  return directOverride;
}

async function stagePayloadMember({
  plan,
  workspaceManifest,
  platformId,
  azureSasUrl,
  directOverride,
  overrideMap,
  targetPath
}) {
  const asset = plan.upstream.service.assetsByPlatform?.[platformId];
  if (!asset) {
    throw new Error(`No service asset mapped for platform ${platformId}.`);
  }

  const downloadPath = path.join(workspaceManifest.downloadDirectory, `${platformId}-${asset.name}`);
  const extractionPath = path.join(workspaceManifest.extractDirectory, platformId);
  await ensureDir(workspaceManifest.downloadDirectory);
  await cleanDir(extractionPath);

  const overrideSource = resolvePlatformOverrideSource({
    platformId,
    directOverride,
    overrideMap
  });
  const assetSource = resolveAssetDownloadUrl({
    asset,
    sasUrl: azureSasUrl,
    overrideSource
  });

  await downloadFromSource({ sourceUrl: assetSource, destinationPath: downloadPath });
  await extractArchive(downloadPath, extractionPath);

  const runtimeRoot = await resolveRuntimeRoot(extractionPath);
  if (!runtimeRoot) {
    throw new Error(`Unable to find an extracted portable runtime for ${platformId} under ${extractionPath}.`);
  }

  await validatePayloadRoot(runtimeRoot, platformId);
  await copyDir(runtimeRoot, targetPath);

  return {
    platform: platformId,
    assetName: asset.name,
    assetPath: asset.path,
    downloadSource: sanitizeUrlForLogs(assetSource),
    downloadPath,
    extractionPath,
    runtimeRoot,
    stagedRuntimeRoot: targetPath,
    requiredPaths: REQUIRED_PAYLOAD_PATHS.map((entry) => entry.replaceAll(path.sep, '/'))
  };
}

function createUniversalBundleManifest(bundleConfig, stagedCurrentPath, members) {
  const memberPlatforms = members.map((member) => member.platform);
  return {
    schemaVersion: 1,
    kind: bundleConfig.kind,
    publicationPlatform: bundleConfig.publicationPlatform,
    currentLayout: 'portable-fixed/current/{osx-x64,osx-arm64}',
    fallbackRule: 'When this manifest is absent, Desktop must treat portable-fixed/current as the legacy single-root payload.',
    manifestPath: path.join(stagedCurrentPath, bundleConfig.manifestFileName).replaceAll(path.sep, '/'),
    includedPlatforms: memberPlatforms,
    members: members.map((member) => ({
      platform: member.platform,
      relativePath: path.relative(stagedCurrentPath, member.stagedRuntimeRoot).replaceAll(path.sep, '/'),
      requiredPaths: member.requiredPaths
    }))
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      platform: { type: 'string' },
      workspace: { type: 'string' },
      'azure-sas-url': { type: 'string' },
      'service-asset-source': { type: 'string' },
      'service-asset-source-map': { type: 'string' }
    }
  });

  if (!values.plan || !values.platform || !values.workspace) {
    throw new Error('stage-portable-payload requires --plan, --platform, and --workspace.');
  }

  const plan = await readJson(path.resolve(values.plan));
  const workspacePath = path.resolve(values.workspace);
  const workspaceManifest = await readJson(path.join(workspacePath, 'workspace-manifest.json'));
  const azureSasUrl =
    values['azure-sas-url'] ??
    process.env.STEAM_PACKER_SERVICE_AZURE_SAS_URL ??
    process.env.SERVICE_AZURE_SAS_URL ??
    process.env.SERVICE_AZURE_BLOB_SAS_URL ??
    process.env.AZURE_BLOB_SAS_URL ??
    process.env.AZURE_SAS_URL;
  const assetPlatforms = getRequestedAssetPlatforms(values.platform, 'service');
  const bundleConfig = getBundleConfig(values.platform);
  const stagedCurrentPath = path.join(workspaceManifest.portableFixedRoot, 'current');
  const overrideMap = await loadSourceOverrideMap(values['service-asset-source-map']);

  await ensureDir(workspaceManifest.portableFixedRoot);
  await cleanDir(stagedCurrentPath);

  const members = [];
  for (const assetPlatform of assetPlatforms) {
    const memberTargetPath = bundleConfig
      ? path.join(stagedCurrentPath, assetPlatform)
      : stagedCurrentPath;
    members.push(await stagePayloadMember({
      plan,
      workspaceManifest,
      platformId: assetPlatform,
      azureSasUrl,
      directOverride: values['service-asset-source'],
      overrideMap,
      targetPath: memberTargetPath
    }));
  }

  let validationReport;
  if (bundleConfig) {
    // Universal macOS bundles keep the stable current/ root and place each runtime member below it.
    const bundleManifest = createUniversalBundleManifest(bundleConfig, stagedCurrentPath, members);
    const bundleManifestPath = path.join(stagedCurrentPath, bundleConfig.manifestFileName);
    await writeJson(bundleManifestPath, bundleManifest);

    validationReport = {
      platform: values.platform,
      serviceVersion: plan.upstream.service.version,
      portableFixedRoot: workspaceManifest.portableFixedRoot,
      stagedCurrentPath,
      bundle: bundleManifest,
      members
    };
  } else {
    const [singleMember] = members;
    validationReport = {
      platform: values.platform,
      serviceVersion: plan.upstream.service.version,
      assetName: singleMember.assetName,
      assetPath: singleMember.assetPath,
      downloadSource: singleMember.downloadSource,
      downloadPath: singleMember.downloadPath,
      extractionPath: singleMember.extractionPath,
      runtimeRoot: singleMember.runtimeRoot,
      portableFixedRoot: workspaceManifest.portableFixedRoot,
      stagedCurrentPath,
      requiredPaths: singleMember.requiredPaths
    };
  }

  const validationReportPath = path.join(workspacePath, `payload-validation-${values.platform}.json`);
  await writeJson(validationReportPath, validationReport);

  const summaryLines = [
    `### Portable payload staged for ${values.platform}`,
    `- Service version: ${plan.upstream.service.version}`,
    `- Staged path: ${stagedCurrentPath}`
  ];
  if (bundleConfig) {
    summaryLines.push(`- Bundled architectures: ${members.map((member) => member.platform).join(', ')}`);
    summaryLines.push(`- Bundle manifest: ${path.join(stagedCurrentPath, bundleConfig.manifestFileName)}`);
  } else {
    summaryLines.push(`- Asset: ${members[0].assetName}`);
    summaryLines.push(`- Download source: ${members[0].downloadSource}`);
    summaryLines.push(`- Extracted root: ${members[0].runtimeRoot}`);
  }
  await appendSummary(summaryLines);

  console.log(
    JSON.stringify(
      {
        validationReportPath,
        stagedCurrentPath,
        bundledPlatforms: bundleConfig ? members.map((member) => member.platform) : []
      },
      null,
      2
    )
  );
}

main().catch(async (error) => {
  annotateError(error.message);
  await appendSummary([
    '## Portable payload staging failed',
    `- ${error.message}`
  ]);
  console.error(error);
  process.exitCode = 1;
});
