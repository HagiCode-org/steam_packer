import http from 'node:http';
import https from 'node:https';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, readFile, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { compareNormalizedVersions } from './index-source.mjs';

const DEFAULT_AZURE_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_AZURE_UPLOAD_MAX_ATTEMPTS = 3;
const DEFAULT_AZURE_UPLOAD_RETRY_BASE_DELAY_MS = 1_000;
const RETRIABLE_AZURE_UPLOAD_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const RETRIABLE_AZURE_UPLOAD_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT'
]);

function assertNonEmpty(value, message) {
  if (!value || String(value).trim() === '') {
    throw new Error(message);
  }
}

function assertObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
}

function normalizeString(value, message) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function readPositiveIntegerFromEnv(names, fallbackValue) {
  for (const name of names) {
    const candidate = process.env[name];
    if (candidate === undefined) {
      continue;
    }

    const parsed = Number.parseInt(String(candidate), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return fallbackValue;
}

function resolveAzureUploadSettings() {
  return {
    timeoutMs: readPositiveIntegerFromEnv(
      ['STEAM_PACKER_AZURE_UPLOAD_TIMEOUT_MS', 'AZURE_BLOB_UPLOAD_TIMEOUT_MS'],
      DEFAULT_AZURE_UPLOAD_TIMEOUT_MS
    ),
    maxAttempts: readPositiveIntegerFromEnv(
      ['STEAM_PACKER_AZURE_UPLOAD_MAX_ATTEMPTS', 'AZURE_BLOB_UPLOAD_MAX_ATTEMPTS'],
      DEFAULT_AZURE_UPLOAD_MAX_ATTEMPTS
    ),
    retryBaseDelayMs: readPositiveIntegerFromEnv(
      ['STEAM_PACKER_AZURE_UPLOAD_RETRY_BASE_DELAY_MS', 'AZURE_BLOB_UPLOAD_RETRY_BASE_DELAY_MS'],
      DEFAULT_AZURE_UPLOAD_RETRY_BASE_DELAY_MS
    )
  };
}

function sleep(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function calculateRetryDelayMs(attemptNumber, retryBaseDelayMs) {
  return retryBaseDelayMs * 2 ** Math.max(0, attemptNumber - 1);
}

function isRetriableAzureUploadStatus(status) {
  return RETRIABLE_AZURE_UPLOAD_STATUS_CODES.has(Number(status));
}

function isRetriableAzureUploadError(error) {
  const directCode = error?.code;
  const causeCode = error?.cause?.code;
  return RETRIABLE_AZURE_UPLOAD_ERROR_CODES.has(directCode) || RETRIABLE_AZURE_UPLOAD_ERROR_CODES.has(causeCode);
}

function buildAzureUploadFailureError({ targetUrl, attemptNumber, maxAttempts, detail, cause }) {
  return new Error(
    `Failed to upload Azure blob ${sanitizeUrlForLogs(targetUrl)} on attempt ${attemptNumber}/${maxAttempts}: ${detail}`,
    cause ? { cause } : undefined
  );
}

async function describeAzureUploadPayload({ filePath, content }) {
  if (filePath) {
    const fileStats = await stat(filePath);
    return `${fileStats.size} bytes from ${filePath}`;
  }

  if (typeof content === 'string' || Buffer.isBuffer(content) || content instanceof Uint8Array) {
    return `${Buffer.byteLength(content)} bytes inline`;
  }

  return 'inline payload';
}

async function uploadAzureBlobWithNodeRequest({ targetUrl, filePath, content, contentType, timeoutMs }) {
  const url = new URL(targetUrl);
  const requestImpl = url.protocol === 'http:' ? http.request : https.request;
  const requestHeaders = {
    'x-ms-blob-type': 'BlockBlob',
    'x-ms-version': '2023-11-03',
    'content-type': contentType
  };

  let requestBody = content;
  if (filePath) {
    const fileStats = await stat(filePath);
    requestHeaders['content-length'] = String(fileStats.size);
  } else if (typeof content === 'string' || Buffer.isBuffer(content) || content instanceof Uint8Array) {
    requestHeaders['content-length'] = String(Buffer.byteLength(content));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finishResolve = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const finishReject = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    const request = requestImpl(
      url,
      {
        method: 'PUT',
        headers: requestHeaders
      },
      (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          finishResolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode ?? 0,
            body: responseBody
          });
        });
        response.on('error', finishReject);
      }
    );

    request.setTimeout(timeoutMs, () => {
      const timeoutError = new Error(`Azure blob upload timed out after ${timeoutMs}ms.`);
      timeoutError.code = 'ETIMEDOUT';
      request.destroy(timeoutError);
    });

    request.on('error', finishReject);

    if (filePath) {
      const stream = createReadStream(filePath);
      stream.on('error', (error) => {
        request.destroy(error);
      });
      stream.pipe(request);
      return;
    }

    if (requestBody instanceof Uint8Array && !Buffer.isBuffer(requestBody)) {
      requestBody = Buffer.from(requestBody);
    }
    request.end(requestBody);
  });
}

async function uploadAzureBlobWithFetch({
  targetUrl,
  filePath,
  content,
  contentType,
  fetchImpl
}) {
  const body = filePath ? await readFile(filePath) : content;

  if (body === undefined || body === null) {
    throw new Error('Azure blob upload requires either filePath or content.');
  }

  const response = await fetchImpl(targetUrl, {
    method: 'PUT',
    headers: {
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-version': '2023-11-03',
      'content-type': contentType
    },
    body
  });

  return {
    ok: response.ok,
    status: response.status,
    body: response.ok ? '' : await response.text()
  };
}

function xmlEntityDecode(value) {
  return String(value)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function extractXmlValue(block, tagName) {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = pattern.exec(block);
  return match ? xmlEntityDecode(match[1]) : null;
}

function contentTypeFromPath(blobPath) {
  if (blobPath.endsWith('.json')) {
    return 'application/json; charset=utf-8';
  }
  if (blobPath.endsWith('.txt')) {
    return 'text/plain; charset=utf-8';
  }
  if (blobPath.endsWith('.zip')) {
    return 'application/zip';
  }
  return 'application/octet-stream';
}

function mapArtifactRecord(artifact, releaseTag) {
  const normalized = assertArtifactRecord(artifact, releaseTag);
  return {
    platform: normalized.platform,
    name: normalized.name,
    fileName: normalized.fileName,
    path: normalized.path,
    sizeBytes: normalized.sizeBytes,
    sha256: normalized.sha256,
    sourcePath: normalized.sourcePath,
    outputPath: normalized.outputPath
  };
}

function sortVersionEntries(entries) {
  return [...entries].sort((left, right) => compareNormalizedVersions(right.version, left.version));
}

function assertSteamDepotIds(steamDepotIds, label) {
  assertObject(steamDepotIds, `${label} must be an object.`);
  return {
    linux: normalizeString(steamDepotIds.linux, `${label}.linux must be a non-empty string.`),
    windows: normalizeString(steamDepotIds.windows, `${label}.windows must be a non-empty string.`),
    macos: normalizeString(steamDepotIds.macos, `${label}.macos must be a non-empty string.`)
  };
}

function assertSteamAppId(steamAppId, label, { allowMissing = false } = {}) {
  const normalized = String(steamAppId ?? '').trim();
  if (!normalized) {
    if (allowMissing) {
      return null;
    }
    throw new Error(`${label} must be a non-empty string.`);
  }
  return normalized;
}

function normalizeMetadataPath(releaseTag, value, fieldName) {
  const normalized = normalizeString(value, `${fieldName} must be a non-empty string.`);
  return normalized.includes('/') ? normalized.replace(/^\/+/, '') : `${releaseTag}/${normalized}`;
}

function assertArtifactRecord(artifact, releaseTag) {
  assertObject(artifact, `Portable Version artifact for ${releaseTag} must be an object.`);
  const platform = normalizeString(
    artifact.platform,
    `Portable Version artifact for ${releaseTag} is missing a platform.`
  );
  const fileName = normalizeString(
    artifact.fileName ?? artifact.name,
    `Portable Version artifact for ${releaseTag} (${platform}) is missing a file name.`
  );
  const blobPath = String(artifact.path ?? '').trim() || `${releaseTag}/${fileName}`;

  return {
    platform,
    name: fileName,
    fileName,
    path: blobPath.replace(/^\/+/, ''),
    sizeBytes: artifact.sizeBytes ?? artifact.size ?? null,
    sha256: artifact.sha256 ?? null,
    sourcePath: artifact.sourcePath ?? null,
    outputPath: artifact.outputPath ?? null
  };
}

function assertPortableVersionVersionEntry(
  versionEntry,
  label,
  { stableSteamAppId = null, requireSteamAppId = false } = {}
) {
  assertObject(versionEntry, `${label} must be an object.`);
  assertObject(versionEntry.metadata, `${label}.metadata must be an object.`);
  const normalizedStableSteamAppId =
    stableSteamAppId === null ? null : assertSteamAppId(stableSteamAppId, `${label}.stableSteamAppId`);

  const artifacts = Array.isArray(versionEntry.artifacts)
    ? versionEntry.artifacts.map((artifact) =>
        assertArtifactRecord(artifact, normalizeString(versionEntry.version, `${label}.version must be a non-empty string.`))
      )
    : (() => {
        throw new Error(`${label}.artifacts must be an array.`);
      })();

  const explicitSteamAppId = assertSteamAppId(versionEntry.steamAppId, `${label}.steamAppId`, {
    allowMissing: true
  });
  if (
    explicitSteamAppId &&
    normalizedStableSteamAppId &&
    explicitSteamAppId !== normalizedStableSteamAppId
  ) {
    throw new Error(
      `${label}.steamAppId conflicts with current publication steamAppId "${normalizedStableSteamAppId}".`
    );
  }
  const resolvedSteamAppId = explicitSteamAppId ?? normalizedStableSteamAppId;
  if (requireSteamAppId && !resolvedSteamAppId) {
    throw new Error(`${label}.steamAppId must be a non-empty string.`);
  }

  return {
    version: normalizeString(versionEntry.version, `${label}.version must be a non-empty string.`),
    metadata: {
      buildManifestPath: normalizeString(
        versionEntry.metadata.buildManifestPath,
        `${label}.metadata.buildManifestPath must be a non-empty string.`
      ),
      artifactInventoryPath: normalizeString(
        versionEntry.metadata.artifactInventoryPath,
        `${label}.metadata.artifactInventoryPath must be a non-empty string.`
      ),
      checksumsPath: normalizeString(
        versionEntry.metadata.checksumsPath,
        `${label}.metadata.checksumsPath must be a non-empty string.`
      )
    },
    steamAppId: resolvedSteamAppId,
    steamDepotIds: assertSteamDepotIds(versionEntry.steamDepotIds, `${label}.steamDepotIds`),
    artifacts: artifacts
      .sort((left, right) => left.platform.localeCompare(right.platform))
      .map((artifact) => ({
        platform: artifact.platform,
        name: artifact.name,
        fileName: artifact.fileName,
        path: artifact.path,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256
      })),
    upstream: versionEntry.upstream ?? null,
    publishedAt: versionEntry.publishedAt ?? null,
    updatedAt: versionEntry.updatedAt ?? null
  };
}

export function sanitizeUrlForLogs(url) {
  if (!url) {
    return '[empty-url]';
  }

  try {
    const parsed = new URL(url);
    return parsed.search
      ? `${parsed.origin}${parsed.pathname}?<sas-token-redacted>`
      : `${parsed.origin}${parsed.pathname}`;
  } catch {
    const normalized = String(url);
    const queryIndex = normalized.indexOf('?');
    return queryIndex >= 0 ? `${normalized.slice(0, queryIndex)}?<sas-token-redacted>` : normalized;
  }
}

export function parseAzureSasUrl(sasUrl) {
  assertNonEmpty(sasUrl, 'Azure SAS URL is required.');

  let parsed;
  try {
    parsed = new URL(sasUrl);
  } catch {
    throw new Error('Azure SAS URL is invalid.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Azure SAS URL must use HTTPS, received ${parsed.protocol}.`);
  }

  if (!parsed.search || !parsed.searchParams.has('sig')) {
    throw new Error('Azure SAS URL must include a SAS token with a sig parameter.');
  }

  return parsed;
}

export function getAzureBlobContainerUrl(sasUrl) {
  const parsed = parseAzureSasUrl(sasUrl);
  return `${parsed.origin}${parsed.pathname.replace(/\/?$/, '/')}`;
}

export function buildSignedBlobUrl(sasUrl, assetPath) {
  assertNonEmpty(assetPath, 'Azure blob asset path is required.');

  const parsed = parseAzureSasUrl(sasUrl);
  const containerUrl = new URL(getAzureBlobContainerUrl(parsed.toString()));
  const signedUrl = new URL(String(assetPath).replace(/^\/+/, ''), containerUrl);
  signedUrl.search = parsed.search;
  return signedUrl.toString();
}

export function resolveAssetDownloadUrl({ asset, sasUrl, overrideSource }) {
  if (overrideSource) {
    return overrideSource;
  }

  if (sasUrl) {
    if (!asset?.path || String(asset.path).trim() === '') {
      throw new Error(`Asset ${asset?.name ?? '<unknown>'} is missing index path metadata.`);
    }

    return buildSignedBlobUrl(sasUrl, asset.path);
  }

  const directUrl = asset?.directUrl ?? asset?.downloadUrl ?? asset?.url ?? null;
  if (directUrl) {
    return directUrl;
  }

  throw new Error(`Asset ${asset?.name ?? '<unknown>'} cannot be downloaded because neither a SAS URL nor a direct URL is available.`);
}

export function buildPortableVersionRootIndexUrl(sasUrl) {
  return buildSignedBlobUrl(sasUrl, 'index.json');
}

export function createPortableVersionRootIndexDocument({ generatedAt = new Date().toISOString(), versions = [] } = {}) {
  return {
    schemaVersion: 1,
    generatedAt,
    versions: sortVersionEntries(versions)
  };
}

export function validatePortableVersionRootIndexDocument(
  document,
  {
    sanitizedIndexUrl = '[unknown-portable-version-index]',
    stableSteamAppId = null,
    requireSteamAppId = false
  } = {}
) {
  assertObject(document, `Portable Version root index ${sanitizedIndexUrl} must be a JSON object.`);

  if (!Array.isArray(document.versions)) {
    throw new Error(`Portable Version root index ${sanitizedIndexUrl} is missing a versions array.`);
  }

  return {
    schemaVersion: document.schemaVersion ?? 1,
    generatedAt: document.generatedAt ?? null,
    versions: sortVersionEntries(
      document.versions.map((versionEntry, index) =>
        assertPortableVersionVersionEntry(
          versionEntry,
          `Portable Version root index ${sanitizedIndexUrl}.versions[${index}]`,
          {
            stableSteamAppId,
            requireSteamAppId
          }
        )
      )
    )
  };
}

export function normalizePortableVersionVersionEntry({
  releaseTag,
  metadata,
  steamAppId,
  steamDepotIds,
  artifacts,
  upstream = null,
  publishedAt = new Date().toISOString(),
  updatedAt = publishedAt
} = {}) {
  const normalizedReleaseTag = normalizeString(releaseTag, 'Portable Version releaseTag is required.');
  assertObject(metadata, `Portable Version ${normalizedReleaseTag}.metadata must be an object.`);

  const normalizedArtifacts = Array.isArray(artifacts)
    ? artifacts.map((artifact) => mapArtifactRecord(artifact, normalizedReleaseTag))
    : (() => {
        throw new Error(`Portable Version ${normalizedReleaseTag}.artifacts must be an array.`);
      })();

  return assertPortableVersionVersionEntry(
    {
      version: normalizedReleaseTag,
      metadata: {
        buildManifestPath: normalizeMetadataPath(
          normalizedReleaseTag,
          metadata.buildManifestPath,
          `Portable Version ${normalizedReleaseTag}.metadata.buildManifestPath`
        ),
        artifactInventoryPath: normalizeMetadataPath(
          normalizedReleaseTag,
          metadata.artifactInventoryPath,
          `Portable Version ${normalizedReleaseTag}.metadata.artifactInventoryPath`
        ),
        checksumsPath: normalizeMetadataPath(
          normalizedReleaseTag,
          metadata.checksumsPath,
          `Portable Version ${normalizedReleaseTag}.metadata.checksumsPath`
        )
      },
      steamAppId: assertSteamAppId(
        steamAppId,
        `Portable Version ${normalizedReleaseTag}.steamAppId`
      ),
      steamDepotIds: assertSteamDepotIds(
        steamDepotIds,
        `Portable Version ${normalizedReleaseTag}.steamDepotIds`
      ),
      artifacts: normalizedArtifacts,
      upstream,
      publishedAt,
      updatedAt
    },
    `Portable Version ${normalizedReleaseTag}`,
    { requireSteamAppId: true }
  );
}

export function upsertPortableVersionRootIndexEntry(document, versionEntry, { generatedAt = new Date().toISOString() } = {}) {
  const normalizedVersionEntry = assertPortableVersionVersionEntry(
    versionEntry,
    `Portable Version ${versionEntry?.version ?? '[unknown-release]'}`,
    { requireSteamAppId: true }
  );
  const normalizedDocument = validatePortableVersionRootIndexDocument(document, {
    stableSteamAppId: normalizedVersionEntry.steamAppId,
    requireSteamAppId: true
  });
  const remainingEntries = normalizedDocument.versions.filter(
    (entry) => entry.version !== normalizedVersionEntry.version
  );

  return {
    schemaVersion: normalizedDocument.schemaVersion ?? 1,
    generatedAt,
    versions: sortVersionEntries([...remainingEntries, normalizedVersionEntry])
  };
}

export function resolvePortableVersionIndexEntryByReleaseTag({
  document,
  releaseTag,
  sanitizedIndexUrl = '[unknown-portable-version-index]'
} = {}) {
  const normalizedReleaseTag = normalizeString(releaseTag, 'Portable Version release tag is required.');
  const normalizedDocument = validatePortableVersionRootIndexDocument(document, { sanitizedIndexUrl });
  const matchedEntry = normalizedDocument.versions.find((entry) => entry.version === normalizedReleaseTag);

  if (!matchedEntry) {
    throw new Error(
      `Portable Version root index ${sanitizedIndexUrl} does not contain version "${normalizedReleaseTag}".`
    );
  }

  return matchedEntry;
}

export async function fetchPortableVersionRootIndex({ sasUrl, fetchImpl = fetch } = {}) {
  const indexUrl = buildPortableVersionRootIndexUrl(sasUrl);
  const sanitizedIndexUrl = sanitizeUrlForLogs(indexUrl);
  const response = await fetchImpl(indexUrl, {
    headers: {
      Accept: 'application/json'
    },
    redirect: 'follow'
  });

  if (response.status === 404) {
    return {
      exists: false,
      indexUrl,
      sanitizedIndexUrl,
      document: createPortableVersionRootIndexDocument()
    };
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to download Portable Version root index ${sanitizedIndexUrl}: ${response.status} ${body}`
    );
  }

  const body = await response.text();
  let document;
  try {
    document = JSON.parse(body);
  } catch (error) {
    throw new Error(
      `Failed to parse Portable Version root index ${sanitizedIndexUrl}: ${error.message}`
    );
  }

  return {
    exists: true,
    indexUrl,
    sanitizedIndexUrl,
    document: validatePortableVersionRootIndexDocument(document, { sanitizedIndexUrl })
  };
}

export async function findPortableVersionReleaseByTag({ sasUrl, releaseTag, fetchImpl = fetch } = {}) {
  const { document, sanitizedIndexUrl } = await fetchPortableVersionRootIndex({
    sasUrl,
    fetchImpl
  });
  const normalizedReleaseTag = normalizeString(releaseTag, 'Portable Version release tag is required.');
  return (
    document.versions.find((entry) => entry.version === normalizedReleaseTag)
      ? {
          version: normalizedReleaseTag,
          sanitizedIndexUrl
        }
      : null
  );
}

export async function uploadAzureBlob({
  sasUrl,
  blobPath,
  filePath,
  content,
  contentType,
  fetchImpl = fetch
} = {}) {
  const normalizedBlobPath = normalizeString(blobPath, 'Azure blob path is required.').replace(/^\/+/, '');
  const targetUrl = buildSignedBlobUrl(sasUrl, normalizedBlobPath);
  const normalizedContentType = contentType ?? contentTypeFromPath(normalizedBlobPath);
  const { timeoutMs, maxAttempts, retryBaseDelayMs } = resolveAzureUploadSettings();

  if (!filePath && (content === undefined || content === null)) {
    throw new Error(`Azure blob upload ${normalizedBlobPath} requires either filePath or content.`);
  }

  const payloadDescription = await describeAzureUploadPayload({ filePath, content });
  console.log(
    `[azure-upload] Starting upload for ${normalizedBlobPath} (${payloadDescription}) -> ${sanitizeUrlForLogs(targetUrl)}`
  );

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    try {
      console.log(`[azure-upload] Attempt ${attemptNumber}/${maxAttempts} for ${normalizedBlobPath}`);
      const response =
        fetchImpl === fetch
          ? await uploadAzureBlobWithNodeRequest({
              targetUrl,
              filePath,
              content,
              contentType: normalizedContentType,
              timeoutMs
            })
          : await uploadAzureBlobWithFetch({
              targetUrl,
              filePath,
              content,
              contentType: normalizedContentType,
              fetchImpl
            });

      if (response.ok) {
        console.log(`[azure-upload] Upload succeeded for ${normalizedBlobPath} on attempt ${attemptNumber}/${maxAttempts}`);
        return {
          blobPath: normalizedBlobPath,
          uploadUrl: targetUrl,
          sanitizedUploadUrl: sanitizeUrlForLogs(targetUrl)
        };
      }

      const failure = buildAzureUploadFailureError({
        targetUrl,
        attemptNumber,
        maxAttempts,
        detail: `${response.status} ${response.body}`.trim()
      });

      if (attemptNumber < maxAttempts && isRetriableAzureUploadStatus(response.status)) {
        const delayMs = calculateRetryDelayMs(attemptNumber, retryBaseDelayMs);
        console.warn(
          `[azure-upload] Retrying ${normalizedBlobPath} after HTTP ${response.status} in ${delayMs}ms`
        );
        await sleep(delayMs);
        continue;
      }

      throw failure;
    } catch (error) {
      const failure =
        error instanceof Error && error.message.startsWith('Failed to upload Azure blob')
          ? error
          : buildAzureUploadFailureError({
              targetUrl,
              attemptNumber,
              maxAttempts,
              detail: error?.message ?? String(error),
              cause: error
            });

      if (attemptNumber < maxAttempts && isRetriableAzureUploadError(error)) {
        const delayMs = calculateRetryDelayMs(attemptNumber, retryBaseDelayMs);
        console.warn(
          `[azure-upload] Retrying ${normalizedBlobPath} after transient error in ${delayMs}ms: ${error?.message ?? String(error)}`
        );
        await sleep(delayMs);
        continue;
      }

      throw failure;
    }
  }

  throw new Error(`Failed to upload Azure blob ${sanitizeUrlForLogs(targetUrl)}: retry budget exhausted.`);
}

export async function listAzureBlobs({ sasUrl, prefix = '', fetchImpl = fetch } = {}) {
  const parsed = parseAzureSasUrl(sasUrl);
  const listUrl = new URL(getAzureBlobContainerUrl(parsed.toString()));
  listUrl.search = parsed.search;
  listUrl.searchParams.set('restype', 'container');
  listUrl.searchParams.set('comp', 'list');
  if (prefix) {
    listUrl.searchParams.set('prefix', prefix);
  }

  const response = await fetchImpl(listUrl.toString(), {
    headers: {
      Accept: 'application/xml'
    },
    redirect: 'follow'
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to list Azure blobs under ${sanitizeUrlForLogs(listUrl.toString())}: ${response.status} ${body}`
    );
  }

  const body = await response.text();
  const blobMatches = [...body.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)];
  return blobMatches.map((match) => {
    const block = match[1];
    const name = extractXmlValue(block, 'Name');
    return {
      name,
      sizeBytes: Number.parseInt(extractXmlValue(block, 'Content-Length') ?? '', 10) || null,
      lastModified: extractXmlValue(block, 'Last-Modified')
    };
  });
}

export async function writePortableVersionRootIndex({
  sasUrl,
  document,
  fetchImpl = fetch,
  generatedAt = new Date().toISOString()
} = {}) {
  const normalizedDocument = validatePortableVersionRootIndexDocument(
    {
      ...document,
      generatedAt
    },
    {
      sanitizedIndexUrl: sanitizeUrlForLogs(buildPortableVersionRootIndexUrl(sasUrl)),
      requireSteamAppId: true
    }
  );

  return uploadAzureBlob({
    sasUrl,
    blobPath: 'index.json',
    content: `${JSON.stringify(normalizedDocument, null, 2)}\n`,
    contentType: 'application/json; charset=utf-8',
    fetchImpl
  });
}

export async function downloadFromSource({ sourceUrl, destinationPath, headers, fetchImpl = fetch }) {
  assertNonEmpty(sourceUrl, 'A download source URL is required.');

  if (String(sourceUrl).startsWith('file://')) {
    await copyFile(new URL(sourceUrl), destinationPath);
    return destinationPath;
  }

  if (/^(?:[A-Za-z]:\\|\/)/.test(String(sourceUrl))) {
    await copyFile(sourceUrl, destinationPath);
    return destinationPath;
  }

  const response = await fetchImpl(sourceUrl, {
    headers,
    redirect: 'follow'
  });

  if (!response.ok || !response.body) {
    const body = await response.text();
    throw new Error(`Failed to download ${sanitizeUrlForLogs(sourceUrl)}: ${response.status} ${body}`);
  }

  await pipeline(response.body, createWriteStream(destinationPath));
  return destinationPath;
}
