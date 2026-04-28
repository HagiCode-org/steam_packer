import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSteamEnvConfig,
  serializeEnvConfig,
} from '../scripts/lib/env-config.mjs';

test('normalizeSteamEnvConfig writes enabled achievement sync when omitted', () => {
  assert.deepEqual(normalizeSteamEnvConfig(undefined), {
    HAGICODE_MODE: 'steam',
    HAGICODE_STEAM_ACHIEVEMENT_SYNC_ENABLED: 'true',
  });
});

test('normalizeSteamEnvConfig accepts explicit achievement sync enablement', () => {
  assert.deepEqual(normalizeSteamEnvConfig({
    HAGICODE_STEAM_ACHIEVEMENT_SYNC_ENABLED: 'TRUE',
  }), {
    HAGICODE_MODE: 'steam',
    HAGICODE_STEAM_ACHIEVEMENT_SYNC_ENABLED: 'true',
  });
});

test('normalizeSteamEnvConfig accepts explicit achievement sync disablement', () => {
  assert.deepEqual(normalizeSteamEnvConfig({
    HAGICODE_STEAM_ACHIEVEMENT_SYNC_ENABLED: ' false ',
  }), {
    HAGICODE_MODE: 'steam',
    HAGICODE_STEAM_ACHIEVEMENT_SYNC_ENABLED: 'false',
  });
});

test('normalizeSteamEnvConfig rejects invalid achievement sync values', () => {
  assert.throws(
    () => normalizeSteamEnvConfig({
      HAGICODE_STEAM_ACHIEVEMENT_SYNC_ENABLED: 'yes',
    }),
    /HAGICODE_STEAM_ACHIEVEMENT_SYNC_ENABLED must be either "true" or "false"/,
  );
});

test('serializeEnvConfig emits normalized achievement sync option', () => {
  assert.equal(
    serializeEnvConfig({
      HAGICODE_STEAM_ACHIEVEMENT_SYNC_ENABLED: 'false',
    }),
    [
      'HAGICODE_MODE=steam',
      'HAGICODE_STEAM_ACHIEVEMENT_SYNC_ENABLED=false',
    ].join('\n'),
  );
});
