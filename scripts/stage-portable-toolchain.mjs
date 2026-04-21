#!/usr/bin/env node
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { extractArchive } from './lib/archive.mjs';
import { sha256File } from './lib/checksum.mjs';
import { downloadReleaseAsset } from './lib/github.mjs';
import { runCommand } from './lib/command.mjs';
import {
  cleanDir,
  copyDir,
  ensureDir,
  pathExists,
  readJson,
  writeJson
} from './lib/fs-utils.mjs';
import { annotateError, appendSummary } from './lib/summary.mjs';
import {
  buildOpenSpecInstallSpec,
  buildPortablePath,
  createActivationArtifacts,
  createToolchainShimArtifacts,
  ensureExecutableIfNeeded,
  getNodeExecutableRelativePath,
  getNpmExecutableRelativePath,
  getOpenSpecPackageRootRelativePath,
  readPortableToolchainConfig,
  resolveOpenSpecBinEntry,
  resolvePortableToolchainPlatform,
  resolveToolchainRoots
} from './lib/toolchain.mjs';

async function validateChecksum(filePath, expectedChecksum) {
  if (!expectedChecksum) {
    return null;
  }

  const actualChecksum = await sha256File(filePath);
  if (actualChecksum !== expectedChecksum) {
    throw new Error(
      `Portable toolchain checksum mismatch for ${filePath}. Expected ${expectedChecksum}, got ${actualChecksum}.`
    );
  }

  return actualChecksum;
}

async function resolveExtractedNodeRoot(extractionRoot, platformNodeConfig) {
  const configuredRoot = path.join(extractionRoot, platformNodeConfig.extractRoot);
  if (await pathExists(configuredRoot)) {
    return configuredRoot;
  }

  throw new Error(
    `Portable toolchain extraction did not produce ${platformNodeConfig.extractRoot} under ${extractionRoot}.`
  );
}

async function installOpenSpecCli({
  workspacePath,
  toolchainRoots,
  toolchainConfig,
  platformId
}) {
  await cleanDir(toolchainRoots.toolchainNpmGlobalRoot);
  const nodeExecutablePath = path.join(toolchainRoots.toolchainRoot, getNodeExecutableRelativePath(platformId));
  const npmExecutablePath = path.join(toolchainRoots.toolchainRoot, getNpmExecutableRelativePath(platformId));
  const installSpec = buildOpenSpecInstallSpec(toolchainConfig);
  const env = {
    ...process.env,
    PATH: buildPortablePath(toolchainRoots.toolchainRoot, platformId, process.env.PATH),
    npm_config_cache: path.join(workspacePath, 'npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false'
  };

  await ensureDir(env.npm_config_cache);

  if (!(await pathExists(nodeExecutablePath))) {
    throw new Error(`Portable Node executable is missing at ${nodeExecutablePath}.`);
  }
  if (!(await pathExists(npmExecutablePath))) {
    throw new Error(`Portable npm executable is missing at ${npmExecutablePath}.`);
  }

  await runCommand(
    npmExecutablePath,
    [
      'install',
      '-g',
      '--prefix',
      toolchainRoots.toolchainNpmGlobalRoot,
      '--loglevel=error',
      installSpec
    ],
    {
      cwd: workspacePath,
      env
    }
  );

  return {
    installSpec,
    nodeExecutablePath,
    npmExecutablePath
  };
}

async function stageShimsAndActivation({
  toolchainRoots,
  platformId,
  cliScriptRelativePath,
  aliases
}) {
  await ensureDir(toolchainRoots.toolchainBinRoot);
  await ensureDir(toolchainRoots.toolchainEnvRoot);

  const commandArtifacts = [];
  for (const commandName of ['openspec', ...aliases]) {
    const shimArtifacts = createToolchainShimArtifacts({
      platformId,
      cliScriptRelativePath,
      commandName
    });
    commandArtifacts.push(...shimArtifacts.map((artifact) => path.join('bin', artifact.fileName)));
    for (const artifact of shimArtifacts) {
      const targetPath = path.join(toolchainRoots.toolchainBinRoot, artifact.fileName);
      await writeFile(targetPath, `${artifact.content}\n`, 'utf8');
      await ensureExecutableIfNeeded(targetPath, artifact.executable);
    }
  }

  const activationArtifacts = createActivationArtifacts(platformId);
  const activationPaths = [];
  for (const artifact of activationArtifacts) {
    const targetPath = path.join(toolchainRoots.toolchainEnvRoot, artifact.fileName);
    activationPaths.push(path.join('env', artifact.fileName));
    await writeFile(targetPath, `${artifact.content}\n`, 'utf8');
    await ensureExecutableIfNeeded(targetPath, artifact.executable);
  }

  return {
    commandArtifacts,
    activationPaths
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      platform: { type: 'string' },
      workspace: { type: 'string' },
      token: { type: 'string' },
      'toolchain-config': { type: 'string' }
    }
  });

  if (!values.plan || !values.platform || !values.workspace) {
    throw new Error('stage-portable-toolchain requires --plan, --platform, and --workspace.');
  }

  const workspacePath = path.resolve(values.workspace);
  const workspaceManifest = await readJson(path.join(workspacePath, 'workspace-manifest.json'));
  const toolchainConfig = await readPortableToolchainConfig(values['toolchain-config']);
  const platformNodeConfig = resolvePortableToolchainPlatform(toolchainConfig, values.platform);
  const token =
    values.token ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN;
  const toolchainRoots = resolveToolchainRoots(workspaceManifest.portableFixedRoot);
  const nodeArchivePath = path.join(workspaceManifest.downloadDirectory, platformNodeConfig.archiveName);
  const nodeExtractionRoot = path.join(workspaceManifest.extractDirectory, `${values.platform}-node-runtime`);

  await ensureDir(workspaceManifest.downloadDirectory);
  await ensureDir(workspaceManifest.extractDirectory);
  await ensureDir(toolchainRoots.toolchainRoot);
  await cleanDir(toolchainRoots.toolchainNodeRoot);
  await cleanDir(toolchainRoots.toolchainBinRoot);
  await cleanDir(toolchainRoots.toolchainEnvRoot);

  await downloadReleaseAsset(
    {
      name: platformNodeConfig.archiveName,
      downloadUrl: platformNodeConfig.downloadUrl
    },
    nodeArchivePath,
    token
  );
  const checksumSha256 = await validateChecksum(nodeArchivePath, platformNodeConfig.checksumSha256);

  await cleanDir(nodeExtractionRoot);
  await extractArchive(nodeArchivePath, nodeExtractionRoot);
  const extractedNodeRoot = await resolveExtractedNodeRoot(nodeExtractionRoot, platformNodeConfig);
  await copyDir(extractedNodeRoot, toolchainRoots.toolchainNodeRoot);

  const installResult = await installOpenSpecCli({
    workspacePath,
    toolchainRoots,
    toolchainConfig,
    platformId: values.platform
  });

  const packageRootPath = path.join(
    toolchainRoots.toolchainRoot,
    getOpenSpecPackageRootRelativePath(values.platform, toolchainConfig.openspec.packageName)
  );
  const installedPackageJson = await readJson(path.join(packageRootPath, 'package.json'));
  if (installedPackageJson.version !== toolchainConfig.openspec.version) {
    throw new Error(
      `Portable OpenSpec version mismatch. Expected ${toolchainConfig.openspec.version}, got ${installedPackageJson.version}.`
    );
  }

  const binEntry = resolveOpenSpecBinEntry(installedPackageJson, toolchainConfig.openspec.binName);
  const cliScriptPath = path.join(packageRootPath, binEntry);
  if (!(await pathExists(cliScriptPath))) {
    throw new Error(`Portable OpenSpec CLI entry is missing at ${cliScriptPath}.`);
  }

  const cliScriptRelativePath = path.relative(toolchainRoots.toolchainRoot, cliScriptPath);
  const commandArtifacts = await stageShimsAndActivation({
    toolchainRoots,
    platformId: values.platform,
    cliScriptRelativePath,
    aliases: toolchainConfig.openspec.aliases ?? []
  });

  const manifest = {
    schemaVersion: 1,
    platform: values.platform,
    portableFixedRoot: workspaceManifest.portableFixedRoot,
    toolchainRoot: toolchainRoots.toolchainRoot,
    stagedAt: new Date().toISOString(),
    node: {
      version: toolchainConfig.node.version,
      downloadUrl: platformNodeConfig.downloadUrl,
      archiveName: platformNodeConfig.archiveName,
      archiveType: platformNodeConfig.archiveType,
      checksumSha256: checksumSha256 ?? platformNodeConfig.checksumSha256,
      extractRoot: platformNodeConfig.extractRoot,
      executableRelativePath: getNodeExecutableRelativePath(values.platform)
    },
    openspec: {
      packageName: toolchainConfig.openspec.packageName,
      version: toolchainConfig.openspec.version,
      installSpec: installResult.installSpec,
      packageRootRelativePath: getOpenSpecPackageRootRelativePath(
        values.platform,
        toolchainConfig.openspec.packageName
      ),
      cliScriptRelativePath
    },
    commands: {
      node: getNodeExecutableRelativePath(values.platform),
      openspec: commandArtifacts.commandArtifacts.find((item) => item.includes('openspec')),
      opsx: commandArtifacts.commandArtifacts.find((item) => item.includes('opsx'))
    },
    activation: commandArtifacts.activationPaths
  };
  await writeJson(toolchainRoots.toolchainManifestPath, manifest);

  await appendSummary([
    `### Portable toolchain staged for ${values.platform}`,
    `- Node: ${toolchainConfig.node.version}`,
    `- OpenSpec: ${toolchainConfig.openspec.packageName}@${toolchainConfig.openspec.version}`,
    `- Toolchain root: ${toolchainRoots.toolchainRoot}`,
    `- Manifest: ${toolchainRoots.toolchainManifestPath}`
  ]);

  console.log(
    JSON.stringify(
      {
        toolchainManifestPath: toolchainRoots.toolchainManifestPath,
        toolchainRoot: toolchainRoots.toolchainRoot
      },
      null,
      2
    )
  );
}

main().catch(async (error) => {
  annotateError(error.message);
  await appendSummary([
    '## Portable toolchain staging failed',
    `- ${error.message}`
  ]);
  console.error(error);
  process.exitCode = 1;
});
