import path from 'node:path';
import { pathExists, readJson } from './fs-utils.mjs';
import { getPlatformConfig } from './platforms.mjs';
import { getNodeExecutableRelativePath, getNpmExecutableRelativePath } from './toolchain.mjs';

const REQUIRED_RUNTIME_COMMANDS = ['node', 'npm'];
const MANAGED_PACKAGES = ['openspec', 'skills', 'omniroute'];
const STEAM_PACKER_CONSUMER = 'steam-packer';

export function resolvePortableFixedRoot(platformContentRoot, platformId) {
  const platform = getPlatformConfig(platformId);
  return path.join(platformContentRoot, ...platform.portableFixedSegments);
}

export function resolveDesktopToolchainRoot(platformContentRoot, platformId) {
  return path.join(resolvePortableFixedRoot(platformContentRoot, platformId), 'toolchain');
}

function isDesktopAuthoredManifest(manifest) {
  return manifest?.owner === 'hagicode-desktop' && manifest?.source === 'bundled-desktop';
}

export function resolveSteamPackerToolchainPolicy(manifest) {
  const matrix = manifest?.defaultEnabledByConsumer;
  if (!matrix || typeof matrix !== 'object' || !Object.hasOwn(matrix, STEAM_PACKER_CONSUMER)) {
    return {
      consumer: STEAM_PACKER_CONSUMER,
      enabled: true,
      source: 'legacy-fallback',
      manifestDefault: null,
    };
  }

  const manifestDefault = matrix[STEAM_PACKER_CONSUMER];
  if (manifestDefault !== true) {
    return {
      consumer: STEAM_PACKER_CONSUMER,
      enabled: false,
      source: 'manifest-default',
      manifestDefault,
    };
  }

  return {
    consumer: STEAM_PACKER_CONSUMER,
    enabled: true,
    source: 'manifest-default',
    manifestDefault,
  };
}

export async function detectLegacyToolchainContract(toolchainRoot, platformId) {
  const platform = getPlatformConfig(platformId);
  const legacyEntries = [
    path.join('bin', `opsx${platform.toolchain.primaryShimExtension}`),
    path.join('bin', `openspec${platform.toolchain.primaryShimExtension}`),
    path.join('node', ...platform.toolchain.nodeBinSegments, platform.toolchain.nodeExecutableName),
  ];

  const presentEntries = [];
  for (const relativePath of legacyEntries) {
    if (await pathExists(path.join(toolchainRoot, relativePath))) {
      presentEntries.push(relativePath);
    }
  }

  return {
    legacy: presentEntries.length > 0,
    presentEntries,
  };
}

function buildFallbackCommandMap(platformId) {
  const platform = getPlatformConfig(platformId);
  return {
    node: getNodeExecutableRelativePath(platformId),
    npm: getNpmExecutableRelativePath(platformId),
  };
}

async function validateBundledDesktopToolchainWithoutManifest(toolchainRoot, platformId, manifestPath) {
  const commandMap = buildFallbackCommandMap(platformId);
  const errors = [];

  for (const [commandName, relativePath] of Object.entries(commandMap)) {
    if (!(await pathExists(path.join(toolchainRoot, relativePath)))) {
      errors.push(`Bundled Desktop toolchain is missing ${commandName} at ${relativePath}.`);
    }
  }

  return {
    valid: errors.length === 0,
    legacy: true,
    manifestPresent: false,
    contractMode: 'bundled-content-fallback',
    toolchainRoot,
    manifestPath,
    owner: null,
    source: null,
    platform: platformId,
    activationPolicy: {
      consumer: STEAM_PACKER_CONSUMER,
      enabled: true,
      source: 'bundled-content-fallback',
      manifestDefault: null,
    },
    nodeVersion: null,
    packageVersions: Object.fromEntries(MANAGED_PACKAGES.map((name) => [name, null])),
    errors,
  };
}

export async function validateDesktopToolchainContract({ platformContentRoot, platformId }) {
  const toolchainRoot = resolveDesktopToolchainRoot(platformContentRoot, platformId);
  const manifestPath = path.join(toolchainRoot, 'toolchain-manifest.json');

  if (!(await pathExists(manifestPath))) {
    const legacy = await detectLegacyToolchainContract(toolchainRoot, platformId);
    const fallback = await validateBundledDesktopToolchainWithoutManifest(toolchainRoot, platformId, manifestPath);
    fallback.legacy = legacy.legacy;

    if (!fallback.valid) {
      fallback.contractMode = 'missing-toolchain';
      fallback.errors.unshift(`Desktop-authored toolchain manifest is missing at ${manifestPath}.`);
    }

    return fallback;
  }

  const errors = [];
  const manifest = await readJson(manifestPath);
  if (!isDesktopAuthoredManifest(manifest)) {
    errors.push('toolchain-manifest.json is not marked owner=hagicode-desktop and source=bundled-desktop.');
  }
  if (manifest.platform !== platformId && !(platformId === 'osx-universal' && /^osx-/.test(manifest.platform))) {
    errors.push(`toolchain manifest platform ${manifest.platform ?? 'missing'} does not match ${platformId}.`);
  }
  const activationPolicy = resolveSteamPackerToolchainPolicy(manifest);
  if (!activationPolicy.enabled) {
    errors.push(`toolchain manifest defaultEnabledByConsumer['${STEAM_PACKER_CONSUMER}'] must be true.`);
  }

  for (const commandName of REQUIRED_RUNTIME_COMMANDS) {
    const relativePath = manifest.commands?.[commandName];
    if (!relativePath) {
      errors.push(`manifest commands.${commandName} is missing.`);
      continue;
    }

    if (!(await pathExists(path.join(toolchainRoot, relativePath)))) {
      errors.push(`manifest commands.${commandName} points to missing file ${relativePath}.`);
    }
  }

  for (const packageName of MANAGED_PACKAGES) {
    if (!manifest.packages?.[packageName]?.version) {
      errors.push(`manifest packages.${packageName}.version is missing.`);
    }
  }

  return {
    valid: errors.length === 0,
    legacy: false,
    manifestPresent: true,
    contractMode: 'manifest',
    toolchainRoot,
    manifestPath,
    owner: manifest.owner,
    source: manifest.source,
    platform: manifest.platform,
    activationPolicy,
    nodeVersion: manifest.node?.version ?? null,
    packageVersions: Object.fromEntries(
      MANAGED_PACKAGES.map((name) => [name, manifest.packages?.[name]?.version ?? null])
    ),
    errors,
  };
}
