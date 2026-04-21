import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createArchive } from '../scripts/lib/archive.mjs';
import { STEAM_PACKER_HANDOFF_SCHEMA } from '../scripts/lib/release-plan.mjs';
import { readJson, writeJson } from '../scripts/lib/fs-utils.mjs';
import { executeReleasePlan } from '../scripts/run-release-plan.mjs';
import { createMockPortableToolchainConfig } from './helpers/portable-toolchain-fixture.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STEAM_APP_KEY = 'hagicode';

function fixturePath(...segments) {
  return path.join(repoRoot, 'tests', 'fixtures', ...segments);
}

async function createFixtureArchive(sourceDirectory, archivePath) {
  await createArchive(sourceDirectory, archivePath);
}

async function createPlanFixture(tempRoot, { dryRun = true } = {}) {
  const planPath = path.join(tempRoot, 'build-plan.json');
  const desktopArchivePath = path.join(tempRoot, 'hagicode-desktop-0.2.0.zip');
  const steamDataPath = path.join(tempRoot, 'steam-index.json');
  await createFixtureArchive(fixturePath('desktop-fixture'), desktopArchivePath);
  await writeJson(steamDataPath, {
    version: '1.0.0',
    updatedAt: '2026-04-21T00:00:00.000Z',
    applications: [
      {
        key: STEAM_APP_KEY,
        displayName: 'HagiCode',
        kind: 'application',
        parentKey: null,
        storeAppId: '4625540',
        storeUrl: 'https://store.steampowered.com/app/4625540/Hagicode/',
        platformAppIds: {
          windows: '4625541',
          linux: '4625542',
          macos: '4625543'
        }
      }
    ]
  });

  await writeJson(planPath, {
    schemaVersion: 2,
    generatedAt: '2026-04-21T00:00:00.000Z',
    repositories: {
      desktop: 'https://index.hagicode.com/desktop/index.json',
      service: 'https://index.hagicode.com/server/index.json',
      portable: 'HagiCode-org/release-orchestrator'
    },
    trigger: {
      type: 'workflow_dispatch',
      rawInputs: {
        desktop_tag: null,
        service_tag: '0.1.0-beta.33',
        platforms: 'linux-x64',
        force_rebuild: false,
        dry_run: dryRun
      }
    },
    platforms: ['linux-x64'],
    platformMatrix: {
      include: [
        {
          platform: 'linux-x64',
          runner: 'ubuntu-latest',
          runtimeKey: 'linux-x64-nort'
        }
      ]
    },
    downloads: {
      strategy: 'azure-blob-sas',
      desktop: {
        containerUrl: 'https://example.blob.core.windows.net/desktop/',
        redactedSasUrl: 'https://example.blob.core.windows.net/desktop?<sas-token-redacted>'
      },
      service: {
        containerUrl: 'https://example.blob.core.windows.net/server/',
        redactedSasUrl: 'https://example.blob.core.windows.net/server?<sas-token-redacted>'
      }
    },
    upstream: {
      desktop: {
        sourceType: 'index',
        manifestUrl: 'https://index.hagicode.com/desktop/index.json',
        version: 'v0.2.0',
        assetsByPlatform: {
          'linux-x64': {
            name: 'hagicode-desktop-0.2.0.zip',
            path: 'v0.2.0/hagicode-desktop-0.2.0.zip'
          }
        }
      },
      service: {
        sourceType: 'index',
        manifestUrl: 'https://index.hagicode.com/server/index.json',
        version: '0.1.0-beta.33',
        assetsByPlatform: {
          'linux-x64': {
            name: 'hagicode-0.1.0-beta.33-linux-x64-nort.zip',
            path: '0.1.0-beta.33/hagicode-0.1.0-beta.33-linux-x64-nort.zip'
          }
        }
      }
    },
    release: {
      repository: 'HagiCode-org/release-orchestrator',
      tag: 'v0.1.0-beta.33',
      name: 'Portable Version v0.1.0-beta.33',
      exists: false,
      url: null,
      notesTitle: 'Portable Version v0.1.0-beta.33'
    },
    build: {
      shouldBuild: true,
      forceRebuild: false,
      dryRun,
      skipReason: null
    },
    handoff: {
      schema: STEAM_PACKER_HANDOFF_SCHEMA,
      producer: {
        repository: 'HagiCode-org/release-orchestrator',
        workflow: 'release-orchestration'
      },
      consumer: {
        repository: 'HagiCode-org/steam_packer',
        workflow: 'package-release'
      },
      publication: {
        container: 'hagicode-steam',
        versionDirectory: 'v0.1.0-beta.33/',
        rootIndexPath: 'index.json'
      }
    }
  });

  return {
    planPath,
    desktopArchivePath,
    serviceArchivePath: fixturePath('hagicode-0.1.0-beta.33-linux-x64-nort.zip'),
    steamDataPath
  };
}

test('delegated handoff fails during build-plan validation before packaging starts', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'steam-packer-handoff-invalid-'));
  const invalidPlanPath = path.join(tempRoot, 'invalid-build-plan.json');

  await writeJson(invalidPlanPath, {
    release: {
      tag: 'v0.1.0-beta.33'
    }
  });

  await assert.rejects(
    () =>
      executeReleasePlan({
        planPath: invalidPlanPath,
        runRoot: path.join(tempRoot, 'run')
      }),
    (error) => error.stage === 'build-plan-validation' && /handoff/.test(error.message)
  );
});

test('delegated handoff surfaces packaging-stage failures separately from plan validation', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'steam-packer-handoff-packaging-'));
  const fixture = await createPlanFixture(tempRoot);
  const toolchainFixture = await createMockPortableToolchainConfig(tempRoot);

  await assert.rejects(
    () =>
      executeReleasePlan({
        planPath: fixture.planPath,
        runRoot: path.join(tempRoot, 'run'),
        desktopAssetSource: fixture.desktopArchivePath,
        serviceAssetSource: path.join(tempRoot, 'missing-service.zip'),
        toolchainConfig: toolchainFixture.configPath,
        forceDryRun: true
      }),
    (error) => error.stage === 'delegated-packaging' && /Failed to download|ENOENT|missing-service/.test(error.message)
  );
});

test('delegated handoff surfaces Azure publication failures separately from packaging', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'steam-packer-handoff-publication-'));
  const fixture = await createPlanFixture(tempRoot, { dryRun: false });
  const toolchainFixture = await createMockPortableToolchainConfig(tempRoot);

  await assert.rejects(
    () =>
      executeReleasePlan({
        planPath: fixture.planPath,
        runRoot: path.join(tempRoot, 'run'),
        desktopAssetSource: fixture.desktopArchivePath,
        serviceAssetSource: fixture.serviceArchivePath,
        toolchainConfig: toolchainFixture.configPath,
        steamAzureSasUrl: 'https://example.blob.core.windows.net/hagicode-steam?sp=racwl&sig=test-token',
        steamAppKey: STEAM_APP_KEY,
        steamDataPath: fixture.steamDataPath,
        linuxDepotId: '123',
        windowsDepotId: '456',
        macosDepotId: '789',
        fetchImpl: async (url, options = {}) => {
          const parsed = new URL(url);
          const blobPath = parsed.pathname.split('/').slice(2).join('/');
          if ((options.method ?? 'GET') === 'PUT' && blobPath.endsWith('.zip')) {
            return new Response('upload failed', { status: 500 });
          }
          if (parsed.searchParams.get('comp') === 'list') {
            return new Response('<?xml version="1.0" encoding="utf-8"?><EnumerationResults><Blobs></Blobs></EnumerationResults>', {
              status: 200,
              headers: { 'content-type': 'application/xml' }
            });
          }
          if (blobPath === 'index.json') {
            return new Response(
              JSON.stringify({ schemaVersion: 1, generatedAt: '2026-04-21T00:00:00.000Z', versions: [] }, null, 2),
              {
                status: 200,
                headers: { 'content-type': 'application/json' }
              }
            );
          }
          return new Response('not found', { status: 404 });
        }
      }),
    (error) => error.stage === 'azure-publication' && /Failed to upload Azure blob/.test(error.message)
  );
});

test('delegated handoff fails before index write when steamAppKey is missing', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'steam-packer-handoff-missing-app-'));
  const fixture = await createPlanFixture(tempRoot, { dryRun: true });
  const toolchainFixture = await createMockPortableToolchainConfig(tempRoot);

  await assert.rejects(
    () =>
      executeReleasePlan({
        planPath: fixture.planPath,
        runRoot: path.join(tempRoot, 'run'),
        desktopAssetSource: fixture.desktopArchivePath,
        serviceAssetSource: fixture.serviceArchivePath,
        toolchainConfig: toolchainFixture.configPath,
        steamDataPath: fixture.steamDataPath,
        forceDryRun: true
      }),
    (error) => error.stage === 'azure-publication' && /steamAppKey/.test(error.message)
  );
});

test('delegated handoff fails before index write when shared Steam data is missing', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'steam-packer-handoff-missing-data-'));
  const fixture = await createPlanFixture(tempRoot, { dryRun: true });
  const toolchainFixture = await createMockPortableToolchainConfig(tempRoot);

  await assert.rejects(
    () =>
      executeReleasePlan({
        planPath: fixture.planPath,
        runRoot: path.join(tempRoot, 'run'),
        desktopAssetSource: fixture.desktopArchivePath,
        serviceAssetSource: fixture.serviceArchivePath,
        toolchainConfig: toolchainFixture.configPath,
        steamAppKey: STEAM_APP_KEY,
        steamDataPath: path.join(tempRoot, 'missing-steam-index.json'),
        forceDryRun: true
      }),
    (error) => error.stage === 'azure-publication' && /Failed to read shared Steam dataset/.test(error.message)
  );
});

test('delegated handoff fails before index write when steamAppKey is unknown', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'steam-packer-handoff-unknown-key-'));
  const fixture = await createPlanFixture(tempRoot, { dryRun: true });
  const toolchainFixture = await createMockPortableToolchainConfig(tempRoot);

  await assert.rejects(
    () =>
      executeReleasePlan({
        planPath: fixture.planPath,
        runRoot: path.join(tempRoot, 'run'),
        desktopAssetSource: fixture.desktopArchivePath,
        serviceAssetSource: fixture.serviceArchivePath,
        toolchainConfig: toolchainFixture.configPath,
        steamAppKey: 'missing-app',
        steamDataPath: fixture.steamDataPath,
        forceDryRun: true
      }),
    (error) =>
      error.stage === 'azure-publication' &&
      /does not define applications\[\]\.key "missing-app"/.test(error.message)
  );
});
