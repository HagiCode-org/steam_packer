import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createArchive } from '../scripts/lib/archive.mjs';
import { runCommand } from '../scripts/lib/command.mjs';
import { readJson, writeJson } from '../scripts/lib/fs-utils.mjs';
import { validateDesktopToolchainContract } from '../scripts/lib/desktop-toolchain-contract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'desktop-fixture');

async function copyDesktopFixture(tempRoot) {
  const target = path.join(tempRoot, 'desktop-fixture');
  await cp(fixtureRoot, target, { recursive: true });
  return target;
}

function manifestPath(desktopRoot) {
  return path.join(desktopRoot, 'resources', 'extra', 'portable-fixed', 'toolchain', 'toolchain-manifest.json');
}

async function validateFixtureWithPolicy(policyValue) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'steam-packer-toolchain-policy-'));
  const desktopRoot = await copyDesktopFixture(tempRoot);
  const manifest = await readJson(manifestPath(desktopRoot));
  if (policyValue === 'missing') {
    delete manifest.defaultEnabledByConsumer;
  } else {
    manifest.defaultEnabledByConsumer = {
      desktop: false,
      'steam-packer': policyValue,
    };
  }
  await writeJson(manifestPath(desktopRoot), manifest);

  return validateDesktopToolchainContract({
    platformContentRoot: desktopRoot,
    platformId: 'linux-x64',
  });
}

test('desktop toolchain contract accepts explicit steam-packer true policy', async () => {
  const validation = await validateFixtureWithPolicy(true);

  assert.equal(validation.valid, true);
  assert.equal(validation.activationPolicy.enabled, true);
  assert.equal(validation.activationPolicy.source, 'manifest-default');
  assert.equal(validation.activationPolicy.manifestDefault, true);
});

test('desktop toolchain contract rejects explicit steam-packer false policy', async () => {
  const validation = await validateFixtureWithPolicy(false);

  assert.equal(validation.valid, false);
  assert.equal(validation.activationPolicy.enabled, false);
  assert.match(validation.errors.join('\n'), /defaultEnabledByConsumer\['steam-packer'\] must be true/);
});

test('desktop toolchain contract enables legacy manifests without the policy field', async () => {
  const validation = await validateFixtureWithPolicy('missing');

  assert.equal(validation.valid, true);
  assert.equal(validation.activationPolicy.enabled, true);
  assert.equal(validation.activationPolicy.source, 'legacy-fallback');
  assert.equal(validation.activationPolicy.manifestDefault, null);
});

test('workspace preparation persists legacy fallback activation policy', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'steam-packer-workspace-policy-'));
  const desktopRoot = await copyDesktopFixture(tempRoot);
  const manifest = await readJson(manifestPath(desktopRoot));
  delete manifest.defaultEnabledByConsumer;
  await writeJson(manifestPath(desktopRoot), manifest);

  const desktopArchivePath = path.join(tempRoot, 'hagicode-desktop-0.2.0.zip');
  const planPath = path.join(tempRoot, 'build-plan.json');
  const workspacePath = path.join(tempRoot, 'workspace');
  await createArchive(desktopRoot, desktopArchivePath);
  await writeJson(planPath, {
    platforms: ['linux-x64'],
    upstream: {
      desktop: {
        version: 'v0.2.0',
        assetsByPlatform: {
          'linux-x64': {
            name: 'hagicode-desktop-0.2.0.zip',
            path: 'v0.2.0/hagicode-desktop-0.2.0.zip',
          },
        },
      },
    },
    build: { dryRun: true },
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
    desktopArchivePath,
  ]);

  const workspaceManifest = await readJson(path.join(workspacePath, 'workspace-manifest.json'));
  assert.equal(workspaceManifest.bundledToolchainEnabled, true);
  assert.equal(workspaceManifest.toolchainActivationPolicy.source, 'legacy-fallback');
});
