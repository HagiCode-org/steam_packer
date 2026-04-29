import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { buildPlan } from '../scripts/lib/build-plan.mjs';
import { readJson } from '../scripts/lib/fs-utils.mjs';
import { resolveDispatchBuildPlan } from '../scripts/resolve-dispatch-build-plan.mjs';

const DESKTOP_INDEX_URL = 'https://index.hagicode.com/desktop/index.json';
const SERVICE_INDEX_URL = 'https://index.hagicode.com/server/index.json';
const DESKTOP_AZURE_SAS_URL = 'https://example.blob.core.windows.net/desktop?sp=racwl&sig=test-token';
const SERVICE_AZURE_SAS_URL = 'https://example.blob.core.windows.net/server?sp=racwl&sig=test-token';
const DESKTOP_AZURE_MANIFEST_URL = 'https://example.blob.core.windows.net/desktop/index.json?sp=racwl&sig=test-token';
const SERVICE_AZURE_MANIFEST_URL = 'https://example.blob.core.windows.net/server/index.json?sp=racwl&sig=test-token';

function createFetchStub({ requests = [] } = {}) {
  return async (url) => {
    requests.push(url);

    if (url === DESKTOP_INDEX_URL || url === DESKTOP_AZURE_MANIFEST_URL) {
      return Response.json({
        updatedAt: '2026-04-21T00:00:00.000Z',
        versions: [
          {
            version: 'v0.2.0',
            assets: [
              'v0.2.0/hagicode-desktop-0.2.0.zip',
              'v0.2.0/hagicode.desktop.0.2.0-unpacked.zip',
              'v0.2.0/hagicode.desktop-0.2.0-mac.zip'
            ]
          },
          {
            version: 'v0.3.0',
            assets: [
              'v0.3.0/hagicode-desktop-0.3.0.zip',
              'v0.3.0/hagicode.desktop.0.3.0-unpacked.zip',
              'v0.3.0/hagicode.desktop-0.3.0-mac.zip',
              'v0.3.0/hagicode.desktop-0.3.0-arm64-mac.zip'
            ]
          }
        ]
      });
    }

    if (url === SERVICE_INDEX_URL || url === SERVICE_AZURE_MANIFEST_URL) {
      return Response.json({
        updatedAt: '2026-04-21T00:00:00.000Z',
        versions: [
          {
            version: '0.1.0-beta.33',
            assets: [
              '0.1.0-beta.33/hagicode-0.1.0-beta.33-linux-x64-nort.zip',
              '0.1.0-beta.33/hagicode-0.1.0-beta.33-win-x64-nort.zip',
              '0.1.0-beta.33/hagicode-0.1.0-beta.33-osx-x64-nort.zip',
              '0.1.0-beta.33/hagicode-0.1.0-beta.33-osx-arm64-nort.zip'
            ]
          },
          {
            version: '0.1.0-beta.34',
            assets: [
              '0.1.0-beta.34/hagicode-0.1.0-beta.34-linux-x64-nort.zip',
              '0.1.0-beta.34/hagicode-0.1.0-beta.34-win-x64-nort.zip',
              '0.1.0-beta.34/hagicode-0.1.0-beta.34-osx-x64-nort.zip',
              '0.1.0-beta.34/hagicode-0.1.0-beta.34-osx-arm64-nort.zip'
            ]
          }
        ]
      });
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };
}

test('buildPlan defaults Desktop and Service discovery to direct Azure authority', async () => {
  const requests = [];
  const plan = await buildPlan({
    eventName: 'workflow_dispatch',
    eventPayload: { inputs: {} },
    azureSasUrls: {
      desktop: DESKTOP_AZURE_SAS_URL,
      service: SERVICE_AZURE_SAS_URL
    },
    findPortableRelease: async () => null,
    fetchImpl: createFetchStub({ requests }),
    now: '2026-04-21T00:00:00.000Z'
  });

  assert.deepEqual(requests, [DESKTOP_AZURE_MANIFEST_URL, SERVICE_AZURE_MANIFEST_URL]);
  assert.equal(plan.repositories.desktop, 'https://example.blob.core.windows.net/desktop/index.json?<sas-token-redacted>');
  assert.equal(plan.repositories.service, 'https://example.blob.core.windows.net/server/index.json?<sas-token-redacted>');
  assert.equal(plan.upstream.desktop.sourceAuthority, 'azure-blob');
  assert.equal(plan.upstream.service.sourceAuthority, 'azure-blob');
  assert.equal(plan.upstream.desktop.manifestPath, 'index.json');
  assert.equal(plan.upstream.service.manifestPath, 'index.json');
  assert.equal(plan.upstream.desktop.manifestUrl, 'https://example.blob.core.windows.net/desktop/index.json?<sas-token-redacted>');
  assert.equal(plan.upstream.service.manifestUrl, 'https://example.blob.core.windows.net/server/index.json?<sas-token-redacted>');
});

test('buildPlan selects latest desktop and service releases for the default three-platform manual build', async () => {
  const plan = await buildPlan({
    eventName: 'workflow_dispatch',
    eventPayload: { inputs: {} },
    repositories: {
      desktop: DESKTOP_INDEX_URL,
      service: SERVICE_INDEX_URL,
      portable: 'HagiCode-org/steam_packer'
    },
    azureSasUrls: {
      desktop: DESKTOP_AZURE_SAS_URL,
      service: SERVICE_AZURE_SAS_URL
    },
    findPortableRelease: async () => null,
    fetchImpl: createFetchStub(),
    now: '2026-04-21T00:00:00.000Z'
  });

  assert.deepEqual(plan.platforms, ['linux-x64', 'win-x64', 'osx-universal']);
  assert.equal(plan.upstream.desktop.version, 'v0.3.0');
  assert.equal(plan.upstream.service.version, '0.1.0-beta.34');
  assert.equal(plan.release.tag, 'v0.1.0-beta.34');
  assert.equal(plan.build.shouldBuild, true);
  assert.equal(plan.build.forceRebuild, false);
  assert.equal(plan.build.dryRun, false);
  assert.deepEqual(plan.envConfig, {
    HAGICODE_MODE: 'steam',
    HAGICODE_STEAM_ACHIEVEMENT_SYNC_ENABLED: 'true'
  });
  assert.equal(plan.downloads.desktop.containerUrl, 'https://example.blob.core.windows.net/desktop/');
  assert.equal(plan.downloads.service.containerUrl, 'https://example.blob.core.windows.net/server/');
  assert.equal(plan.upstream.desktop.sourceAuthority, 'explicit-override');
  assert.equal(plan.upstream.service.sourceAuthority, 'explicit-override');
  assert.equal(plan.upstream.desktop.assetsByPlatform['linux-x64'].name, 'hagicode-desktop-0.3.0.zip');
  assert.equal(plan.upstream.desktop.assetsByPlatform['win-x64'].name, 'hagicode.desktop.0.3.0-unpacked.zip');
  assert.equal(plan.upstream.desktop.assetsByPlatform['osx-x64'].name, 'hagicode.desktop-0.3.0-mac.zip');
  assert.equal(plan.upstream.service.assetsByPlatform['linux-x64'].name, 'hagicode-0.1.0-beta.34-linux-x64-nort.zip');
  assert.equal(plan.upstream.service.assetsByPlatform['win-x64'].name, 'hagicode-0.1.0-beta.34-win-x64-nort.zip');
  assert.equal(plan.upstream.service.assetsByPlatform['osx-x64'].name, 'hagicode-0.1.0-beta.34-osx-x64-nort.zip');
  assert.equal(plan.upstream.service.assetsByPlatform['osx-arm64'].name, 'hagicode-0.1.0-beta.34-osx-arm64-nort.zip');
});

test('buildPlan selects latest releases and default platforms for scheduled automation', async () => {
  const plan = await buildPlan({
    eventName: 'schedule',
    eventPayload: {},
    repositories: {
      desktop: DESKTOP_INDEX_URL,
      service: SERVICE_INDEX_URL,
      portable: 'HagiCode-org/steam_packer'
    },
    azureSasUrls: {
      desktop: DESKTOP_AZURE_SAS_URL,
      service: SERVICE_AZURE_SAS_URL
    },
    findPortableRelease: async () => null,
    fetchImpl: createFetchStub(),
    now: '2026-04-21T00:00:00.000Z'
  });

  assert.equal(plan.trigger.type, 'schedule');
  assert.deepEqual(plan.platforms, ['linux-x64', 'win-x64', 'osx-universal']);
  assert.deepEqual(
    plan.platformMatrix.include.map((entry) => entry.platform),
    ['linux-x64', 'win-x64', 'osx-universal']
  );
  assert.equal(plan.upstream.desktop.version, 'v0.3.0');
  assert.equal(plan.upstream.service.version, '0.1.0-beta.34');
  assert.equal(plan.release.tag, 'v0.1.0-beta.34');
  assert.equal(plan.release.exists, false);
  assert.equal(plan.build.shouldBuild, true);
  assert.equal(plan.build.forceRebuild, false);
  assert.equal(plan.build.dryRun, false);
});

test('buildPlan respects dry_run and force_rebuild when the Azure release already exists', async () => {
  const plan = await buildPlan({
    eventName: 'workflow_dispatch',
    eventPayload: {
      inputs: {
        dry_run: true,
        force_rebuild: true
      }
    },
    repositories: {
      desktop: DESKTOP_INDEX_URL,
      service: SERVICE_INDEX_URL,
      portable: 'HagiCode-org/steam_packer'
    },
    azureSasUrls: {
      desktop: DESKTOP_AZURE_SAS_URL,
      service: SERVICE_AZURE_SAS_URL
    },
    findPortableRelease: async () => ({
      tag_name: 'v0.1.0-beta.34',
      html_url: 'https://github.com/HagiCode-org/steam_packer/releases/tag/v0.1.0-beta.34'
    }),
    fetchImpl: createFetchStub(),
    now: '2026-04-21T00:00:00.000Z'
  });

  assert.equal(plan.release.exists, true);
  assert.equal(plan.build.shouldBuild, true);
  assert.equal(plan.build.forceRebuild, true);
  assert.equal(plan.build.dryRun, true);
  assert.deepEqual(plan.envConfig, {
    HAGICODE_MODE: 'steam',
    HAGICODE_STEAM_ACHIEVEMENT_SYNC_ENABLED: 'true'
  });
  assert.equal(plan.build.skipReason, null);
});

test('buildPlan normalizes additional HAGICODE env config from workflow inputs', async () => {
  const plan = await buildPlan({
    eventName: 'workflow_dispatch',
    eventPayload: {
      inputs: {
        env_config: JSON.stringify({
          HAGICODE_LOG_LEVEL: 'debug',
          HAGICODE_DEBUG: 'true',
          HAGICODE_MODE: 'desktop'
        })
      }
    },
    repositories: {
      desktop: DESKTOP_INDEX_URL,
      service: SERVICE_INDEX_URL,
      portable: 'HagiCode-org/steam_packer'
    },
    azureSasUrls: {
      desktop: DESKTOP_AZURE_SAS_URL,
      service: SERVICE_AZURE_SAS_URL
    },
    findPortableRelease: async () => null,
    fetchImpl: createFetchStub(),
    now: '2026-04-21T00:00:00.000Z'
  });

  assert.deepEqual(plan.envConfig, {
    HAGICODE_MODE: 'steam',
    HAGICODE_STEAM_ACHIEVEMENT_SYNC_ENABLED: 'true',
    HAGICODE_LOG_LEVEL: 'debug',
    HAGICODE_DEBUG: 'true'
  });
  assert.equal(plan.trigger.rawInputs.env_config, '{"HAGICODE_LOG_LEVEL":"debug","HAGICODE_DEBUG":"true","HAGICODE_MODE":"desktop"}');
});

test('resolveDispatchBuildPlan applies the same envConfig normalization for local CLI overrides', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'steam-packer-build-plan-'));
  const outputPath = path.join(tempRoot, 'build-plan.json');

  const result = await resolveDispatchBuildPlan({
    eventName: 'workflow_dispatch',
    eventPayload: { inputs: {} },
    outputPath,
    repositories: {
      desktop: DESKTOP_INDEX_URL,
      service: SERVICE_INDEX_URL,
      portable: 'HagiCode-org/steam_packer'
    },
    desktopAzureSasUrl: DESKTOP_AZURE_SAS_URL,
    serviceAzureSasUrl: SERVICE_AZURE_SAS_URL,
    envConfigInput: JSON.stringify({
      HAGICODE_LOG_LEVEL: 'info',
      HAGICODE_MODE: 'ignored'
    }),
    fetchImpl: createFetchStub(),
    findPortableRelease: async () => null
  });

  const writtenPlan = await readJson(outputPath);
  assert.deepEqual(result.plan.envConfig, {
    HAGICODE_MODE: 'steam',
    HAGICODE_STEAM_ACHIEVEMENT_SYNC_ENABLED: 'true',
    HAGICODE_LOG_LEVEL: 'info'
  });
  assert.deepEqual(writtenPlan.envConfig, result.plan.envConfig);
});

test('resolveDispatchBuildPlan persists redacted Azure manifest sources when no explicit index overrides are provided', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'steam-packer-build-plan-'));
  const outputPath = path.join(tempRoot, 'build-plan.json');
  const requests = [];

  const result = await resolveDispatchBuildPlan({
    eventName: 'workflow_dispatch',
    eventPayload: { inputs: {} },
    outputPath,
    desktopAzureSasUrl: DESKTOP_AZURE_SAS_URL,
    serviceAzureSasUrl: SERVICE_AZURE_SAS_URL,
    fetchImpl: createFetchStub({ requests }),
    findPortableRelease: async () => null
  });

  const writtenPlan = await readJson(outputPath);
  assert.deepEqual(requests, [DESKTOP_AZURE_MANIFEST_URL, SERVICE_AZURE_MANIFEST_URL]);
  assert.equal(result.plan.upstream.desktop.manifestUrl, 'https://example.blob.core.windows.net/desktop/index.json?<sas-token-redacted>');
  assert.equal(result.plan.upstream.service.manifestUrl, 'https://example.blob.core.windows.net/server/index.json?<sas-token-redacted>');
  assert.equal(writtenPlan.upstream.desktop.manifestUrl, result.plan.upstream.desktop.manifestUrl);
  assert.equal(writtenPlan.upstream.service.manifestUrl, result.plan.upstream.service.manifestUrl);
});

test('buildPlan skips packaging when the latest Azure release already exists and force_rebuild is disabled', async () => {
  const plan = await buildPlan({
    eventName: 'workflow_dispatch',
    eventPayload: {
      inputs: {}
    },
    repositories: {
      desktop: DESKTOP_INDEX_URL,
      service: SERVICE_INDEX_URL,
      portable: 'HagiCode-org/steam_packer'
    },
    azureSasUrls: {
      desktop: DESKTOP_AZURE_SAS_URL,
      service: SERVICE_AZURE_SAS_URL
    },
    findPortableRelease: async () => ({
      tag_name: 'v0.1.0-beta.34',
      html_url: 'https://github.com/HagiCode-org/steam_packer/releases/tag/v0.1.0-beta.34'
    }),
    fetchImpl: createFetchStub(),
    now: '2026-04-21T00:00:00.000Z'
  });

  assert.equal(plan.release.exists, true);
  assert.equal(plan.build.shouldBuild, false);
  assert.equal(plan.build.forceRebuild, false);
  assert.match(plan.build.skipReason, /already exists/i);
});

test('buildPlan skips scheduled packaging when the derived Azure release already exists', async () => {
  const plan = await buildPlan({
    eventName: 'schedule',
    eventPayload: {},
    repositories: {
      desktop: DESKTOP_INDEX_URL,
      service: SERVICE_INDEX_URL,
      portable: 'HagiCode-org/steam_packer'
    },
    azureSasUrls: {
      desktop: DESKTOP_AZURE_SAS_URL,
      service: SERVICE_AZURE_SAS_URL
    },
    findPortableRelease: async () => ({
      tag_name: 'v0.1.0-beta.34',
      html_url: 'https://github.com/HagiCode-org/steam_packer/releases/tag/v0.1.0-beta.34'
    }),
    fetchImpl: createFetchStub(),
    now: '2026-04-21T00:00:00.000Z'
  });

  assert.equal(plan.trigger.type, 'schedule');
  assert.equal(plan.release.exists, true);
  assert.equal(plan.build.shouldBuild, false);
  assert.equal(plan.build.forceRebuild, false);
  assert.match(plan.build.skipReason, /already exists/i);
});
