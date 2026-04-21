import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createArchive, validateZipPaths } from '../scripts/lib/archive.mjs';
import { runCommand } from '../scripts/lib/command.mjs';
import { readJson, writeJson } from '../scripts/lib/fs-utils.mjs';
import { createMockPortableToolchainConfig } from './helpers/portable-toolchain-fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function fixturePath(...segments) {
  return path.join(repoRoot, 'tests', 'fixtures', ...segments);
}

async function createFixtureArchive(sourceDirectory, archivePath) {
  await createArchive(sourceDirectory, archivePath);
}

test('dry-run packaging stages payload and emits inventory metadata', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'portable-version-dry-run-'));
  const planPath = path.join(tempRoot, 'build-plan.json');
  const workspacePath = path.join(tempRoot, 'workspace');
  const desktopArchivePath = path.join(tempRoot, 'hagicode-desktop-0.2.0.zip');
  const serviceArchivePath = fixturePath('hagicode-0.1.0-beta.33-linux-x64-nort.zip');
  const toolchainFixture = await createMockPortableToolchainConfig(tempRoot);

  await createFixtureArchive(fixturePath('desktop-fixture'), desktopArchivePath);

  await writeJson(planPath, {
    repositories: {
      desktop: 'https://index.hagicode.com/desktop/index.json',
      service: 'https://index.hagicode.com/server/index.json',
      portable: 'HagiCode-org/portable-version'
    },
    downloads: {
      strategy: 'azure-blob-sas',
      desktop: {
        containerUrl: 'https://example.blob.core.windows.net/desktop/'
      },
      service: {
        containerUrl: 'https://example.blob.core.windows.net/server/'
      }
    },
    platforms: ['linux-x64'],
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
      tag: 'v0.1.0-beta.33-v0.2.0'
    },
    build: {
      dryRun: true
    }
  });

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'prepare-packaging-workspace.mjs'),
    '--plan',
    planPath,
    '--platform',
    'linux-x64',
    '--workspace',
    workspacePath,
    '--desktop-asset-source',
    desktopArchivePath
  ]);

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'stage-portable-payload.mjs'),
    '--plan',
    planPath,
    '--platform',
    'linux-x64',
    '--workspace',
    workspacePath,
    '--service-asset-source',
    serviceArchivePath
  ]);

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'stage-portable-toolchain.mjs'),
    '--plan',
    planPath,
    '--platform',
    'linux-x64',
    '--workspace',
    workspacePath,
    '--toolchain-config',
    toolchainFixture.configPath
  ]);

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'verify-portable-toolchain.mjs'),
    '--platform',
    'linux-x64',
    '--workspace',
    workspacePath,
    '--toolchain-config',
    toolchainFixture.configPath
  ]);

  await runCommand('node', [
    path.join(repoRoot, 'scripts', 'package-desktop-portable.mjs'),
    '--plan',
    planPath,
    '--platform',
    'linux-x64',
    '--workspace',
    workspacePath,
    '--force-dry-run'
  ]);

  const inventory = await readJson(path.join(workspacePath, 'artifact-inventory-linux-x64.json'));
  const toolchainReport = await readJson(path.join(workspacePath, 'toolchain-validation-linux-x64.json'));
  const payloadReport = await readJson(path.join(workspacePath, 'payload-validation-linux-x64.json'));
  assert.equal(inventory.artifacts.length, 1);
  assert.equal(inventory.platform, 'linux-x64');
  assert.equal(inventory.artifacts[0].fileName, 'hagicode-portable-linux-x64.zip');
  assert.equal(toolchainReport.validationPassed, true);
  assert.equal(payloadReport.serviceVersion, '0.1.0-beta.33');
  assert.match(payloadReport.downloadSource, /<sas-token-redacted>|hagicode-0\.1\.0-beta\.33-linux-x64-nort\.zip/);
  assert.match(inventory.toolchainValidationPath, /toolchain-validation-linux-x64\.json$/);

  const packagedArchivePath = inventory.artifacts[0].outputPath;
  const archiveListing = (await validateZipPaths(packagedArchivePath)).join('\n');
  assert.match(archiveListing, /resources\/extra\/portable-fixed\/toolchain\/toolchain-manifest\.json/);
  assert.match(archiveListing, /resources\/extra\/portable-fixed\/toolchain\/bin\/openspec/);
  assert.match(archiveListing, /resources\/extra\/portable-fixed\/toolchain\/env\/activate\.sh/);
});
