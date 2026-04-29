#!/usr/bin/env node
import path from 'node:path';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseAzureSasUrl, sanitizeUrlForLogs } from './lib/azure-blob.mjs';
import { buildPlan } from './lib/build-plan.mjs';
import { ensureDir, readJson, writeJson } from './lib/fs-utils.mjs';
import { DEFAULT_PLATFORMS } from './lib/platforms.mjs';
import { appendSummary, annotateError } from './lib/summary.mjs';

async function writeGithubOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${String(value)}`);
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, 'utf8');
}

export async function resolveDispatchBuildPlan({
  eventName = 'workflow_dispatch',
  eventPayload = {},
  outputPath,
  token,
  defaultPlatforms = DEFAULT_PLATFORMS,
  repositories,
  desktopAzureSasUrl,
  serviceAzureSasUrl,
  steamAzureSasUrl,
  envConfigInput,
  findPortableRelease,
  fetchImpl
} = {}) {
  if (!desktopAzureSasUrl || !serviceAzureSasUrl) {
    throw new Error(
      'resolve-dispatch-build-plan requires both Desktop and Service Azure SAS URLs via --desktop-azure-sas-url/--service-azure-sas-url or STEAM_PACKER_DESKTOP_AZURE_SAS_URL/STEAM_PACKER_SERVICE_AZURE_SAS_URL.'
    );
  }

  parseAzureSasUrl(desktopAzureSasUrl);
  parseAzureSasUrl(serviceAzureSasUrl);

  const normalizedRepositories = {
    ...(repositories?.desktop ? { desktop: repositories.desktop } : {}),
    ...(repositories?.service ? { service: repositories.service } : {}),
    portable: repositories?.portable ?? (process.env.GITHUB_REPOSITORY ?? 'HagiCode-org/steam_packer')
  };

  const resolvedOutputPath = path.resolve(outputPath ?? 'build/build-plan.json');
  await ensureDir(path.dirname(resolvedOutputPath));
  const resolvedEventPayload = envConfigInput
    ? {
        ...eventPayload,
        inputs: {
          ...(eventPayload?.inputs ?? {}),
          env_config: envConfigInput
        }
      }
    : eventPayload;

  const plan = await buildPlan({
    eventName,
    eventPayload: resolvedEventPayload,
    token,
    repositories: normalizedRepositories,
    producerRepository: process.env.GITHUB_REPOSITORY ?? 'HagiCode-org/steam_packer',
    defaultPlatforms,
    azureSasUrls: {
      desktop: desktopAzureSasUrl,
      service: serviceAzureSasUrl
    },
    portableAzureSasUrl: steamAzureSasUrl,
    findPortableRelease,
    fetchImpl
  });

  await writeJson(resolvedOutputPath, plan);
  await writeGithubOutputs({
    plan_path: resolvedOutputPath,
    release_tag: plan.release.tag,
    should_build: plan.build.shouldBuild,
    dry_run: plan.build.dryRun,
    platform_matrix: JSON.stringify(plan.platformMatrix)
  });

  const selectedPlatforms = plan.platforms.join(', ');
  await appendSummary([
    '## steam_packer automated release plan',
    `- Trigger type: ${plan.trigger.type}`,
    `- Desktop manifest source: ${plan.upstream.desktop.manifestUrl}`,
    `- Latest Desktop version: ${plan.upstream.desktop.version}`,
    `- Service manifest source: ${plan.upstream.service.manifestUrl}`,
    `- Latest Service version: ${plan.upstream.service.version}`,
    `- Platforms: ${selectedPlatforms}`,
    `- Derived release tag: ${plan.release.tag}`,
    `- Desktop Azure SAS: ${sanitizeUrlForLogs(desktopAzureSasUrl)}`,
    `- Service Azure SAS: ${sanitizeUrlForLogs(serviceAzureSasUrl)}`,
    `- Steam Azure SAS: ${steamAzureSasUrl ? sanitizeUrlForLogs(steamAzureSasUrl) : '[not-configured]'}`,
    `- Release exists in Azure index: ${plan.release.exists ? 'yes' : 'no'}`,
    `- Build mode: ${plan.build.dryRun ? 'dry-run' : 'publish'}`,
    `- envConfig: ${JSON.stringify(plan.envConfig)}`,
    `- should_build: ${plan.build.shouldBuild ? 'true' : 'false'}`,
    `- Skip reason: ${plan.build.skipReason ?? '[none]'}`,
    plan.build.shouldBuild ? '- Packaging will continue.' : '- Packaging skipped before package/publish jobs.'
  ]);

  return {
    outputPath: resolvedOutputPath,
    plan
  };
}

export async function main() {
  const { values } = parseArgs({
    options: {
      'event-name': { type: 'string' },
      'event-path': { type: 'string' },
      output: { type: 'string' },
      token: { type: 'string' },
      'default-platforms': { type: 'string' },
      'desktop-index-url': { type: 'string' },
      'service-index-url': { type: 'string' },
      'desktop-azure-sas-url': { type: 'string' },
      'service-azure-sas-url': { type: 'string' },
      'steam-azure-sas-url': { type: 'string' },
      'env-config': { type: 'string' }
    }
  });

  const eventName = values['event-name'] ?? process.env.GITHUB_EVENT_NAME ?? 'workflow_dispatch';
  const eventPath = values['event-path'] ?? process.env.GITHUB_EVENT_PATH;
  const token = values.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const desktopAzureSasUrl =
    values['desktop-azure-sas-url'] ??
    process.env.STEAM_PACKER_DESKTOP_AZURE_SAS_URL ??
    process.env.DESKTOP_AZURE_SAS_URL ??
    process.env.PORTABLE_VERSION_DESKTOP_AZURE_SAS_URL ??
    process.env.DESKTOP_AZURE_BLOB_SAS_URL ??
    process.env.AZURE_BLOB_SAS_URL ??
    process.env.AZURE_SAS_URL;
  const serviceAzureSasUrl =
    values['service-azure-sas-url'] ??
    process.env.STEAM_PACKER_SERVICE_AZURE_SAS_URL ??
    process.env.SERVICE_AZURE_SAS_URL ??
    process.env.PORTABLE_VERSION_SERVICE_AZURE_SAS_URL ??
    process.env.SERVICE_AZURE_BLOB_SAS_URL ??
    process.env.AZURE_BLOB_SAS_URL ??
    process.env.AZURE_SAS_URL;
  const steamAzureSasUrl =
    values['steam-azure-sas-url'] ??
    process.env.STEAM_PACKER_STEAM_AZURE_SAS_URL ??
    process.env.STEAM_AZURE_SAS_URL ??
    process.env.PORTABLE_VERSION_STEAM_AZURE_SAS_URL ??
    process.env.AZURE_BLOB_SAS_URL ??
    process.env.AZURE_SAS_URL;
  const defaultPlatforms = values['default-platforms']
    ? values['default-platforms'].split(',').map((item) => item.trim()).filter(Boolean)
    : DEFAULT_PLATFORMS;
  const repositories = {
    ...(values['desktop-index-url'] ??
    process.env.DESKTOP_INDEX_URL ??
    process.env.PORTABLE_VERSION_DESKTOP_INDEX_URL
      ? {
          desktop:
            values['desktop-index-url'] ??
            process.env.DESKTOP_INDEX_URL ??
            process.env.PORTABLE_VERSION_DESKTOP_INDEX_URL
        }
      : {}),
    ...(values['service-index-url'] ??
    process.env.SERVICE_INDEX_URL ??
    process.env.PORTABLE_VERSION_SERVICE_INDEX_URL
      ? {
          service:
            values['service-index-url'] ??
            process.env.SERVICE_INDEX_URL ??
            process.env.PORTABLE_VERSION_SERVICE_INDEX_URL
        }
      : {}),
    portable: process.env.GITHUB_REPOSITORY ?? 'HagiCode-org/steam_packer'
  };
  const eventPayload = eventPath ? await readJson(eventPath) : {};

  const result = await resolveDispatchBuildPlan({
    eventName,
    eventPayload,
    outputPath: values.output,
    token,
    defaultPlatforms,
    repositories,
    desktopAzureSasUrl,
    serviceAzureSasUrl,
    steamAzureSasUrl,
    envConfigInput:
      values['env-config'] ??
      process.env.STEAM_PACKER_ENV_CONFIG ??
      process.env.ENV_CONFIG
  });

  console.log(
    JSON.stringify(
      {
        outputPath: result.outputPath,
        releaseTag: result.plan.release.tag,
        shouldBuild: result.plan.build.shouldBuild,
        envConfig: result.plan.envConfig
      },
      null,
      2
    )
  );
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## steam_packer automated release plan failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
