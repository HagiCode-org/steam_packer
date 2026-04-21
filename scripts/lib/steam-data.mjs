import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './fs-utils.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DEFAULT_STEAM_DATA_PATH = path.resolve(
  repoRoot,
  '..',
  'index',
  'src',
  'data',
  'public',
  'steam',
  'index.json'
);

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

function normalizeApplication(value, index, sourcePath) {
  const label = `shared Steam dataset ${sourcePath} applications[${index}]`;
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

export async function loadSteamDataSet(steamDataPath = DEFAULT_STEAM_DATA_PATH) {
  const sourcePath = path.resolve(steamDataPath);

  let raw;
  try {
    raw = await readJson(sourcePath);
  } catch (error) {
    throw new Error(`Failed to read shared Steam dataset at ${sourcePath}: ${error.message}`);
  }

  const dataset = requireObject(raw, `shared Steam dataset ${sourcePath}`);
  const version = requireNonEmptyString(dataset.version, `shared Steam dataset ${sourcePath}.version`);
  const updatedAt = requireNonEmptyString(dataset.updatedAt, `shared Steam dataset ${sourcePath}.updatedAt`);

  if (!Array.isArray(dataset.applications) || dataset.applications.length === 0) {
    throw new Error(`shared Steam dataset ${sourcePath}.applications must be a non-empty array.`);
  }

  const applications = dataset.applications.map((entry, index) =>
    normalizeApplication(entry, index, sourcePath)
  );
  const applicationMap = new Map();
  for (const application of applications) {
    const normalizedKey = application.key.toLowerCase();
    if (applicationMap.has(normalizedKey)) {
      throw new Error(
        `shared Steam dataset ${sourcePath} contains duplicate applications[].key "${application.key}".`
      );
    }

    applicationMap.set(normalizedKey, application);
  }

  return {
    sourcePath,
    version,
    updatedAt,
    applications,
    applicationMap
  };
}

export async function resolveSteamApplication({ steamAppKey, steamDataPath = DEFAULT_STEAM_DATA_PATH } = {}) {
  const normalizedKey = requireNonEmptyString(steamAppKey, 'steamAppKey');
  const dataset = await loadSteamDataSet(steamDataPath);
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
