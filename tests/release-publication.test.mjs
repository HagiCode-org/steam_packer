import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { readJson, writeJson } from '../scripts/lib/fs-utils.mjs';
import { publishRelease } from '../scripts/publish-release.mjs';

function createPlan(releaseTag, { dryRun = false } = {}) {
  return {
    trigger: { type: 'workflow_dispatch' },
    upstream: {
      desktop: { manifestUrl: 'https://index.hagicode.com/desktop/index.json', version: 'v0.2.0' },
      service: { manifestUrl: 'https://index.hagicode.com/server/index.json', version: releaseTag.replace(/^v/, '') }
    },
    release: {
      repository: 'HagiCode-org/portable-version',
      tag: releaseTag,
      name: `Portable Version ${releaseTag}`
    },
    build: { dryRun }
  };
}

async function createPublicationFixture({ releaseTag = 'v0.1.0-beta.33', dryRun = false } = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'portable-version-publish-'));
  const planPath = path.join(tempRoot, 'build-plan.json');
  const artifactsDir = path.join(tempRoot, 'artifacts');
  const outputDir = path.join(tempRoot, 'release-metadata');
  const assetPath = path.join(artifactsDir, 'hagicode-portable-linux-x64.zip');

  await mkdir(artifactsDir, { recursive: true });
  await writeJson(planPath, createPlan(releaseTag, { dryRun }));
  await writeFile(assetPath, 'fixture asset', 'utf8');
  await writeJson(path.join(artifactsDir, 'artifact-inventory-linux-x64.json'), {
    releaseTag,
    platform: 'linux-x64',
    artifacts: [
      {
        platform: 'linux-x64',
        fileName: 'hagicode-portable-linux-x64.zip',
        outputPath: '/tmp/non-existent-runner-path/hagicode-portable-linux-x64.zip',
        sha256: 'abc123',
        sizeBytes: 12
      }
    ]
  });
  await writeFile(path.join(artifactsDir, 'artifact-checksums-linux-x64.txt'), 'abc123  hagicode-portable-linux-x64.zip\n', 'utf8');

  return {
    tempRoot,
    planPath,
    artifactsDir,
    outputDir
  };
}

function createAzureFetchStub({
  existingRootIndex = null,
  failBlobPath = null
} = {}) {
  const blobs = new Map();
  if (existingRootIndex) {
    blobs.set('index.json', `${JSON.stringify(existingRootIndex, null, 2)}\n`);
  }

  return async (url, options = {}) => {
    const parsed = new URL(url);
    const blobPath = parsed.pathname.split('/').slice(2).join('/');
    const method = options.method ?? 'GET';

    if (method === 'PUT') {
      if (blobPath === failBlobPath) {
        return new Response('upload failed', { status: 500 });
      }

      const body = Buffer.isBuffer(options.body)
        ? options.body.toString('utf8')
        : String(options.body ?? '');
      blobs.set(blobPath, body);
      return new Response('', { status: 201 });
    }

    if (parsed.searchParams.get('comp') === 'list') {
      const prefix = parsed.searchParams.get('prefix') ?? '';
      const names = [...blobs.keys()].filter((name) => name.startsWith(prefix));
      const xml = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<EnumerationResults>',
        '<Blobs>',
        ...names.map((name) => `<Blob><Name>${name}</Name><Properties><Content-Length>1</Content-Length></Properties></Blob>`),
        '</Blobs>',
        '</EnumerationResults>'
      ].join('');
      return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } });
    }

    if (blobPath === 'index.json') {
      if (!blobs.has(blobPath)) {
        return new Response('not found', { status: 404 });
      }
      return new Response(blobs.get(blobPath), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    if (!blobs.has(blobPath)) {
      return new Response('not found', { status: 404 });
    }

    return new Response(blobs.get(blobPath), { status: 200 });
  };
}

test('publish-release emits an Azure dry-run publication report', async () => {
  const fixture = await createPublicationFixture({ dryRun: true });

  const result = await publishRelease({
    planPath: fixture.planPath,
    artifactsDir: fixture.artifactsDir,
    outputDir: fixture.outputDir,
    forceDryRun: true,
    steamAzureSasUrl: 'https://example.blob.core.windows.net/hagicode-steam?sp=racwl&sig=test-token',
    linuxDepotId: '123',
    windowsDepotId: '456',
    macosDepotId: '789'
  });

  const report = await readJson(path.join(fixture.outputDir, 'v0.1.0-beta.33.publish-dry-run.json'));
  assert.equal(result.releaseTag, 'v0.1.0-beta.33');
  assert.equal(report.releaseIdentity, 'web-only');
  assert.equal(report.azurePublication.versionDirectory, 'v0.1.0-beta.33/');
  assert.equal(report.metadata.buildManifestPath, 'v0.1.0-beta.33/v0.1.0-beta.33.build-manifest.json');
  assert.deepEqual(report.steamDepotIds, {
    linux: '123',
    windows: '456',
    macos: '789'
  });
});

test('publish-release uploads assets to Azure and upserts the root index entry', async () => {
  const fixture = await createPublicationFixture();
  const fetchImpl = createAzureFetchStub({
    existingRootIndex: {
      schemaVersion: 1,
      generatedAt: '2026-04-17T00:00:00.000Z',
      versions: [
        {
          version: 'v0.1.0-beta.20',
          metadata: {
            buildManifestPath: 'v0.1.0-beta.20/v0.1.0-beta.20.build-manifest.json',
            artifactInventoryPath: 'v0.1.0-beta.20/v0.1.0-beta.20.artifact-inventory.json',
            checksumsPath: 'v0.1.0-beta.20/v0.1.0-beta.20.checksums.txt'
          },
          steamDepotIds: {
            linux: '10',
            windows: '11',
            macos: '12'
          },
          artifacts: [
            {
              platform: 'linux-x64',
              name: 'hagicode-portable-linux-x64.zip',
              path: 'v0.1.0-beta.20/hagicode-portable-linux-x64.zip'
            }
          ]
        }
      ]
    }
  });

  const result = await publishRelease({
    planPath: fixture.planPath,
    artifactsDir: fixture.artifactsDir,
    outputDir: fixture.outputDir,
    steamAzureSasUrl: 'https://example.blob.core.windows.net/hagicode-steam?sp=racwl&sig=test-token',
    linuxDepotId: '123',
    windowsDepotId: '456',
    macosDepotId: '789',
    fetchImpl
  });

  const publicationResult = await readJson(path.join(fixture.outputDir, 'v0.1.0-beta.33.publish-result.json'));
  assert.equal(result.releaseTag, 'v0.1.0-beta.33');
  assert.equal(publicationResult.azurePublication.versionDirectory, 'v0.1.0-beta.33/');
  assert.equal(publicationResult.metadata.artifactInventoryPath, 'v0.1.0-beta.33/v0.1.0-beta.33.artifact-inventory.json');
  assert.deepEqual(publicationResult.steamDepotIds, {
    linux: '123',
    windows: '456',
    macos: '789'
  });
});

test('publish-release retries transient Azure upload timeouts and completes publication', async () => {
  const fixture = await createPublicationFixture();
  const releaseTag = 'v0.1.0-beta.33';
  const targetBlobPath = `${releaseTag}/hagicode-portable-linux-x64.zip`;
  const baseFetch = createAzureFetchStub();
  let simulatedTimeoutCount = 0;

  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const blobPath = parsed.pathname.split('/').slice(2).join('/');
    if ((options.method ?? 'GET') === 'PUT' && blobPath === targetBlobPath && simulatedTimeoutCount === 0) {
      simulatedTimeoutCount += 1;
      const timeoutError = new TypeError('fetch failed');
      timeoutError.cause = Object.assign(new Error('Headers Timeout Error'), {
        code: 'UND_ERR_HEADERS_TIMEOUT'
      });
      throw timeoutError;
    }

    return baseFetch(url, options);
  };

  const result = await publishRelease({
    planPath: fixture.planPath,
    artifactsDir: fixture.artifactsDir,
    outputDir: fixture.outputDir,
    steamAzureSasUrl: 'https://example.blob.core.windows.net/hagicode-steam?sp=racwl&sig=test-token',
    linuxDepotId: '123',
    windowsDepotId: '456',
    macosDepotId: '789',
    fetchImpl
  });

  assert.equal(simulatedTimeoutCount, 1);
  assert.equal(result.releaseTag, releaseTag);
});

test('publish-release overwrites the same Azure root index version entry on repeated publication', async () => {
  const fixture = await createPublicationFixture();
  const fetchImpl = createAzureFetchStub({
    existingRootIndex: {
      schemaVersion: 1,
      generatedAt: '2026-04-17T00:00:00.000Z',
      versions: [
        {
          version: 'v0.1.0-beta.33',
          metadata: {
            buildManifestPath: 'v0.1.0-beta.33/old.build-manifest.json',
            artifactInventoryPath: 'v0.1.0-beta.33/old.artifact-inventory.json',
            checksumsPath: 'v0.1.0-beta.33/old.checksums.txt'
          },
          steamDepotIds: {
            linux: '1',
            windows: '2',
            macos: '3'
          },
          artifacts: [
            {
              platform: 'linux-x64',
              name: 'old.zip',
              path: 'v0.1.0-beta.33/old.zip'
            }
          ]
        }
      ]
    }
  });

  await publishRelease({
    planPath: fixture.planPath,
    artifactsDir: fixture.artifactsDir,
    outputDir: fixture.outputDir,
    steamAzureSasUrl: 'https://example.blob.core.windows.net/hagicode-steam?sp=racwl&sig=test-token',
    linuxDepotId: '123',
    windowsDepotId: '456',
    macosDepotId: '789',
    fetchImpl
  });

  const result = await publishRelease({
    planPath: fixture.planPath,
    artifactsDir: fixture.artifactsDir,
    outputDir: fixture.outputDir,
    steamAzureSasUrl: 'https://example.blob.core.windows.net/hagicode-steam?sp=racwl&sig=test-token',
    linuxDepotId: '124',
    windowsDepotId: '457',
    macosDepotId: '790',
    fetchImpl
  });

  const publicationResult = await readJson(path.join(fixture.outputDir, 'v0.1.0-beta.33.publish-result.json'));
  assert.equal(result.releaseTag, 'v0.1.0-beta.33');
  assert.deepEqual(publicationResult.steamDepotIds, {
    linux: '124',
    windows: '457',
    macos: '790'
  });
});

test('publish-release fails when Azure upload does not remain addressable', async () => {
  const fixture = await createPublicationFixture();

  await assert.rejects(
    () =>
      publishRelease({
        planPath: fixture.planPath,
        artifactsDir: fixture.artifactsDir,
        outputDir: fixture.outputDir,
        steamAzureSasUrl: 'https://example.blob.core.windows.net/hagicode-steam?sp=racwl&sig=test-token',
        linuxDepotId: '123',
        windowsDepotId: '456',
        macosDepotId: '789',
        fetchImpl: createAzureFetchStub({
          failBlobPath: 'v0.1.0-beta.33/hagicode-portable-linux-x64.zip'
        })
      }),
    /Failed to upload Azure blob/
  );
});
