import path from 'node:path';
import { chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readJson } from './fs-utils.mjs';
import { getPlatformConfig, getRequestedAssetPlatforms } from './platforms.mjs';

const DEFAULT_CONFIG_URL = new URL('../../config/portable-toolchain.json', import.meta.url);

export const DEFAULT_TOOLCHAIN_CONFIG_PATH = fileURLToPath(DEFAULT_CONFIG_URL);

export async function readPortableToolchainConfig(configPath = DEFAULT_TOOLCHAIN_CONFIG_PATH) {
  return readJson(path.resolve(configPath));
}

export function resolvePortableToolchainPlatform(config, platformId) {
  const entry = config?.node?.platforms?.[platformId];
  if (!entry) {
    const [fallbackPlatformId] = getRequestedAssetPlatforms(platformId, 'desktop');
    if (fallbackPlatformId && fallbackPlatformId !== platformId) {
      const fallbackEntry = config?.node?.platforms?.[fallbackPlatformId];
      if (fallbackEntry) {
        return fallbackEntry;
      }
    }

    throw new Error(`Portable toolchain config is missing platform entry: ${platformId}`);
  }
  return entry;
}

export function resolveToolchainRoots(portableFixedRoot) {
  const toolchainRoot = path.join(portableFixedRoot, 'toolchain');
  return {
    toolchainRoot,
    toolchainBinRoot: path.join(toolchainRoot, 'bin'),
    toolchainEnvRoot: path.join(toolchainRoot, 'env'),
    toolchainNodeRoot: path.join(toolchainRoot, 'node'),
    toolchainNpmGlobalRoot: path.join(toolchainRoot, 'npm-global'),
    toolchainManifestPath: path.join(toolchainRoot, 'toolchain-manifest.json')
  };
}

export function getNodeBinRelativePath(platformId) {
  const platform = getPlatformConfig(platformId);
  return path.join('node', ...platform.toolchain.nodeBinSegments);
}

export function getNodeExecutableRelativePath(platformId) {
  const platform = getPlatformConfig(platformId);
  return path.join(getNodeBinRelativePath(platformId), platform.toolchain.nodeExecutableName);
}

export function getNpmExecutableRelativePath(platformId) {
  const platform = getPlatformConfig(platformId);
  return path.join(getNodeBinRelativePath(platformId), platform.toolchain.npmExecutableName);
}

export function getNpmGlobalBinRelativePath(platformId) {
  const platform = getPlatformConfig(platformId);
  return path.join('npm-global', ...platform.toolchain.npmGlobalBinSegments);
}

export function getNpmGlobalModulesRelativePath(platformId) {
  const platform = getPlatformConfig(platformId);
  return path.join('npm-global', ...platform.toolchain.npmGlobalModulesSegments);
}

export function getPortablePathEntryRelativePaths(platformId) {
  return Array.from(
    new Set([
      'bin',
      getNodeBinRelativePath(platformId),
      getNpmGlobalBinRelativePath(platformId)
    ])
  );
}

export function buildPortablePath(toolchainRoot, platformId, currentPath = process.env.PATH ?? '') {
  const pathEntries = getPortablePathEntryRelativePaths(platformId).map((relativePath) =>
    path.join(toolchainRoot, relativePath)
  );
  return [...pathEntries, currentPath].filter(Boolean).join(path.delimiter);
}

export function buildOpenSpecInstallSpec(toolchainConfig) {
  if (toolchainConfig?.openspec?.packageSource) {
    return toolchainConfig.openspec.packageSource;
  }

  return `${toolchainConfig.openspec.packageName}@${toolchainConfig.openspec.version}`;
}

export function getScopedPackageSegments(packageName) {
  return String(packageName)
    .split('/')
    .filter(Boolean);
}

export function getOpenSpecPackageRootRelativePath(platformId, packageName) {
  return path.join(
    getNpmGlobalModulesRelativePath(platformId),
    ...getScopedPackageSegments(packageName)
  );
}

export function resolveOpenSpecBinEntry(packageJson, binName) {
  if (typeof packageJson.bin === 'string') {
    return packageJson.bin;
  }

  if (packageJson.bin?.[binName]) {
    return packageJson.bin[binName];
  }

  throw new Error(`Unable to resolve bin entry "${binName}" from package metadata.`);
}

function toPosixPath(relativePath) {
  return String(relativePath).split(path.sep).join('/');
}

function toWindowsPath(relativePath) {
  return String(relativePath).split('/').join('\\');
}

function createPosixShimContent({ commandName, cliScriptRelativePath, nodeExecutableRelativePath, platformId }) {
  const pathEntries = getPortablePathEntryRelativePaths(platformId).map(toPosixPath).join(':$TOOLCHAIN_ROOT/');
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'SCRIPT_DIR="$(CDPATH=\'\' cd -- "$(dirname -- "$0")" && pwd)"',
    'TOOLCHAIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"',
    `NODE_EXEC="$TOOLCHAIN_ROOT/${toPosixPath(nodeExecutableRelativePath)}"`,
    `CLI_ENTRY="$TOOLCHAIN_ROOT/${toPosixPath(cliScriptRelativePath)}"`,
    `PATH="$TOOLCHAIN_ROOT/${pathEntries}:$PATH"`,
    'export PATH',
    'exec "$NODE_EXEC" "$CLI_ENTRY" "$@"'
  ].join('\n');
}

function createWindowsCmdShimContent({ cliScriptRelativePath, nodeExecutableRelativePath }) {
  return [
    '@echo off',
    'setlocal',
    'set "SCRIPT_DIR=%~dp0"',
    'for %%I in ("%SCRIPT_DIR%..") do set "TOOLCHAIN_ROOT=%%~fI"',
    'set "PATH=%TOOLCHAIN_ROOT%\\bin;%TOOLCHAIN_ROOT%\\node;%TOOLCHAIN_ROOT%\\npm-global;%PATH%"',
    `set "NODE_EXEC=%TOOLCHAIN_ROOT%\\${toWindowsPath(nodeExecutableRelativePath)}"`,
    `set "CLI_ENTRY=%TOOLCHAIN_ROOT%\\${toWindowsPath(cliScriptRelativePath)}"`,
    '"%NODE_EXEC%" "%CLI_ENTRY%" %*',
    'exit /b %ERRORLEVEL%'
  ].join('\r\n');
}

function createWindowsPowerShellShimContent({ cliScriptRelativePath, nodeExecutableRelativePath }) {
  return [
    '$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '$toolchainRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path',
    '$env:PATH = "$toolchainRoot\\bin;$toolchainRoot\\node;$toolchainRoot\\npm-global;" + $env:PATH',
    `$nodeExec = Join-Path $toolchainRoot "${toWindowsPath(nodeExecutableRelativePath)}"`,
    `$cliEntry = Join-Path $toolchainRoot "${toWindowsPath(cliScriptRelativePath)}"`,
    '& $nodeExec $cliEntry @args',
    'exit $LASTEXITCODE'
  ].join('\r\n');
}

export function createToolchainShimArtifacts({ platformId, cliScriptRelativePath, commandName }) {
  const platform = getPlatformConfig(platformId);
  const nodeExecutableRelativePath = getNodeExecutableRelativePath(platformId);

  if (platform.toolchain.shell === 'posix') {
    return [
      {
        fileName: commandName,
        content: createPosixShimContent({
          commandName,
          cliScriptRelativePath,
          nodeExecutableRelativePath,
          platformId
        }),
        executable: true
      }
    ];
  }

  return [
    {
      fileName: `${commandName}.cmd`,
      content: createWindowsCmdShimContent({
        cliScriptRelativePath,
        nodeExecutableRelativePath
      }),
      executable: false
    },
    {
      fileName: `${commandName}.ps1`,
      content: createWindowsPowerShellShimContent({
        cliScriptRelativePath,
        nodeExecutableRelativePath
      }),
      executable: false
    }
  ];
}

export function createActivationArtifacts(platformId) {
  const platform = getPlatformConfig(platformId);
  const pathEntries = getPortablePathEntryRelativePaths(platformId);

  if (platform.toolchain.shell === 'posix') {
    const exportPath = pathEntries.map((entry) => `$TOOLCHAIN_ROOT/${toPosixPath(entry)}`).join(':');
    return [
      {
        fileName: 'activate.sh',
        content: [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          'SCRIPT_DIR="$(CDPATH=\'\' cd -- "$(dirname -- "$0")" && pwd)"',
          'TOOLCHAIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"',
          'export PORTABLE_TOOLCHAIN_ROOT="$TOOLCHAIN_ROOT"',
          `export PATH="${exportPath}:$PATH"`,
          'echo "Portable toolchain activated: $TOOLCHAIN_ROOT"'
        ].join('\n'),
        executable: true
      }
    ];
  }

  return [
    {
      fileName: 'activate.cmd',
      content: [
        '@echo off',
        'setlocal',
        'set "SCRIPT_DIR=%~dp0"',
        'for %%I in ("%SCRIPT_DIR%..") do set "TOOLCHAIN_ROOT=%%~fI"',
        'set "PORTABLE_TOOLCHAIN_ROOT=%TOOLCHAIN_ROOT%"',
        'set "PATH=%TOOLCHAIN_ROOT%\\bin;%TOOLCHAIN_ROOT%\\node;%TOOLCHAIN_ROOT%\\npm-global;%PATH%"',
        'echo Portable toolchain activated: %TOOLCHAIN_ROOT%'
      ].join('\r\n'),
      executable: false
    },
    {
      fileName: 'activate.ps1',
      content: [
        '$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path',
        '$toolchainRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path',
        '$env:PORTABLE_TOOLCHAIN_ROOT = $toolchainRoot',
        '$env:PATH = "$toolchainRoot\\bin;$toolchainRoot\\node;$toolchainRoot\\npm-global;" + $env:PATH',
        'Write-Output "Portable toolchain activated: $toolchainRoot"'
      ].join('\r\n'),
      executable: false
    }
  ];
}

export async function ensureExecutableIfNeeded(filePath, executable) {
  if (executable && process.platform !== 'win32') {
    await chmod(filePath, 0o755);
  }
}
