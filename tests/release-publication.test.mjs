import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { readJson, writeJson } from '../scripts/lib/fs-utils.mjs';
import { publishRelease } from '../scripts/publish-release.mjs';
import { DEFAULT_STEAM_DATA_URL } from '../scripts/lib/steam-data.mjs';

const STEAM_APP_KEY = 'hagicode';
const STEAM_APP_ID = '4625540';
const SHARED_STEAM_DEPOT_IDS = {
  linux: '4625542',
  windows: '4625541',
  macos: '4625543'
};

function createSteamDataSet() {
  return {
    version: '1.0.0',
    updatedAt: '2026-04-21T00:00:00.000Z',
    applications: [
      {
        key: STEAM_APP_KEY,
        displayName: 'HagiCode',
        kind: 'application',
        parentKey: null,
        storeAppId: STEAM_APP_ID,
        storeUrl: 'https://store.steampowered.com/app/4625540/Hagicode/',
        platformAppIds: {
          windows: '4625541',
          linux: '4625542',
          macos: '4625543'
        }
      }
    ]
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, { timeoutMs = 1_000 } = {}) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for asynchronous test condition.');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function azureBlobPathFromUrl(url) {
  const parsed = new URL(url);
  return parsed.pathname.split('/').slice(2).join('/');
}

function createPlan(releaseTag, { dryRun = false } = {}) {
  return {
    trigger: { type: 'workflow_dispatch' },
    upstream: {
      desktop: { manifestUrl: 'https://index.hagicode.com/desktop/index.json', version: 'v0.2.0' },
      service: { manifestUrl: 'https://index.hagicode.com/server/index.json', version: releaseTag.replace(/^v/, '') }
    },
    release: {
      repository: 'HagiCode-org/steam_packer',
      tag: releaseTag,
      name: `Portable Version ${releaseTag}`
    },
    build: { dryRun }
  };
}

const DEFAULT_FIXTURE_ARCHIVES = [
  {
    platform: 'linux-x64',
    fileName: 'hagicode-portable-linux-x64.zip',
    sha256: 'abc123',
    contents: 'fixture asset'
  }
];

async function createPublicationFixture({
  releaseTag = 'v0.1.0-beta.33',
  dryRun = false,
  archives = DEFAULT_FIXTURE_ARCHIVES
} = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'steam-packer-publish-'));
  const planPath = path.join(tempRoot, 'build-plan.json');
  const artifactsDir = path.join(tempRoot, 'artifacts');
  const outputDir = path.join(tempRoot, 'release-metadata');
  const steamDataPath = path.join(tempRoot, 'steam-index.json');

  await mkdir(artifactsDir, { recursive: true });
  await writeJson(planPath, createPlan(releaseTag, { dryRun }));
  await writeJson(steamDataPath, createSteamDataSet());

  for (const archive of archives) {
    const assetPath = path.join(artifactsDir, archive.fileName);
    const contents = archive.contents ?? `fixture asset for ${archive.platform}`;
    await writeFile(assetPath, contents, 'utf8');
    await writeJson(path.join(artifactsDir, `artifact-inventory-${archive.platform}.json`), {
      releaseTag,
      platform: archive.platform,
      artifacts: [
        {
          platform: archive.platform,
          fileName: archive.fileName,
          outputPath: `/tmp/non-existent-runner-path/${archive.fileName}`,
          sha256: archive.sha256,
          sizeBytes: Buffer.byteLength(contents)
        }
      ]
    });
    await writeFile(
      path.join(artifactsDir, `artifact-checksums-${archive.platform}.txt`),
      `${archive.sha256}  ${archive.fileName}\n`,
      'utf8'
    );
  }

  return {
    tempRoot,
    planPath,
    artifactsDir,
    outputDir,
    steamDataPath
  };
}

function createAzureFetchStub({
  existingRootIndex = null,
  failBlobPath = null,
  steamDataSet = null,
  hiddenBlobPaths = [],
  onPutStart = null,
  beforePutResponse = null,
  onList = null
} = {}) {
  const blobs = new Map();
  const hiddenBlobPathSet = new Set(hiddenBlobPaths);
  if (existingRootIndex) {
    blobs.set('index.json', `${JSON.stringify(existingRootIndex, null, 2)}\n`);
  }

  return async (url, options = {}) => {
    const parsed = new URL(url);
    if ((options.method ?? 'GET') === 'GET' && parsed.toString() === DEFAULT_STEAM_DATA_URL && steamDataSet) {
      return new Response(JSON.stringify(steamDataSet), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    const blobPath = azureBlobPathFromUrl(url);
    const method = options.method ?? 'GET';

    if (method === 'PUT') {
      onPutStart?.({ blobPath, url, options });
      await beforePutResponse?.({ blobPath, url, options });
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
      onList?.({ url, options });
      const prefix = parsed.searchParams.get('prefix') ?? '';
      const names = [...blobs.keys()].filter(
        (name) => name.startsWith(prefix) && !hiddenBlobPathSet.has(name)
      );
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
  const azureCalls = [];

  const result = await publishRelease({
    planPath: fixture.planPath,
    artifactsDir: fixture.artifactsDir,
    outputDir: fixture.outputDir,
    forceDryRun: true,
    steamAzureSasUrl: 'https://example.blob.core.windows.net/hagicode-steam?sp=racwl&sig=test-token',
    steamDataPath: fixture.steamDataPath,
    fetchImpl: async (url, options = {}) => {
      azureCalls.push({ url, method: options.method ?? 'GET' });
      return new Response('', { status: 500 });
    }
  });

  const report = await readJson(path.join(fixture.outputDir, 'v0.1.0-beta.33.publish-dry-run.json'));
  assert.equal(result.releaseTag, 'v0.1.0-beta.33');
  assert.equal(report.releaseIdentity, 'web-only');
  assert.equal(report.azurePublication.versionDirectory, 'v0.1.0-beta.33/');
  assert.equal(report.metadata.buildManifestPath, 'v0.1.0-beta.33/v0.1.0-beta.33.build-manifest.json');
  assert.equal(report.steamAppId, STEAM_APP_ID);
  assert.deepEqual(report.steamDepotIds, SHARED_STEAM_DEPOT_IDS);
  assert.equal(report.assetUploads.length, 4);
  assert.deepEqual(azureCalls, []);
});

test('publish-release resolves the shared Steam dataset from the default online source', async () => {
  const fixture = await createPublicationFixture({ dryRun: true });
  const fetchImpl = createAzureFetchStub({
    steamDataSet: createSteamDataSet()
  });

  const result = await publishRelease({
    planPath: fixture.planPath,
    artifactsDir: fixture.artifactsDir,
    outputDir: fixture.outputDir,
    forceDryRun: true,
    steamAzureSasUrl: 'https://example.blob.core.windows.net/hagicode-steam?sp=racwl&sig=test-token',
    fetchImpl
  });

  const report = await readJson(path.join(fixture.outputDir, 'v0.1.0-beta.33.publish-dry-run.json'));
  assert.equal(result.steamAppId, STEAM_APP_ID);
  assert.equal(report.steamAppId, STEAM_APP_ID);
  assert.deepEqual(report.steamDepotIds, SHARED_STEAM_DEPOT_IDS);
});

test('publish-release starts multiple archive uploads before the first archive resolves', async () => {
  const releaseTag = 'v0.1.0-beta.33';
  const archives = [
    {
      platform: 'linux-x64',
      fileName: 'hagicode-portable-linux-x64.zip',
      sha256: 'linux123'
    },
    {
      platform: 'windows-x64',
      fileName: 'hagicode-portable-windows-x64.zip',
      sha256: 'windows123'
    },
    {
      platform: 'macos-arm64',
      fileName: 'hagicode-portable-macos-arm64.zip',
      sha256: 'macos123'
    }
  ];
  const fixture = await createPublicationFixture({ releaseTag, archives });
  const archiveBlobPaths = archives.map((archive) => `${releaseTag}/${archive.fileName}`);
  const expectedStartOrder = [...archiveBlobPaths].sort();
  const firstArchiveDeferred = createDeferred();
  const putStarts = [];
  const fetchImpl = createAzureFetchStub({
    onPutStart: ({ blobPath }) => {
      putStarts.push(blobPath);
    },
    beforePutResponse: async ({ blobPath }) => {
      if (blobPath === archiveBlobPaths[0]) {
        await firstArchiveDeferred.promise;
      }
    }
  });

  const publishPromise = publishRelease({
    planPath: fixture.planPath,
    artifactsDir: fixture.artifactsDir,
    outputDir: fixture.outputDir,
    steamAzureSasUrl: 'https://example.blob.core.windows.net/hagicode-steam?sp=racwl&sig=test-token',
    steamDataPath: fixture.steamDataPath,
    fetchImpl
  });

  await waitFor(() => archiveBlobPaths.every((blobPath) => putStarts.includes(blobPath)));
  assert.deepEqual(putStarts.slice(0, 3), expectedStartOrder);
  firstArchiveDeferred.resolve();

  const result = await publishPromise;
  assert.equal(result.releaseTag, releaseTag);
});

test('publish-release uploads metadata as the second parallel publication step', async () => {
  const releaseTag = 'v0.1.0-beta.33';
  const archives = [
    {
      platform: 'linux-x64',
      fileName: 'hagicode-portable-linux-x64.zip',
      sha256: 'linux123'
    },
    {
      platform: 'windows-x64',
      fileName: 'hagicode-portable-windows-x64.zip',
      sha256: 'windows123'
    }
  ];
  const fixture = await createPublicationFixture({ releaseTag, archives });
  const archiveBlobPaths = archives.map((archive) => `${releaseTag}/${archive.fileName}`);
  const metadataBlobPaths = [
    `${releaseTag}/${releaseTag}.build-manifest.json`,
    `${releaseTag}/${releaseTag}.artifact-inventory.json`,
    `${releaseTag}/${releaseTag}.checksums.txt`
  ];
  const firstMetadataDeferred = createDeferred();
  const putStarts = [];
  const fetchImpl = createAzureFetchStub({
    onPutStart: ({ blobPath }) => {
      putStarts.push(blobPath);
    },
    beforePutResponse: async ({ blobPath }) => {
      if (blobPath === metadataBlobPaths[0]) {
        await firstMetadataDeferred.promise;
      }
    }
  });

  const publishPromise = publishRelease({
    planPath: fixture.planPath,
    artifactsDir: fixture.artifactsDir,
    outputDir: fixture.outputDir,
    steamAzureSasUrl: 'https://example.blob.core.windows.net/hagicode-steam?sp=racwl&sig=test-token',
    steamDataPath: fixture.steamDataPath,
    fetchImpl
  });

  await waitFor(() => metadataBlobPaths.every((blobPath) => putStarts.includes(blobPath)));
  const firstMetadataStartIndex = putStarts.indexOf(metadataBlobPaths[0]);
  assert.deepEqual(putStarts.slice(0, archiveBlobPaths.length), archiveBlobPaths);
  assert.deepEqual(
    putStarts.slice(firstMetadataStartIndex, firstMetadataStartIndex + metadataBlobPaths.length),
    metadataBlobPaths
  );
  firstMetadataDeferred.resolve();

  const result = await publishPromise;
  assert.equal(result.releaseTag, releaseTag);
});

test('publish-release writes index.json only after release prefix visibility verification succeeds', async () => {
  const fixture = await createPublicationFixture();
  const events = [];
  const fetchImpl = createAzureFetchStub({
    onList: () => {
      events.push('list-release-prefix');
    },
    onPutStart: ({ blobPath }) => {
      if (blobPath === 'index.json') {
        events.push('put-root-index');
      }
    }
  });

  await publishRelease({
    planPath: fixture.planPath,
    artifactsDir: fixture.artifactsDir,
    outputDir: fixture.outputDir,
    steamAzureSasUrl: 'https://example.blob.core.windows.net/hagicode-steam?sp=racwl&sig=test-token',
    steamDataPath: fixture.steamDataPath,
    fetchImpl
  });

  assert.deepEqual(events, ['list-release-prefix', 'put-root-index']);
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
    steamDataPath: fixture.steamDataPath,
    fetchImpl
  });

  const publicationResult = await readJson(path.join(fixture.outputDir, 'v0.1.0-beta.33.publish-result.json'));
  const indexResponse = await fetchImpl(
    'https://example.blob.core.windows.net/hagicode-steam/index.json?sp=racwl&sig=test-token'
  );
  const updatedRootIndex = JSON.parse(await indexResponse.text());
  assert.equal(result.releaseTag, 'v0.1.0-beta.33');
  assert.equal(publicationResult.azurePublication.versionDirectory, 'v0.1.0-beta.33/');
  assert.equal(publicationResult.metadata.artifactInventoryPath, 'v0.1.0-beta.33/v0.1.0-beta.33.artifact-inventory.json');
  assert.equal(publicationResult.steamAppId, STEAM_APP_ID);
  assert.deepEqual(publicationResult.steamDepotIds, SHARED_STEAM_DEPOT_IDS);
  assert.deepEqual(Object.keys(publicationResult).sort(), [
    'azurePublication',
    'metadata',
    'releaseTag',
    'steamAppId',
    'steamDepotIds',
    'uploads'
  ]);
  assert.deepEqual(publicationResult.uploads.map((entry) => entry.blobPath), [
    'v0.1.0-beta.33/hagicode-portable-linux-x64.zip',
    'v0.1.0-beta.33/v0.1.0-beta.33.build-manifest.json',
    'v0.1.0-beta.33/v0.1.0-beta.33.artifact-inventory.json',
    'v0.1.0-beta.33/v0.1.0-beta.33.checksums.txt'
  ]);
  assert.deepEqual(
    updatedRootIndex.versions.map((entry) => ({
      version: entry.version,
      steamAppId: entry.steamAppId
    })),
    [
      { version: 'v0.1.0-beta.33', steamAppId: STEAM_APP_ID },
      { version: 'v0.1.0-beta.20', steamAppId: STEAM_APP_ID }
    ]
  );
});

test('publish-release retries transient Azure upload timeouts and completes publication', async () => {
  const archives = [
    {
      platform: 'linux-x64',
      fileName: 'hagicode-portable-linux-x64.zip',
      sha256: 'linux123'
    },
    {
      platform: 'windows-x64',
      fileName: 'hagicode-portable-windows-x64.zip',
      sha256: 'windows123'
    }
  ];
  const fixture = await createPublicationFixture({ archives });
  const releaseTag = 'v0.1.0-beta.33';
  const targetBlobPath = `${releaseTag}/hagicode-portable-linux-x64.zip`;
  const unrelatedBlobPath = `${releaseTag}/hagicode-portable-windows-x64.zip`;
  const putStarts = [];
  const baseFetch = createAzureFetchStub();
  let simulatedTimeoutCount = 0;

  const fetchImpl = async (url, options = {}) => {
    const blobPath = azureBlobPathFromUrl(url);
    if ((options.method ?? 'GET') === 'PUT' && blobPath === targetBlobPath && simulatedTimeoutCount === 0) {
      putStarts.push(blobPath);
      simulatedTimeoutCount += 1;
      const timeoutError = new TypeError('fetch failed');
      timeoutError.cause = Object.assign(new Error('Headers Timeout Error'), {
        code: 'UND_ERR_HEADERS_TIMEOUT'
      });
      throw timeoutError;
    }

    return baseFetch(url, {
      ...options,
      method: options.method
    });
  };

  const observedFetch = async (url, options = {}) => {
    const blobPath = azureBlobPathFromUrl(url);
    if ((options.method ?? 'GET') === 'PUT') {
      putStarts.push(blobPath);
    }
    return fetchImpl(url, options);
  };

  const result = await publishRelease({
    planPath: fixture.planPath,
    artifactsDir: fixture.artifactsDir,
    outputDir: fixture.outputDir,
    steamAzureSasUrl: 'https://example.blob.core.windows.net/hagicode-steam?sp=racwl&sig=test-token',
    steamDataPath: fixture.steamDataPath,
    fetchImpl: observedFetch
  });

  assert.equal(simulatedTimeoutCount, 1);
  assert.ok(putStarts.indexOf(unrelatedBlobPath) < putStarts.lastIndexOf(targetBlobPath));
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
    steamDataPath: fixture.steamDataPath,
    fetchImpl
  });

  const result = await publishRelease({
    planPath: fixture.planPath,
    artifactsDir: fixture.artifactsDir,
    outputDir: fixture.outputDir,
    steamAzureSasUrl: 'https://example.blob.core.windows.net/hagicode-steam?sp=racwl&sig=test-token',
    steamDataPath: fixture.steamDataPath,
    fetchImpl
  });

  const publicationResult = await readJson(path.join(fixture.outputDir, 'v0.1.0-beta.33.publish-result.json'));
  assert.equal(result.releaseTag, 'v0.1.0-beta.33');
  assert.deepEqual(publicationResult.steamDepotIds, SHARED_STEAM_DEPOT_IDS);
  assert.equal(publicationResult.steamAppId, STEAM_APP_ID);
});

test('publish-release fails when the existing root index belongs to a different Steam app', async () => {
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
          steamAppId: '888000',
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

  await assert.rejects(
    () =>
      publishRelease({
        planPath: fixture.planPath,
        artifactsDir: fixture.artifactsDir,
        outputDir: fixture.outputDir,
        steamAzureSasUrl: 'https://example.blob.core.windows.net/hagicode-steam?sp=racwl&sig=test-token',
        steamDataPath: fixture.steamDataPath,
        fetchImpl
      }),
    /conflicts with current publication steamAppId/
  );
});

test('publish-release fails when Azure upload does not remain addressable', async () => {
  const fixture = await createPublicationFixture();
  const rootIndexWrites = [];
  const baseFetch = createAzureFetchStub({
    failBlobPath: 'v0.1.0-beta.33/hagicode-portable-linux-x64.zip'
  });

  await assert.rejects(
    () =>
      publishRelease({
        planPath: fixture.planPath,
        artifactsDir: fixture.artifactsDir,
        outputDir: fixture.outputDir,
        steamAzureSasUrl: 'https://example.blob.core.windows.net/hagicode-steam?sp=racwl&sig=test-token',
        steamDataPath: fixture.steamDataPath,
        fetchImpl: async (url, options = {}) => {
          const blobPath = azureBlobPathFromUrl(url);
          if ((options.method ?? 'GET') === 'PUT' && blobPath === 'index.json') {
            rootIndexWrites.push(blobPath);
          }
          return baseFetch(url, options);
        }
      }),
    /Failed to upload Azure blob/
  );
  assert.deepEqual(rootIndexWrites, []);
});

test('publish-release fails before root index update when uploaded blob is not visible in prefix listing', async () => {
  const fixture = await createPublicationFixture();
  const rootIndexWrites = [];
  const fetchImpl = createAzureFetchStub({
    hiddenBlobPaths: ['v0.1.0-beta.33/hagicode-portable-linux-x64.zip'],
    onPutStart: ({ blobPath }) => {
      if (blobPath === 'index.json') {
        rootIndexWrites.push(blobPath);
      }
    }
  });

  await assert.rejects(
    () =>
      publishRelease({
        planPath: fixture.planPath,
        artifactsDir: fixture.artifactsDir,
        outputDir: fixture.outputDir,
        steamAzureSasUrl: 'https://example.blob.core.windows.net/hagicode-steam?sp=racwl&sig=test-token',
        steamDataPath: fixture.steamDataPath,
        fetchImpl
      }),
    /missing uploaded blob/
  );
  assert.deepEqual(rootIndexWrites, []);
});
