import path from 'node:path';
import { normalizeSteamEnvConfig } from './env-config.mjs';
import { readJson } from './fs-utils.mjs';
import { createPlatformMatrix, getRequestedAssetPlatforms, getPlatformConfig } from './platforms.mjs';

export const STEAM_PACKER_HANDOFF_SCHEMA = 'steam-packer-handoff/v1';
export const PORTABLE_VERSION_HANDOFF_SCHEMA = STEAM_PACKER_HANDOFF_SCHEMA;

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value;
}

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return normalized;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
  }

  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array.`);
  }

  return value;
}

function validateRequestedPlatforms(plan) {
  const platforms = requireArray(plan.platforms, 'handoff.platforms').map((platformId) =>
    requireNonEmptyString(platformId, 'handoff.platforms[]')
  );

  for (const platformId of platforms) {
    getPlatformConfig(platformId);
  }

  return platforms;
}

function validateUpstreamAssets(plan, platformId, sourceType) {
  const upstream = requireObject(plan.upstream, 'handoff.upstream');
  const source = requireObject(upstream[sourceType], `handoff.upstream.${sourceType}`);
  requireNonEmptyString(source.version, `handoff.upstream.${sourceType}.version`);
  requireNonEmptyString(source.manifestUrl, `handoff.upstream.${sourceType}.manifestUrl`);
  const assetsByPlatform = requireObject(
    source.assetsByPlatform,
    `handoff.upstream.${sourceType}.assetsByPlatform`
  );

  for (const assetPlatform of getRequestedAssetPlatforms(platformId, sourceType)) {
    const asset = requireObject(
      assetsByPlatform[assetPlatform],
      `handoff.upstream.${sourceType}.assetsByPlatform.${assetPlatform}`
    );
    requireNonEmptyString(asset.name, `handoff.upstream.${sourceType}.assetsByPlatform.${assetPlatform}.name`);
    requireNonEmptyString(asset.path, `handoff.upstream.${sourceType}.assetsByPlatform.${assetPlatform}.path`);
  }
}

export function validateReleasePlan(plan, { planPath = '[inline]' } = {}) {
  requireObject(plan, 'handoff plan');
  const envConfig = normalizeSteamEnvConfig(plan.envConfig, { label: 'handoff.envConfig' });

  const handoff = requireObject(plan.handoff, 'handoff');
  if (handoff.schema !== STEAM_PACKER_HANDOFF_SCHEMA) {
    throw new Error(
      `handoff.schema must be ${STEAM_PACKER_HANDOFF_SCHEMA}; received ${JSON.stringify(handoff.schema)} from ${planPath}.`
    );
  }

  requireObject(handoff.producer, 'handoff.producer');
  requireNonEmptyString(handoff.producer.repository, 'handoff.producer.repository');
  requireObject(handoff.consumer, 'handoff.consumer');
  requireNonEmptyString(handoff.consumer.repository, 'handoff.consumer.repository');
  requireNonEmptyString(handoff.consumer.workflow, 'handoff.consumer.workflow');
  const publication = requireObject(handoff.publication, 'handoff.publication');
  requireNonEmptyString(publication.container, 'handoff.publication.container');
  requireNonEmptyString(publication.versionDirectory, 'handoff.publication.versionDirectory');
  requireNonEmptyString(publication.rootIndexPath, 'handoff.publication.rootIndexPath');

  const release = requireObject(plan.release, 'handoff.release');
  const releaseTag = requireNonEmptyString(release.tag, 'handoff.release.tag');
  requireNonEmptyString(release.repository, 'handoff.release.repository');

  const build = requireObject(plan.build, 'handoff.build');
  requireBoolean(build.shouldBuild, 'handoff.build.shouldBuild');
  requireBoolean(build.forceRebuild, 'handoff.build.forceRebuild');
  requireBoolean(build.dryRun, 'handoff.build.dryRun');

  const downloads = requireObject(plan.downloads, 'handoff.downloads');
  requireObject(downloads.desktop, 'handoff.downloads.desktop');
  requireNonEmptyString(downloads.desktop.containerUrl, 'handoff.downloads.desktop.containerUrl');
  requireObject(downloads.service, 'handoff.downloads.service');
  requireNonEmptyString(downloads.service.containerUrl, 'handoff.downloads.service.containerUrl');

  const platforms = validateRequestedPlatforms(plan);
  for (const platformId of platforms) {
    validateUpstreamAssets(plan, platformId, 'desktop');
    validateUpstreamAssets(plan, platformId, 'service');
  }

  const platformMatrix = plan.platformMatrix?.include?.length
    ? plan.platformMatrix
    : createPlatformMatrix(platforms);
  const normalizedPlan = {
    ...plan,
    envConfig,
    platformMatrix
  };

  return {
    plan: normalizedPlan,
    planPath,
    releaseTag,
    dryRun: build.dryRun,
    shouldBuild: build.shouldBuild,
    forceRebuild: build.forceRebuild,
    platforms,
    platformMatrix: normalizedPlan.platformMatrix,
    publication
  };
}

export async function loadReleasePlan(planPath) {
  const resolvedPlanPath = path.resolve(planPath);
  const plan = await readJson(resolvedPlanPath);
  return validateReleasePlan(plan, { planPath: resolvedPlanPath });
}

export const validatePortableVersionHandoff = validateReleasePlan;
export const loadPortableVersionHandoff = loadReleasePlan;
