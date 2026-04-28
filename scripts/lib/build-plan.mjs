import {
  findPortableVersionReleaseByTag,
  getAzureBlobContainerUrl,
  sanitizeUrlForLogs
} from './azure-blob.mjs';
import { normalizeSteamEnvConfig, parseEnvConfigInput } from './env-config.mjs';
import { findReleaseByTag } from './github.mjs';
import { DEFAULT_INDEX_SOURCES, resolveIndexRelease } from './index-source.mjs';
import { STEAM_PACKER_HANDOFF_SCHEMA } from './release-plan.mjs';
import {
  DEFAULT_PLATFORMS,
  createPlatformMatrix,
  derivePortableReleaseTag,
  normalizePlatforms
} from './platforms.mjs';

const DEFAULT_REPOSITORIES = {
  desktop: DEFAULT_INDEX_SOURCES.desktop,
  service: DEFAULT_INDEX_SOURCES.service,
  portable: 'HagiCode-org/steam_packer'
};

function normalizeBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function coalesce(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

export function normalizeTriggerInputs({ eventName, eventPayload, defaultPlatforms = DEFAULT_PLATFORMS }) {
  const inputs = eventPayload?.inputs ?? {};
  const dispatchPayload = eventPayload?.client_payload ?? {};

  const desktopSelector = coalesce(inputs.desktop_tag, dispatchPayload.desktopTag, dispatchPayload.desktop_tag);
  const serviceSelector = coalesce(inputs.service_tag, dispatchPayload.serviceTag, dispatchPayload.service_tag);
  const platforms = coalesce(inputs.platforms, dispatchPayload.platforms);
  const forceRebuild = normalizeBoolean(
    coalesce(inputs.force_rebuild, dispatchPayload.forceRebuild, dispatchPayload.force_rebuild),
    false
  );
  const dryRun = normalizeBoolean(coalesce(inputs.dry_run, dispatchPayload.dryRun, dispatchPayload.dry_run), false);
  const rawEnvConfig = coalesce(inputs.env_config, dispatchPayload.envConfig, dispatchPayload.env_config);
  const envConfig = normalizeSteamEnvConfig(
    parseEnvConfigInput(rawEnvConfig, { label: 'trigger.env_config' }),
    { label: 'trigger.env_config' }
  );

  return {
    triggerType: eventName,
    desktopSelector,
    serviceSelector,
    selectedPlatforms: normalizePlatforms(platforms, defaultPlatforms),
    forceRebuild,
    dryRun,
    envConfig,
    rawInputs: {
      desktop_tag: desktopSelector ?? null,
      service_tag: serviceSelector ?? null,
      platforms: platforms ?? null,
      force_rebuild: forceRebuild,
      dry_run: dryRun,
      env_config: rawEnvConfig ?? null
    }
  };
}

export async function buildPlan({
  eventName = 'workflow_dispatch',
  eventPayload = {},
  token,
  repositories = DEFAULT_REPOSITORIES,
  producerRepository = 'HagiCode-org/steam_packer',
  defaultPlatforms = DEFAULT_PLATFORMS,
  now = new Date().toISOString(),
  fetchImpl,
  findPortableRelease = findReleaseByTag,
  azureSasUrls,
  portableAzureSasUrl
} = {}) {
  const trigger = normalizeTriggerInputs({
    eventName,
    eventPayload,
    defaultPlatforms
  });

  const [desktopRelease, serviceRelease] = await Promise.all([
    resolveIndexRelease({
      sourceType: 'desktop',
      indexUrl: repositories.desktop,
      selector: trigger.desktopSelector,
      platforms: trigger.selectedPlatforms,
      fetchImpl
    }),
    resolveIndexRelease({
      sourceType: 'service',
      indexUrl: repositories.service,
      selector: trigger.serviceSelector,
      platforms: trigger.selectedPlatforms,
      fetchImpl
    })
  ]);

  const releaseTag = derivePortableReleaseTag(serviceRelease.version);
  const existingPortableRelease = portableAzureSasUrl
    ? await findPortableVersionReleaseByTag({
        sasUrl: portableAzureSasUrl,
        releaseTag,
        fetchImpl
      })
    : await findPortableRelease(repositories.portable, releaseTag, token);
  const releaseExists = Boolean(existingPortableRelease);
  const shouldBuild = !releaseExists || trigger.forceRebuild;
  const skipReason = !shouldBuild
    ? `Portable Version release ${releaseTag} already exists for the normalized Web version in the Azure publication index and force_rebuild was not enabled.`
    : null;

  const downloads = {
    strategy: 'azure-blob-sas',
    desktop: {
      containerUrl: azureSasUrls?.desktop ? getAzureBlobContainerUrl(azureSasUrls.desktop) : null,
      redactedSasUrl: azureSasUrls?.desktop ? sanitizeUrlForLogs(azureSasUrls.desktop) : null
    },
    service: {
      containerUrl: azureSasUrls?.service ? getAzureBlobContainerUrl(azureSasUrls.service) : null,
      redactedSasUrl: azureSasUrls?.service ? sanitizeUrlForLogs(azureSasUrls.service) : null
    }
  };

  return {
    schemaVersion: 2,
    generatedAt: now,
    repositories,
    trigger: {
      type: trigger.triggerType,
      rawInputs: trigger.rawInputs
    },
    platforms: trigger.selectedPlatforms,
    platformMatrix: createPlatformMatrix(trigger.selectedPlatforms),
    downloads,
    upstream: {
      desktop: desktopRelease,
      service: serviceRelease
    },
    release: {
      repository: repositories.portable,
      tag: releaseTag,
      name: `Portable Version ${releaseTag}`,
      exists: releaseExists,
      url: existingPortableRelease?.html_url ?? existingPortableRelease?.sanitizedIndexUrl ?? null,
      notesTitle: `Portable Version ${releaseTag}`
    },
    build: {
      shouldBuild,
      forceRebuild: trigger.forceRebuild,
      dryRun: trigger.dryRun,
      skipReason
    },
    envConfig: trigger.envConfig,
    handoff: {
      schema: STEAM_PACKER_HANDOFF_SCHEMA,
      producer: {
        repository: producerRepository,
        workflow: 'package-release'
      },
      consumer: {
        repository: repositories.portable,
        workflow: 'package-release'
      },
      publication: {
        container: 'hagicode-steam',
        versionDirectory: `${releaseTag}/`,
        rootIndexPath: 'index.json'
      }
    }
  };
}
