import {
  expandRequestedPlatformsForAssets,
  matchDesktopAssetForPlatform,
  matchServiceAssetForPlatform,
  stripGitRef
} from './platforms.mjs';

export const DEFAULT_INDEX_SOURCES = {
  desktop: 'https://index.hagicode.com/desktop/index.json',
  service: 'https://index.hagicode.com/server/index.json'
};

export const DEFAULT_INDEX_MANIFEST_PATH = 'index.json';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sanitizeSourceUrlForLogs(url) {
  if (!url) {
    return '[empty-url]';
  }

  try {
    const parsed = new URL(url);
    return parsed.search ? `${parsed.origin}${parsed.pathname}?<sas-token-redacted>` : url;
  } catch {
    const normalized = String(url);
    const queryIndex = normalized.indexOf('?');
    return queryIndex >= 0 ? `${normalized.slice(0, queryIndex)}?<sas-token-redacted>` : normalized;
  }
}

function getFetch(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required to read index manifests.');
  }

  return fetchImpl;
}

function normalizeSelectorValue(value) {
  return stripGitRef(value).trim();
}

function compareNumeric(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function compareIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);

  if (leftNumeric && rightNumeric) {
    return compareNumeric(left, 0) - compareNumeric(right, 0);
  }

  if (leftNumeric) {
    return -1;
  }

  if (rightNumeric) {
    return 1;
  }

  return left.localeCompare(right);
}

function parseVersion(value) {
  const normalized = normalizeSelectorValue(value).replace(/^v/i, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(normalized);

  if (!match) {
    return {
      raw: normalized,
      numeric: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
      prerelease: null,
      valid: false
    };
  }

  return {
    raw: normalized,
    numeric: match.slice(1, 4).map((entry) => Number.parseInt(entry, 10)),
    prerelease: match[4] ? match[4].split('.') : null,
    valid: true
  };
}

export function compareNormalizedVersions(left, right) {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);

  for (let index = 0; index < 3; index += 1) {
    const diff = leftVersion.numeric[index] - rightVersion.numeric[index];
    if (diff !== 0) {
      return diff;
    }
  }

  if (!leftVersion.prerelease && !rightVersion.prerelease) {
    return 0;
  }

  if (!leftVersion.prerelease) {
    return 1;
  }

  if (!rightVersion.prerelease) {
    return -1;
  }

  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];

    if (leftIdentifier === undefined) {
      return -1;
    }

    if (rightIdentifier === undefined) {
      return 1;
    }

    const diff = compareIdentifier(leftIdentifier, rightIdentifier);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

export function normalizeVersionSelector(selector) {
  if (selector === undefined || selector === null || String(selector).trim() === '') {
    return null;
  }

  const normalized = normalizeSelectorValue(selector);
  const withoutV = normalized.replace(/^v/i, '');
  const withV = `v${withoutV}`;

  return {
    raw: String(selector),
    normalized,
    candidates: unique([normalized, withoutV, withV])
  };
}

export function selectorMatchesVersion(selector, version) {
  if (!selector) {
    return true;
  }

  const normalizedVersion = normalizeVersionSelector(version);
  return selector.candidates.some((candidate) => normalizedVersion?.candidates.includes(candidate));
}

function normalizeFileAsset(entry) {
  if (typeof entry === 'string') {
    const normalizedPath = entry.replace(/^\/+/, '');
    return {
      name: normalizedPath.split('/').pop(),
      path: normalizedPath,
      size: null,
      directUrl: null,
      lastModified: null
    };
  }

  return entry;
}

export function getVersionEntries(manifest) {
  const entries = manifest?.packages ?? manifest?.versions;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Index manifest does not contain any version entries.');
  }

  return entries;
}

export function getAssetEntries(versionEntry) {
  const candidates = [versionEntry?.assets, versionEntry?.downloads, versionEntry?.artifacts, versionEntry?.files];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate.map(normalizeFileAsset);
    }
  }

  throw new Error(`Index version ${versionEntry?.version ?? 'unknown'} does not expose any assets.`);
}

function resolveLatestVersionEntry(entries) {
  return [...entries].sort((left, right) => compareNormalizedVersions(right.version, left.version))[0];
}

export function resolveVersionEntry({ manifest, selector, sourceLabel }) {
  const entries = getVersionEntries(manifest);
  const normalizedSelector = normalizeVersionSelector(selector);

  if (!normalizedSelector) {
    return resolveLatestVersionEntry(entries);
  }

  const matchedEntry = entries.find((entry) => selectorMatchesVersion(normalizedSelector, entry.version));
  if (!matchedEntry) {
    throw new Error(
      `Unable to find ${sourceLabel} version matching selector "${selector}" in ${sourceLabel} index.`
    );
  }

  return matchedEntry;
}

function ensureAddressableAsset(asset, platformId, sourceLabel, version) {
  if (!asset?.path || String(asset.path).trim() === '') {
    throw new Error(
      `${sourceLabel} asset ${asset?.name ?? '<unknown>'} for ${platformId} in version ${version} cannot be downloaded through Azure SAS because index path is missing.`
    );
  }

  return asset;
}

function mapAssetRecord(asset) {
  return {
    name: asset.name,
    path: asset.path,
    size: asset.size ?? null,
    directUrl: asset.directUrl ?? asset.downloadUrl ?? asset.url ?? null,
    lastModified: asset.lastModified ?? asset.updatedAt ?? null,
    sha256: asset.sha256 ?? null,
    infoHash: asset.infoHash ?? null,
    torrentUrl: asset.torrentUrl ?? null,
    webSeeds: Array.isArray(asset.webSeeds) ? [...asset.webSeeds] : []
  };
}

export function mapIndexAssetsByPlatform({ sourceType, versionEntry, platforms }) {
  const allAssets = getAssetEntries(versionEntry);
  const matcher = sourceType === 'desktop' ? matchDesktopAssetForPlatform : matchServiceAssetForPlatform;
  const sourceLabel = sourceType === 'desktop' ? 'Desktop' : 'Service';
  const assetsByPlatform = {};
  const assetPlatforms = expandRequestedPlatformsForAssets(platforms, sourceType);

  for (const platformId of assetPlatforms) {
    const matchedAsset = ensureAddressableAsset(
      matcher(allAssets, platformId),
      platformId,
      sourceLabel,
      versionEntry.version
    );
    assetsByPlatform[platformId] = mapAssetRecord(matchedAsset);
  }

  return assetsByPlatform;
}

export async function fetchIndexManifest(indexUrl, { fetchImpl } = {}) {
  const response = await getFetch(fetchImpl)(indexUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'steam-packer-automation'
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to read index manifest ${sanitizeSourceUrlForLogs(indexUrl)}: ${response.status} ${body}`
    );
  }

  return response.json();
}

export async function resolveIndexRelease({
  sourceType,
  indexUrl,
  manifestUrl = indexUrl,
  selector,
  platforms,
  fetchImpl,
  sourceAuthority = 'index-site',
  manifestPath = null
}) {
  const manifest = await fetchIndexManifest(indexUrl, { fetchImpl });
  const versionEntry = resolveVersionEntry({
    manifest,
    selector,
    sourceLabel: sourceType === 'desktop' ? 'Desktop' : 'Service'
  });

  return {
    sourceType: 'index',
    sourceAuthority,
    manifestUrl,
    manifestPath,
    selector: normalizeVersionSelector(selector)?.normalized ?? null,
    version: versionEntry.version,
    updatedAt: manifest.updatedAt ?? null,
    assetsByPlatform: mapIndexAssetsByPlatform({
      sourceType,
      versionEntry,
      platforms
    })
  };
}
