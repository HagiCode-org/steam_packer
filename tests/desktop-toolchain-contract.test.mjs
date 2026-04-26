import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
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

async function startStaticServer(routes) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const route = routes.get(url.pathname);
      if (!route) {
        response.statusCode = 404;
        response.end('not found');
        return;
      }

      if (route.type === 'json') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(route.body));
        return;
      }

      response.setHeader('content-type', route.contentType ?? 'application/octet-stream');
      response.end(await readFile(route.filePath));
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

function manifestPath(desktopRoot) {
  return path.join(desktopRoot, 'resources', 'extra', 'toolchain', 'toolchain-manifest.json');
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

test('desktop toolchain contract accepts bundled Desktop toolchain without manifest', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'steam-packer-toolchain-no-manifest-'));
  const desktopRoot = await copyDesktopFixture(tempRoot);
  await rm(manifestPath(desktopRoot), { force: true });
  await rm(
    path.join(desktopRoot, 'resources', 'extra', 'toolchain', 'bin'),
    { recursive: true, force: true }
  );

  const validation = await validateDesktopToolchainContract({
    platformContentRoot: desktopRoot,
    platformId: 'linux-x64',
  });

  assert.equal(validation.valid, true);
  assert.equal(validation.manifestPresent, false);
  assert.equal(validation.contractMode, 'bundled-content-fallback');
  assert.equal(validation.activationPolicy.enabled, true);
  assert.equal(validation.activationPolicy.source, 'bundled-content-fallback');
  assert.equal(validation.selectedRootSource, 'canonical-toolchain');
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
  assert.equal(workspaceManifest.toolchainRootSource, 'canonical-toolchain');
});

test('workspace preparation persists bundled-content fallback when manifest is missing', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'steam-packer-workspace-no-manifest-'));
  const desktopRoot = await copyDesktopFixture(tempRoot);
  const desktopArchivePath = path.join(tempRoot, 'hagicode-desktop-0.2.0.zip');
  const planPath = path.join(tempRoot, 'build-plan.json');
  const workspacePath = path.join(tempRoot, 'workspace');
  await rm(manifestPath(desktopRoot), { force: true });
  await rm(
    path.join(desktopRoot, 'resources', 'extra', 'toolchain', 'bin'),
    { recursive: true, force: true }
  );
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
  assert.equal(workspaceManifest.toolchainActivationPolicy.source, 'bundled-content-fallback');
  assert.equal(workspaceManifest.toolchainRootSource, 'canonical-toolchain');
});

test('workspace preparation falls back to an alternate desktop asset when the selected asset is missing the bundled toolchain', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'steam-packer-workspace-fallback-'));
  const brokenDesktopRoot = await copyDesktopFixture(path.join(tempRoot, 'broken'));
  const validDesktopRoot = await copyDesktopFixture(path.join(tempRoot, 'valid'));
  const brokenArchivePath = path.join(tempRoot, 'hagicode-desktop-0.2.0.zip');
  const fallbackArchivePath = path.join(tempRoot, 'hagicode-desktop-0.2.0.tar.gz');
  const planPath = path.join(tempRoot, 'build-plan.json');
  const workspacePath = path.join(tempRoot, 'workspace');

  await rm(path.join(brokenDesktopRoot, 'resources', 'extra', 'toolchain'), {
    recursive: true,
    force: true
  });

  await createArchive(brokenDesktopRoot, brokenArchivePath);
  await createArchive(validDesktopRoot, fallbackArchivePath);

  const routes = new Map();
  let server;
  try {
    server = await startStaticServer(routes);
    routes.set('/desktop/index.json', {
      type: 'json',
      body: {
        versions: [
          {
            version: 'v0.2.0',
            assets: [
              {
                name: 'hagicode-desktop-0.2.0.zip',
                path: 'v0.2.0/hagicode-desktop-0.2.0.zip',
                directUrl: `${server.origin}/downloads/hagicode-desktop-0.2.0.zip`,
              },
              {
                name: 'hagicode-desktop-0.2.0.tar.gz',
                path: 'v0.2.0/hagicode-desktop-0.2.0.tar.gz',
                directUrl: `${server.origin}/downloads/hagicode-desktop-0.2.0.tar.gz`,
              },
            ],
          },
        ],
      }
    });
    routes.set('/downloads/hagicode-desktop-0.2.0.zip', {
      type: 'file',
      filePath: brokenArchivePath,
      contentType: 'application/zip'
    });
    routes.set('/downloads/hagicode-desktop-0.2.0.tar.gz', {
      type: 'file',
      filePath: fallbackArchivePath,
      contentType: 'application/gzip'
    });

    await writeJson(planPath, {
      platforms: ['linux-x64'],
      upstream: {
        desktop: {
          version: 'v0.2.0',
          manifestUrl: `${server.origin}/desktop/index.json`,
          assetsByPlatform: {
            'linux-x64': {
              name: 'hagicode-desktop-0.2.0.zip',
              path: 'v0.2.0/hagicode-desktop-0.2.0.zip',
              directUrl: `${server.origin}/downloads/hagicode-desktop-0.2.0.zip`,
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
    ]);
  } finally {
    await server?.close();
  }

  const workspaceManifest = await readJson(path.join(workspacePath, 'workspace-manifest.json'));
  assert.equal(workspaceManifest.desktopAssetName, 'hagicode-desktop-0.2.0.tar.gz');
  assert.equal(workspaceManifest.requestedDesktopAssetName, 'hagicode-desktop-0.2.0.zip');
  assert.equal(workspaceManifest.desktopAssetFallbackUsed, true);
  assert.equal(workspaceManifest.bundledToolchainEnabled, true);
  assert.equal(workspaceManifest.attemptedDesktopAssets.length, 2);
  assert.equal(workspaceManifest.attemptedDesktopAssets[0].status, 'rejected');
  assert.equal(workspaceManifest.attemptedDesktopAssets[1].status, 'accepted');
});
