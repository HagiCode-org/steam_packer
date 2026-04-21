import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../scripts/lib/build-plan.mjs';

const DESKTOP_INDEX_URL = 'https://index.hagicode.com/desktop/index.json';
const SERVICE_INDEX_URL = 'https://index.hagicode.com/server/index.json';

function createFetchStub() {
  return async (url) => {
    if (url === DESKTOP_INDEX_URL) {
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

    if (url === SERVICE_INDEX_URL) {
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
      desktop: 'https://example.blob.core.windows.net/desktop?sp=racwl&sig=test-token',
      service: 'https://example.blob.core.windows.net/server?sp=racwl&sig=test-token'
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
  assert.equal(plan.downloads.desktop.containerUrl, 'https://example.blob.core.windows.net/desktop/');
  assert.equal(plan.downloads.service.containerUrl, 'https://example.blob.core.windows.net/server/');
  assert.equal(plan.upstream.desktop.assetsByPlatform['linux-x64'].name, 'hagicode-desktop-0.3.0.zip');
  assert.equal(plan.upstream.desktop.assetsByPlatform['win-x64'].name, 'hagicode.desktop.0.3.0-unpacked.zip');
  assert.equal(plan.upstream.desktop.assetsByPlatform['osx-x64'].name, 'hagicode.desktop-0.3.0-mac.zip');
  assert.equal(plan.upstream.service.assetsByPlatform['linux-x64'].name, 'hagicode-0.1.0-beta.34-linux-x64-nort.zip');
  assert.equal(plan.upstream.service.assetsByPlatform['win-x64'].name, 'hagicode-0.1.0-beta.34-win-x64-nort.zip');
  assert.equal(plan.upstream.service.assetsByPlatform['osx-x64'].name, 'hagicode-0.1.0-beta.34-osx-x64-nort.zip');
  assert.equal(plan.upstream.service.assetsByPlatform['osx-arm64'].name, 'hagicode-0.1.0-beta.34-osx-arm64-nort.zip');
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
      desktop: 'https://example.blob.core.windows.net/desktop?sp=racwl&sig=test-token',
      service: 'https://example.blob.core.windows.net/server?sp=racwl&sig=test-token'
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
  assert.equal(plan.build.skipReason, null);
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
      desktop: 'https://example.blob.core.windows.net/desktop?sp=racwl&sig=test-token',
      service: 'https://example.blob.core.windows.net/server?sp=racwl&sig=test-token'
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
