import path from 'node:path';
import { readJson } from './fs-utils.mjs';

export const DEFAULT_STEAM_APP_KEY = 'hagicode';
export const DEFAULT_STEAM_DATA_URL = 'https://index.hagicode.com/steam/index.json';
export const DEFAULT_STEAM_DATA_SOURCE = DEFAULT_STEAM_DATA_URL;
export const DEFAULT_STEAM_DATA_PATH = DEFAULT_STEAM_DATA_SOURCE;

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return normalized;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value;
}

function normalizePlatformAppIds(value, label) {
  const platformAppIds = requireObject(value, label);

  return {
    windows: requireNonEmptyString(platformAppIds.windows, `${label}.windows`),
    linux: requireNonEmptyString(platformAppIds.linux, `${label}.linux`),
    macos: requireNonEmptyString(platformAppIds.macos, `${label}.macos`)
  };
}

function normalizeApplication(value, index, sourceDescription) {
  const label = `shared Steam dataset ${sourceDescription} applications[${index}]`;
  const application = requireObject(value, label);

  return {
    key: requireNonEmptyString(application.key, `${label}.key`),
    displayName: requireNonEmptyString(application.displayName, `${label}.displayName`),
    kind: requireNonEmptyString(application.kind, `${label}.kind`),
    parentKey:
      application.parentKey === null || application.parentKey === undefined
        ? null
        : requireNonEmptyString(application.parentKey, `${label}.parentKey`),
    storeAppId: requireNonEmptyString(application.storeAppId, `${label}.storeAppId`),
    storeUrl: requireNonEmptyString(application.storeUrl, `${label}.storeUrl`),
    platformAppIds: normalizePlatformAppIds(application.platformAppIds, `${label}.platformAppIds`)
  };
}

function isRemoteSteamDataSource(value) {
  return /^https?:\/\//i.test(String(value ?? ''));
}

async function readRemoteJson(sourceUrl, fetchImpl = fetch) {
  const response = await fetchImpl(sourceUrl, {
    headers: {
      accept: 'application/json'
    },
    redirect: 'follow'
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to download shared Steam dataset from ${sourceUrl}: ${response.status} ${body}`);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Failed to parse shared Steam dataset from ${sourceUrl}: ${error.message}`);
  }
}

function resolveSteamDataSource(steamDataPath) {
  return steamDataPath ?? DEFAULT_STEAM_DATA_SOURCE;
}

export async function loadSteamDataSet(steamDataPath, { fetchImpl = fetch } = {}) {
  const configuredSource = resolveSteamDataSource(steamDataPath);
  const isRemoteSource = isRemoteSteamDataSource(configuredSource);
  const sourceDescription = isRemoteSource ? configuredSource : path.resolve(configuredSource);

  let raw;
  try {
    raw = isRemoteSource
      ? await readRemoteJson(configuredSource, fetchImpl)
      : await readJson(sourceDescription);
  } catch (error) {
    if (error.message.startsWith('Failed to download shared Steam dataset')) {
      throw error;
    }

    throw new Error(`Failed to read shared Steam dataset at ${sourceDescription}: ${error.message}`);
  }

  const dataset = requireObject(raw, `shared Steam dataset ${sourceDescription}`);
  const version = requireNonEmptyString(dataset.version, `shared Steam dataset ${sourceDescription}.version`);
  const updatedAt = requireNonEmptyString(dataset.updatedAt, `shared Steam dataset ${sourceDescription}.updatedAt`);

  if (!Array.isArray(dataset.applications) || dataset.applications.length === 0) {
    throw new Error(`shared Steam dataset ${sourceDescription}.applications must be a non-empty array.`);
  }

  const applications = dataset.applications.map((entry, index) =>
    normalizeApplication(entry, index, sourceDescription)
  );
  const applicationMap = new Map();
  for (const application of applications) {
    const normalizedKey = application.key.toLowerCase();
    if (applicationMap.has(normalizedKey)) {
      throw new Error(
        `shared Steam dataset ${sourceDescription} contains duplicate applications[].key "${application.key}".`
      );
    }

    applicationMap.set(normalizedKey, application);
  }

  return {
    sourcePath: sourceDescription,
    version,
    updatedAt,
    applications,
    applicationMap
  };
}

export async function resolveSteamApplication({ steamAppKey, steamDataPath, fetchImpl } = {}) {
  const normalizedKey = requireNonEmptyString(steamAppKey, 'steamAppKey');
  const dataset = await loadSteamDataSet(steamDataPath, { fetchImpl });
  const application = dataset.applicationMap.get(normalizedKey.toLowerCase());

  if (!application) {
    throw new Error(
      `Shared Steam dataset ${dataset.sourcePath} does not define applications[].key "${normalizedKey}".`
    );
  }

  return {
    dataset,
    application
  };
}

export async function resolveSteamPublicationIdentity({
  steamAppKey = DEFAULT_STEAM_APP_KEY,
  steamDataPath,
  fetchImpl
} = {}) {
  const { dataset, application } = await resolveSteamApplication({
    steamAppKey,
    steamDataPath,
    fetchImpl
  });

  return {
    dataset,
    application,
    steamAppKey: application.key,
    steamAppId: application.storeAppId,
    steamDepotIds: {
      linux: application.platformAppIds.linux,
      windows: application.platformAppIds.windows,
      macos: application.platformAppIds.macos
    }
  };
}
