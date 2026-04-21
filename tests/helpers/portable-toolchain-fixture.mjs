import os from 'node:os';
import path from 'node:path';
import { chmod, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { createArchive as createPortableArchive } from '../../scripts/lib/archive.mjs';
import { runCommand } from '../../scripts/lib/command.mjs';
import { sha256File } from '../../scripts/lib/checksum.mjs';
import { writeJson } from '../../scripts/lib/fs-utils.mjs';

async function createArchive(sourceDirectory, destinationPath) {
  if (destinationPath.endsWith('.zip')) {
    return createPortableArchive(sourceDirectory, destinationPath);
  }

  await runCommand('tar', ['-czf', destinationPath, path.basename(sourceDirectory)], {
    cwd: path.dirname(sourceDirectory)
  });
  return destinationPath;
}

async function createMockNodeDistribution(tempRoot, nodeVersion) {
  const distName = 'node-mock-linux-x64';
  const distRoot = path.join(tempRoot, distName);
  const binRoot = path.join(distRoot, 'bin');
  const nodeWrapperPath = path.join(binRoot, 'node');
  const npmWrapperPath = path.join(binRoot, 'npm');
  const realNodePath = process.execPath;
  const realNpmPath = (await runCommand('which', ['npm'], { stdio: 'pipe' })).stdout.trim();

  await mkdir(binRoot, { recursive: true });
  await writeFile(
    nodeWrapperPath,
    [
      '#!/usr/bin/env bash',
      `exec "${realNodePath}" "$@"`
    ].join('\n'),
    'utf8'
  );
  await writeFile(
    npmWrapperPath,
    [
      '#!/usr/bin/env bash',
      `exec "${realNpmPath}" "$@"`
    ].join('\n'),
    'utf8'
  );
  await chmod(nodeWrapperPath, 0o755);
  await chmod(npmWrapperPath, 0o755);

  const archivePath = path.join(tempRoot, `${distName}.tar.gz`);
  await createArchive(distRoot, archivePath);

  return {
    archivePath,
    archiveName: path.basename(archivePath),
    checksumSha256: await sha256File(archivePath),
    extractRoot: distName,
    version: nodeVersion
  };
}

async function createMockOpenSpecPackage(tempRoot, openSpecVersion) {
  const packageRoot = path.join(tempRoot, 'openspec-package');
  const binRoot = path.join(packageRoot, 'bin');
  await mkdir(binRoot, { recursive: true });

  await writeFile(
    path.join(packageRoot, 'package.json'),
    JSON.stringify(
      {
        name: '@fission-ai/openspec',
        version: openSpecVersion,
        private: true,
        bin: {
          openspec: 'bin/openspec.js'
        }
      },
      null,
      2
    ),
    'utf8'
  );
  await writeFile(
    path.join(binRoot, 'openspec.js'),
    [
      '#!/usr/bin/env node',
      `const version = ${JSON.stringify(openSpecVersion)};`,
      'const args = process.argv.slice(2);',
      "if (args.includes('--version')) {",
      '  console.log(version);',
      '  process.exit(0);',
      '}',
      "if (args[0] === 'status' && args.includes('--help')) {",
      "  console.log('Usage: openspec status [options]');",
      '  process.exit(0);',
      '}',
      "if (args.includes('--help')) {",
      "  console.log('Usage: openspec [options]');",
      '  process.exit(0);',
      '}',
      "console.log('openspec stub');"
    ].join('\n'),
    'utf8'
  );

  const packed = await runCommand('npm', ['pack', '--quiet'], {
    cwd: packageRoot,
    stdio: 'pipe'
  });
  const tgzName = packed.stdout.trim().split('\n').filter(Boolean).at(-1);
  const tgzSourcePath = path.join(packageRoot, tgzName);
  const tgzPath = path.join(tempRoot, tgzName);
  await rename(tgzSourcePath, tgzPath);

  return {
    tgzPath,
    version: openSpecVersion
  };
}

export async function createMockPortableToolchainConfig(tempRoot) {
  const mockRoot = await mkdtemp(path.join(tempRoot, `portable-toolchain-${os.platform()}-`));
  const nodeVersion = process.version.replace(/^v/, '');
  const openSpecVersion = '9.9.9-test.1';
  const nodeDist = await createMockNodeDistribution(mockRoot, nodeVersion);
  const openSpecPackage = await createMockOpenSpecPackage(mockRoot, openSpecVersion);
  const configPath = path.join(mockRoot, 'portable-toolchain.json');

  await writeJson(configPath, {
    manifestVersion: 1,
    node: {
      version: nodeVersion,
      distBaseUrl: 'file://mock',
      platforms: {
        'linux-x64': {
          archiveName: nodeDist.archiveName,
          archiveType: 'tar.gz',
          downloadUrl: `file://${nodeDist.archivePath}`,
          extractRoot: nodeDist.extractRoot,
          checksumSha256: nodeDist.checksumSha256
        }
      }
    },
    openspec: {
      packageName: '@fission-ai/openspec',
      version: openSpecPackage.version,
      packageSource: openSpecPackage.tgzPath,
      binName: 'openspec',
      aliases: ['opsx']
    }
  });

  return {
    configPath,
    nodeVersion,
    openSpecVersion
  };
}
