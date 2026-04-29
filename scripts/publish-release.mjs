#!/usr/bin/env node
import path from 'node:path';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  fetchPortableVersionRootIndex,
  findPortableVersionReleaseByTag,
  listAzureBlobs,
  normalizePortableVersionVersionEntry,
  parseAzureSasUrl,
  sanitizeUrlForLogs,
  uploadAzureBlob,
  upsertPortableVersionRootIndexEntry,
  writePortableVersionRootIndex
} from './lib/azure-blob.mjs';
import { ensureDir, pathExists, readJson, writeJson } from './lib/fs-utils.mjs';
import {
  DEFAULT_STEAM_APP_KEY,
  resolveSteamPublicationIdentity
} from './lib/steam-data.mjs';
import { upsertReleaseNotes } from './lib/github.mjs';
import { annotateError, appendSummary } from './lib/summary.mjs';

const DEFAULT_PUBLICATION_UPLOAD_CONCURRENCY = 3;

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return normalized;
}

function resolveSteamAppKey(value) {
  return requireNonEmptyString(
    value ?? process.env.STEAM_PACKER_STEAM_APP_KEY ?? process.env.STEAM_APP_KEY ?? DEFAULT_STEAM_APP_KEY,
    'steamAppKey'
  );
}

function resolveSteamDataPath(value) {
  const configuredPath =
    value ?? process.env.STEAM_PACKER_STEAM_DATA_PATH ?? process.env.STEAM_DATA_PATH;

  if (!configuredPath) {
    return undefined;
  }

  return /^https?:\/\//i.test(configuredPath) ? configuredPath : path.resolve(configuredPath);
}

function resolveSteamAzureSasUrl(value) {
  const sasUrl =
    value ??
    process.env.STEAM_PACKER_STEAM_AZURE_SAS_URL ??
    process.env.STEAM_AZURE_SAS_URL ??
    process.env.AZURE_BLOB_SAS_URL ??
    process.env.AZURE_SAS_URL;

  return sasUrl ? parseAzureSasUrl(sasUrl).toString() : null;
}

function resolveGitHubToken(value) {
  const token = value ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return token ? requireNonEmptyString(token, 'githubToken') : null;
}

function stripQueryFromUrl(url) {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url).replace(/\?.*$/, '');
  }
}

function assertLegacyDepotOverridesMatchSharedData(sharedSteamDepotIds, overrides = {}) {
  const legacyDepotIds = {
    linux: overrides.linuxDepotId,
    windows: overrides.windowsDepotId,
    macos: overrides.macosDepotId
  };

  for (const [platform, value] of Object.entries(legacyDepotIds)) {
    if (value === undefined || value === null || String(value).trim() === '') {
      continue;
    }

    const normalizedValue = requireNonEmptyString(value, `steamDepotIds.${platform}`);
    if (normalizedValue !== sharedSteamDepotIds[platform]) {
      throw new Error(
        `Deprecated steamDepotIds.${platform} override ${JSON.stringify(normalizedValue)} conflicts with shared Steam dataset value ${JSON.stringify(sharedSteamDepotIds[platform])}.`
      );
    }
  }
}

function buildMetadataBlobPaths(releaseTag) {
  return {
    buildManifestPath: `${releaseTag}/${releaseTag}.build-manifest.json`,
    artifactInventoryPath: `${releaseTag}/${releaseTag}.artifact-inventory.json`,
    checksumsPath: `${releaseTag}/${releaseTag}.checksums.txt`
  };
}

async function resolveArtifactUploadPath(artifactsDir, artifact) {
  const candidates = [
    artifact.outputPath,
    path.join(artifactsDir, artifact.fileName),
    path.join(artifactsDir, 'release-assets', artifact.fileName)
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to find uploaded artifact ${artifact.fileName}. Checked: ${candidates.join(', ')}`
  );
}

async function buildPublicationArtifacts({ plan, artifactsDir, outputDir }) {
  const releaseTag = plan.release.tag;
  const metadataBlobPaths = buildMetadataBlobPaths(releaseTag);

  const entries = await readdir(artifactsDir);
  const inventoryFiles = entries.filter((entry) => entry.startsWith('artifact-inventory-') && entry.endsWith('.json'));
  const checksumFiles = entries.filter((entry) => entry.startsWith('artifact-checksums-') && entry.endsWith('.txt'));
  const inventories = await Promise.all(
    inventoryFiles.sort().map((entry) => readJson(path.join(artifactsDir, entry)))
  );

  const mergedInventory = {
    releaseTag,
    dryRun: Boolean(plan.build.dryRun),
    platforms: inventories.map((inventory) => inventory.platform),
    artifacts: inventories.flatMap((inventory) => inventory.artifacts)
  };
  const mergedInventoryPath = path.join(outputDir, `${releaseTag}.artifact-inventory.json`);
  const buildManifestPath = path.join(outputDir, `${releaseTag}.build-manifest.json`);
  const mergedChecksumsPath = path.join(outputDir, `${releaseTag}.checksums.txt`);

  await writeJson(mergedInventoryPath, mergedInventory);
  await writeJson(buildManifestPath, plan);

  const checksumContents = [];
  for (const checksumFile of checksumFiles.sort()) {
    checksumContents.push((await readFile(path.join(artifactsDir, checksumFile), 'utf8')).trim());
  }
  await writeFile(mergedChecksumsPath, `${checksumContents.filter(Boolean).join('\n')}\n`, 'utf8');

  const releaseAssetFiles = await Promise.all(
    mergedInventory.artifacts.map((artifact) => resolveArtifactUploadPath(artifactsDir, artifact))
  );

  const uploads = [
    ...mergedInventory.artifacts.map((artifact, index) => ({
      kind: 'archive',
      filePath: releaseAssetFiles[index],
      blobPath: `${releaseTag}/${artifact.fileName}`,
      platform: artifact.platform,
      fileName: artifact.fileName
    })),
    {
      kind: 'build-manifest',
      filePath: buildManifestPath,
      blobPath: metadataBlobPaths.buildManifestPath,
      fileName: path.basename(buildManifestPath)
    },
    {
      kind: 'artifact-inventory',
      filePath: mergedInventoryPath,
      blobPath: metadataBlobPaths.artifactInventoryPath,
      fileName: path.basename(mergedInventoryPath)
    },
    {
      kind: 'checksums',
      filePath: mergedChecksumsPath,
      blobPath: metadataBlobPaths.checksumsPath,
      fileName: path.basename(mergedChecksumsPath)
    }
  ];

  return {
    releaseTag,
    mergedInventory,
    mergedInventoryPath,
    buildManifestPath,
    mergedChecksumsPath,
    metadataBlobPaths,
    uploads
  };
}

function createDryRunReport({
  releaseTag,
  steamAzureSasUrl,
  steamAppId,
  steamDepotIds,
  publicationArtifacts,
  outputDir,
  plan
}) {
  const dryRunReportPath = path.join(outputDir, `${releaseTag}.publish-dry-run.json`);
  return {
    dryRunReportPath,
    report: {
      releaseTag,
      releaseIdentity: 'web-only',
      azurePublication: {
        versionDirectory: `${releaseTag}/`,
        containerUrl: steamAzureSasUrl ? sanitizeUrlForLogs(steamAzureSasUrl) : null,
        rootIndexUrl: steamAzureSasUrl
          ? sanitizeUrlForLogs(`${steamAzureSasUrl.replace(/\?.*$/, '').replace(/\/?$/, '/') }index.json`)
          : null
      },
      steamAppId,
      steamDepotIds,
      upstream: {
        desktop: {
          version: plan.upstream.desktop.version,
          manifestUrl: plan.upstream.desktop.manifestUrl
        },
        service: {
          version: plan.upstream.service.version,
          manifestUrl: plan.upstream.service.manifestUrl
        }
      },
      metadata: publicationArtifacts.metadataBlobPaths,
      assetUploads: publicationArtifacts.uploads.map((upload) => ({
        kind: upload.kind,
        platform: upload.platform ?? null,
        fileName: upload.fileName,
        localPath: upload.filePath,
        blobPath: upload.blobPath
      }))
    }
  };
}

function buildResultVersionEntry({ plan, publicationArtifacts, steamAppId, steamDepotIds, publishedAt }) {
  return normalizePortableVersionVersionEntry({
    releaseTag: publicationArtifacts.releaseTag,
    metadata: publicationArtifacts.metadataBlobPaths,
    steamAppId,
    steamDepotIds,
    artifacts: publicationArtifacts.mergedInventory.artifacts,
    upstream: {
      desktop: {
        version: plan.upstream.desktop.version,
        manifestUrl: plan.upstream.desktop.manifestUrl
      },
      service: {
        version: plan.upstream.service.version,
        manifestUrl: plan.upstream.service.manifestUrl
      }
    },
    publishedAt,
    updatedAt: publishedAt
  });
}

function buildGitHubReleaseBody({
  plan,
  releaseTag,
  steamAzureSasUrl,
  rootIndex,
  publicationArtifacts,
  steamAppId,
  steamDepotIds,
  publishedAt
}) {
  const publicContainerUrl = stripQueryFromUrl(steamAzureSasUrl);
  const publicRootIndexUrl = stripQueryFromUrl(rootIndex.indexUrl);

  return [
    `## Portable Version ${releaseTag}`,
    '',
    `- Published at: ${publishedAt}`,
    `- Release tag: ${releaseTag}`,
    `- Desktop version: ${plan.upstream.desktop.version}`,
    `- Desktop manifest source: ${plan.upstream.desktop.manifestUrl}`,
    `- Service version: ${plan.upstream.service.version}`,
    `- Service manifest source: ${plan.upstream.service.manifestUrl}`,
    `- Azure container: ${publicContainerUrl ?? '[unknown]'}`,
    `- Azure version directory: ${releaseTag}/`,
    `- Azure root index: ${publicRootIndexUrl ?? '[unknown]'}`,
    `- Build manifest path: ${publicationArtifacts.metadataBlobPaths.buildManifestPath}`,
    `- Artifact inventory path: ${publicationArtifacts.metadataBlobPaths.artifactInventoryPath}`,
    `- Checksums path: ${publicationArtifacts.metadataBlobPaths.checksumsPath}`,
    `- Steam app id: ${steamAppId}`,
    `- Steam depot ids: linux=${steamDepotIds.linux}, windows=${steamDepotIds.windows}, macos=${steamDepotIds.macos}`,
    '',
    '## Publication Summary',
    '',
    `- Azure assets uploaded: ${publicationArtifacts.uploads.length}`,
    '- GitHub Release assets uploaded: 0',
    '- Distribution surfaces: Azure Blob version directory plus hagicode-steam/index.json'
  ].join('\n');
}

async function syncGitHubRelease({
  plan,
  releaseTag,
  steamAzureSasUrl,
  rootIndex,
  publicationArtifacts,
  steamAppId,
  steamDepotIds,
  publishedAt,
  githubToken,
  fetchImpl
}) {
  const repository = requireNonEmptyString(plan?.release?.repository, 'plan.release.repository');
  const releaseName = requireNonEmptyString(
    plan?.release?.name ?? `Portable Version ${releaseTag}`,
    'plan.release.name'
  );
  const { action, release } = await upsertReleaseNotes(repository, releaseTag, githubToken, {
    name: releaseName,
    body: buildGitHubReleaseBody({
      plan,
      releaseTag,
      steamAzureSasUrl,
      rootIndex,
      publicationArtifacts,
      steamAppId,
      steamDepotIds,
      publishedAt
    }),
    fetchImpl
  });

  return {
    action,
    repository,
    tag: releaseTag,
    name: release?.name ?? releaseName,
    url: release?.html_url ?? null,
    assetCount: Array.isArray(release?.assets) ? release.assets.length : 0
  };
}

async function runBoundedParallel(items, worker, { concurrency = DEFAULT_PUBLICATION_UPLOAD_CONCURRENCY } = {}) {
  if (!Array.isArray(items)) {
    throw new Error('Bounded parallel execution requires an array of items.');
  }

  const normalizedConcurrency = Math.max(1, Math.floor(Number(concurrency) || 1));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(normalizedConcurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function splitPublicationUploads(uploads) {
  return {
    archiveUploads: uploads.filter((upload) => upload.kind === 'archive'),
    metadataUploads: uploads.filter((upload) => upload.kind !== 'archive')
  };
}

async function uploadPublicationStep({ stepName, uploads, steamAzureSasUrl, fetchImpl }) {
  if (uploads.length === 0) {
    console.log(`[publish-release] ${stepName}: no blobs to upload`);
    return [];
  }

  console.log(`[publish-release] ${stepName}: uploading ${uploads.length} blobs with bounded parallelism`);
  return runBoundedParallel(
    uploads,
    async (upload, index) => {
      console.log(
        `[publish-release] ${stepName}: starting ${index + 1}/${uploads.length}: ${upload.blobPath} (${upload.kind}${upload.platform ? `, ${upload.platform}` : ''})`
      );
      const uploaded = await uploadAzureBlob({
        sasUrl: steamAzureSasUrl,
        blobPath: upload.blobPath,
        filePath: upload.filePath,
        fetchImpl
      });
      console.log(
        `[publish-release] ${stepName}: completed ${index + 1}/${uploads.length}: ${upload.blobPath}`
      );
      return uploaded;
    },
    { concurrency: DEFAULT_PUBLICATION_UPLOAD_CONCURRENCY }
  );
}

async function uploadPublicationArtifacts({ steamAzureSasUrl, uploads, fetchImpl }) {
  const { archiveUploads, metadataUploads } = splitPublicationUploads(uploads);
  const uploadedArchives = await uploadPublicationStep({
    stepName: 'Step 1 upload release archives',
    uploads: archiveUploads,
    steamAzureSasUrl,
    fetchImpl
  });
  const uploadedMetadata = await uploadPublicationStep({
    stepName: 'Step 2 upload release metadata',
    uploads: metadataUploads,
    steamAzureSasUrl,
    fetchImpl
  });

  return [...uploadedArchives, ...uploadedMetadata];
}

function ensureUploadedBlobsAreVisible({ visibleBlobNames, expectedBlobPaths, releaseTag }) {
  for (const blobPath of expectedBlobPaths) {
    if (!visibleBlobNames.has(blobPath)) {
      throw new Error(
        `Portable Version Azure publication for ${releaseTag} is missing uploaded blob ${blobPath} after upload verification.`
      );
    }
  }
}

export async function publishRelease({
  planPath,
  artifactsDir,
  outputDir,
  forceDryRun = false,
  steamAzureSasUrl = resolveSteamAzureSasUrl(),
  githubToken: githubTokenInput,
  steamAppKey: steamAppKeyInput,
  steamDataPath: steamDataPathInput,
  linuxDepotId,
  windowsDepotId,
  macosDepotId,
  fetchImpl = fetch
} = {}) {
  if (!planPath || !artifactsDir) {
    throw new Error('publish-release requires planPath and artifactsDir.');
  }

  const plan = await readJson(path.resolve(planPath));
  const resolvedArtifactsDir = path.resolve(artifactsDir);
  const resolvedOutputDir = path.resolve(outputDir ?? path.join(resolvedArtifactsDir, 'release-metadata'));
  const dryRun = forceDryRun || Boolean(plan.build.dryRun);
  const releaseTag = requireNonEmptyString(plan?.release?.tag, 'plan.release.tag');
  const githubToken = resolveGitHubToken(githubTokenInput);

  await ensureDir(resolvedOutputDir);

  const publicationArtifacts = await buildPublicationArtifacts({
    plan,
    artifactsDir: resolvedArtifactsDir,
    outputDir: resolvedOutputDir
  });
  const steamAppKey = resolveSteamAppKey(steamAppKeyInput);
  const steamDataPath = resolveSteamDataPath(steamDataPathInput);
  const publicationIdentity = await resolveSteamPublicationIdentity({
    steamAppKey,
    steamDataPath,
    fetchImpl
  });
  const steamAppId = publicationIdentity.steamAppId;
  const steamDepotIds = publicationIdentity.steamDepotIds;

  assertLegacyDepotOverridesMatchSharedData(steamDepotIds, {
    linuxDepotId,
    windowsDepotId,
    macosDepotId
  });

  if (dryRun) {
    const { dryRunReportPath, report } = createDryRunReport({
      releaseTag,
      steamAzureSasUrl,
      steamAppId,
      steamDepotIds,
      publicationArtifacts,
      outputDir: resolvedOutputDir,
      plan
    });
    await writeJson(dryRunReportPath, report);
    await appendSummary([
      '## Portable Version release publication dry-run',
      `- Release tag: ${releaseTag}`,
      `- Azure version directory: ${releaseTag}/`,
      `- Planned uploads: ${publicationArtifacts.uploads.length}`,
      `- Root index update: ${steamAzureSasUrl ? 'planned' : 'blocked (missing Azure SAS URL)'}`,
      '- GitHub Release notes: skipped (dry-run)',
      `- Build manifest metadata: ${publicationArtifacts.metadataBlobPaths.buildManifestPath}`,
      `- Artifact inventory metadata: ${publicationArtifacts.metadataBlobPaths.artifactInventoryPath}`,
      `- Checksums metadata: ${publicationArtifacts.metadataBlobPaths.checksumsPath}`,
      `- Report: ${dryRunReportPath}`
    ]);

    return {
      releaseTag,
      dryRunReportPath,
      assetCount: publicationArtifacts.uploads.length,
      metadata: publicationArtifacts.metadataBlobPaths,
      steamAppId,
      steamDepotIds,
      githubRelease: null
    };
  }

  if (!steamAzureSasUrl) {
    throw new Error(
      'publish-release requires STEAM_PACKER_STEAM_AZURE_SAS_URL, STEAM_AZURE_SAS_URL, or --steam-azure-sas-url for Azure publication.'
    );
  }

  const publishedAt = new Date().toISOString();
  console.log(
    `[publish-release] Starting Azure publication for ${releaseTag} with ${publicationArtifacts.uploads.length} uploads -> ${sanitizeUrlForLogs(steamAzureSasUrl)}`
  );
  const uploadedBlobs = await uploadPublicationArtifacts({
    steamAzureSasUrl,
    uploads: publicationArtifacts.uploads,
    fetchImpl
  });
  console.log(`[publish-release] Step 3 verify Azure visibility: ${uploadedBlobs.length} blobs uploaded for ${releaseTag}`);
  const visibleBlobs = await listAzureBlobs({
    sasUrl: steamAzureSasUrl,
    prefix: `${releaseTag}/`,
    fetchImpl
  });
  ensureUploadedBlobsAreVisible({
    visibleBlobNames: new Set(visibleBlobs.map((blob) => blob.name)),
    expectedBlobPaths: publicationArtifacts.uploads.map((upload) => upload.blobPath),
    releaseTag
  });
  console.log(`[publish-release] Azure visibility check succeeded for ${releaseTag}, fetching root index`);

  const rootIndex = await fetchPortableVersionRootIndex({
    sasUrl: steamAzureSasUrl,
    fetchImpl
  });
  const nextVersionEntry = buildResultVersionEntry({
    plan,
    publicationArtifacts,
    steamAppId,
    steamDepotIds,
    publishedAt
  });
  const updatedRootIndex = upsertPortableVersionRootIndexEntry(rootIndex.document, nextVersionEntry, {
    generatedAt: publishedAt
  });
  console.log(
    `[publish-release] Writing root index for ${releaseTag} (${rootIndex.exists ? 'upsert existing index' : 'create new index'})`
  );
  await writePortableVersionRootIndex({
    sasUrl: steamAzureSasUrl,
    document: updatedRootIndex,
    fetchImpl,
    generatedAt: publishedAt
  });

  console.log(`[publish-release] Verifying root index entry for ${releaseTag}`);
  const verifiedIndexEntry = await findPortableVersionReleaseByTag({
    sasUrl: steamAzureSasUrl,
    releaseTag,
    fetchImpl
  });
  if (!verifiedIndexEntry) {
    throw new Error(
      `Portable Version root index ${rootIndex.sanitizedIndexUrl} did not expose version "${releaseTag}" after index update.`
    );
  }
  console.log(`[publish-release] Root index verification succeeded for ${releaseTag}`);

  const githubRelease = githubToken
    ? await syncGitHubRelease({
        plan,
        releaseTag,
        steamAzureSasUrl,
        rootIndex,
        publicationArtifacts,
        steamAppId,
        steamDepotIds,
        publishedAt,
        githubToken,
        fetchImpl
      })
    : null;
  if (githubRelease) {
    console.log(
      `[publish-release] GitHub Release notes ${githubRelease.action} for ${githubRelease.repository}@${githubRelease.tag}`
    );
  } else {
    console.log('[publish-release] GitHub Release notes skipped because no token was provided');
  }

  const resultPath = path.join(resolvedOutputDir, `${releaseTag}.publish-result.json`);
  await writeJson(resultPath, {
    releaseTag,
    azurePublication: {
      containerUrl: sanitizeUrlForLogs(steamAzureSasUrl),
      versionDirectory: `${releaseTag}/`,
      rootIndexUrl: rootIndex.sanitizedIndexUrl,
      rootIndexExistedBeforePublish: rootIndex.exists
    },
    metadata: publicationArtifacts.metadataBlobPaths,
    steamAppId,
    steamDepotIds,
    githubRelease,
    uploads: uploadedBlobs.map((entry) => ({
      blobPath: entry.blobPath,
      sanitizedUploadUrl: entry.sanitizedUploadUrl
    }))
  });

  await appendSummary([
    '## Portable Version release publication complete',
    `- Release tag: ${releaseTag}`,
    `- Azure container: ${sanitizeUrlForLogs(steamAzureSasUrl)}`,
    `- Azure version directory: ${releaseTag}/`,
    `- Assets uploaded: ${publicationArtifacts.uploads.length}`,
    `- Root index: ${rootIndex.sanitizedIndexUrl}`,
    `- GitHub Release notes: ${
      githubRelease ? `${githubRelease.action} (${githubRelease.url ?? `${githubRelease.repository}@${githubRelease.tag}`})` : 'skipped'
    }`,
    `- Build manifest metadata: ${publicationArtifacts.metadataBlobPaths.buildManifestPath}`,
    `- Artifact inventory metadata: ${publicationArtifacts.metadataBlobPaths.artifactInventoryPath}`,
    `- Checksums metadata: ${publicationArtifacts.metadataBlobPaths.checksumsPath}`,
    `- Publication result: ${resultPath}`
  ]);

  return {
    releaseTag,
    assetCount: publicationArtifacts.uploads.length,
    metadata: publicationArtifacts.metadataBlobPaths,
    steamAppId,
    steamDepotIds,
    githubRelease,
    resultPath
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      'artifacts-dir': { type: 'string' },
      'output-dir': { type: 'string' },
      'force-dry-run': { type: 'boolean', default: false },
      'steam-azure-sas-url': { type: 'string' },
      'github-token': { type: 'string' },
      'steam-app-key': { type: 'string' },
      'steam-data-path': { type: 'string' },
      // Deprecated compatibility options. Publication now resolves depot ids from the shared Steam dataset.
      'linux-depot-id': { type: 'string' },
      'windows-depot-id': { type: 'string' },
      'macos-depot-id': { type: 'string' }
    },
    strict: true
  });

  const result = await publishRelease({
    planPath: values.plan,
    artifactsDir: values['artifacts-dir'],
    outputDir: values['output-dir'],
    forceDryRun: values['force-dry-run'],
    steamAzureSasUrl: values['steam-azure-sas-url'],
    githubToken: values['github-token'],
    steamAppKey: values['steam-app-key'],
    steamDataPath: values['steam-data-path'],
    linuxDepotId: values['linux-depot-id'],
    windowsDepotId: values['windows-depot-id'],
    macosDepotId: values['macos-depot-id']
  });

  console.log(JSON.stringify(result, null, 2));
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## Portable Version release publication failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
