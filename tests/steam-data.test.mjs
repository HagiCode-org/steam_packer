import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { writeJson } from '../scripts/lib/fs-utils.mjs';
import { DEFAULT_STEAM_DATA_URL, loadSteamDataSet } from '../scripts/lib/steam-data.mjs';

function createSteamDataSet() {
  return {
    version: '1.0.0',
    updatedAt: '2026-04-21T00:00:00.000Z',
    applications: [
      {
        key: 'hagicode',
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
  };
}

test('loadSteamDataSet reads a local JSON file override', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'steam-packer-steam-data-'));
  const localDataPath = path.join(tempRoot, 'shared', 'steam', 'index.json');

  await writeJson(localDataPath, createSteamDataSet());

  const dataset = await loadSteamDataSet(localDataPath);

  assert.equal(dataset.sourcePath, localDataPath);
  assert.equal(dataset.applicationMap.get('hagicode').storeAppId, '4625540');
});

test('loadSteamDataSet downloads the default online dataset', async () => {
  const dataset = await loadSteamDataSet(undefined, {
    fetchImpl: async (url) => {
      assert.equal(url, DEFAULT_STEAM_DATA_URL);
      return new Response(JSON.stringify(createSteamDataSet()), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  assert.equal(dataset.sourcePath, DEFAULT_STEAM_DATA_URL);
  assert.equal(dataset.applicationMap.get('hagicode').platformAppIds.linux, '4625542');
});
