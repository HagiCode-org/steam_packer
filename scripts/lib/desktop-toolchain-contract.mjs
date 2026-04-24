import path from 'node:path';
import { pathExists, readJson } from './fs-utils.mjs';
import { getPlatformConfig } from './platforms.mjs';

const REQUIRED_COMMANDS = ['node', 'npm', 'openspec', 'skills', 'omniroute'];
const REQUIRED_PACKAGES = ['openspec', 'skills', 'omniroute'];
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

export async function validateDesktopToolchainContract({ platformContentRoot, platformId }) {
  const toolchainRoot = resolveDesktopToolchainRoot(platformContentRoot, platformId);
  const manifestPath = path.join(toolchainRoot, 'toolchain-manifest.json');
  const errors = [];

  if (!(await pathExists(manifestPath))) {
    const legacy = await detectLegacyToolchainContract(toolchainRoot, platformId);
    return {
      valid: false,
      legacy: legacy.legacy,
      toolchainRoot,
      manifestPath,
      errors: [
        `Desktop-authored toolchain manifest is missing at ${manifestPath}.`,
        ...(legacy.legacy ? [`Legacy toolchain entries detected: ${legacy.presentEntries.join(', ')}`] : []),
      ],
    };
  }

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

  for (const commandName of REQUIRED_COMMANDS) {
    const relativePath = manifest.commands?.[commandName];
    if (!relativePath) {
      errors.push(`manifest commands.${commandName} is missing.`);
      continue;
    }

    if (!(await pathExists(path.join(toolchainRoot, relativePath)))) {
      errors.push(`manifest commands.${commandName} points to missing file ${relativePath}.`);
    }
  }

  for (const packageName of REQUIRED_PACKAGES) {
    if (!manifest.packages?.[packageName]?.version) {
      errors.push(`manifest packages.${packageName}.version is missing.`);
    }
  }

  return {
    valid: errors.length === 0,
    legacy: false,
    toolchainRoot,
    manifestPath,
    owner: manifest.owner,
    source: manifest.source,
    platform: manifest.platform,
    activationPolicy,
    nodeVersion: manifest.node?.version ?? null,
    packageVersions: Object.fromEntries(
      REQUIRED_PACKAGES.map((name) => [name, manifest.packages?.[name]?.version ?? null])
    ),
    errors,
  };
}
