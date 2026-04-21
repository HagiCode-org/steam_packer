#!/usr/bin/env node
import path from 'node:path';
import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runCommand } from './lib/command.mjs';
import { cleanDir, ensureDir, pathExists, writeJson } from './lib/fs-utils.mjs';
import { appendSummary, annotateError } from './lib/summary.mjs';
import { loadPortableVersionHandoff } from './lib/portable-version-handoff.mjs';
import { publishRelease } from './publish-release.mjs';

function createStageError(stage, message, cause, releaseTag) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.stage = stage;
  error.releaseTag = releaseTag;
  return error;
}

async function copyIfPresent(sourcePath, destinationPath) {
  if (!(await pathExists(sourcePath))) {
    return false;
  }

  await ensureDir(path.dirname(destinationPath));
  await cp(sourcePath, destinationPath, { force: true, recursive: true });
  return true;
}

async function stagePlatformArtifacts(platformRoot, publishInputRoot, platformId) {
  await copyIfPresent(
    path.join(platformRoot, `artifact-inventory-${platformId}.json`),
    path.join(publishInputRoot, `artifact-inventory-${platformId}.json`)
  );
  await copyIfPresent(
    path.join(platformRoot, `artifact-checksums-${platformId}.txt`),
    path.join(publishInputRoot, `artifact-checksums-${platformId}.txt`)
  );
  await copyIfPresent(
    path.join(platformRoot, `payload-validation-${platformId}.json`),
    path.join(publishInputRoot, `payload-validation-${platformId}.json`)
  );
  await copyIfPresent(
    path.join(platformRoot, `toolchain-validation-${platformId}.json`),
    path.join(publishInputRoot, `toolchain-validation-${platformId}.json`)
  );
  await copyIfPresent(
    path.join(platformRoot, 'release-assets'),
    path.join(publishInputRoot, 'release-assets')
  );
}

async function runNodeScript(scriptName, args) {
  await runCommand(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), scriptName), ...args]);
}

export async function executePortableVersionHandoff({
  planPath,
  runRoot = path.join('build', 'portable-version-handoff'),
  desktopAssetSource,
  serviceAssetSource,
  serviceAssetSourceMap,
  toolchainConfig,
  forceDryRun = false,
  steamAzureSasUrl,
  linuxDepotId,
  windowsDepotId,
  macosDepotId,
  fetchImpl = fetch
} = {}) {
  let handoff;
  try {
    handoff = await loadPortableVersionHandoff(planPath);
  } catch (error) {
    throw createStageError('build-plan-validation', error.message, error);
  }

  const workspaceRoot = path.resolve(runRoot);
  const packageRoot = path.join(workspaceRoot, 'package-workspaces');
  const publishInputRoot = path.join(workspaceRoot, 'publish-input');
  const metadataRoot = path.join(workspaceRoot, 'release-metadata');

  await cleanDir(packageRoot);
  await cleanDir(publishInputRoot);
  await cleanDir(metadataRoot);

  try {
    for (const platformId of handoff.platforms) {
      const platformRoot = path.join(packageRoot, platformId);
      const sharedArgs = ['--plan', path.resolve(planPath), '--platform', platformId, '--workspace', platformRoot];

      const prepareArgs = [...sharedArgs];
      if (desktopAssetSource) {
        prepareArgs.push('--desktop-asset-source', desktopAssetSource);
      }
      await runNodeScript('prepare-packaging-workspace.mjs', prepareArgs);

      const stagePayloadArgs = [...sharedArgs];
      if (serviceAssetSource) {
        stagePayloadArgs.push('--service-asset-source', serviceAssetSource);
      }
      if (serviceAssetSourceMap) {
        stagePayloadArgs.push('--service-asset-source-map', serviceAssetSourceMap);
      }
      await runNodeScript('stage-portable-payload.mjs', stagePayloadArgs);

      const stageToolchainArgs = [...sharedArgs];
      if (toolchainConfig) {
        stageToolchainArgs.push('--toolchain-config', toolchainConfig);
      }
      await runNodeScript('stage-portable-toolchain.mjs', stageToolchainArgs);

      const verifyArgs = ['--platform', platformId, '--workspace', platformRoot];
      if (toolchainConfig) {
        verifyArgs.push('--toolchain-config', toolchainConfig);
      }
      await runNodeScript('verify-portable-toolchain.mjs', verifyArgs);

      const packageArgs = [...sharedArgs];
      if (forceDryRun) {
        packageArgs.push('--force-dry-run');
      }
      await runNodeScript('package-desktop-portable.mjs', packageArgs);

      await stagePlatformArtifacts(platformRoot, publishInputRoot, platformId);
    }
  } catch (error) {
    throw createStageError('delegated-packaging', error.message, error, handoff.releaseTag);
  }

  try {
    const publicationResult = await publishRelease({
      planPath: path.resolve(planPath),
      artifactsDir: publishInputRoot,
      outputDir: metadataRoot,
      forceDryRun,
      steamAzureSasUrl,
      linuxDepotId,
      windowsDepotId,
      macosDepotId,
      fetchImpl
    });

    const result = {
      status: handoff.dryRun || forceDryRun ? 'dry-run' : 'published',
      stage: 'complete',
      releaseTag: handoff.releaseTag,
      platforms: handoff.platforms,
      runRoot: workspaceRoot,
      metadataRoot,
      publicationResult
    };

    await writeJson(path.join(metadataRoot, 'delegated-release-result.json'), result);
    return result;
  } catch (error) {
    throw createStageError('azure-publication', error.message, error, handoff.releaseTag);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      'run-root': { type: 'string' },
      'desktop-asset-source': { type: 'string' },
      'service-asset-source': { type: 'string' },
      'service-asset-source-map': { type: 'string' },
      'toolchain-config': { type: 'string' },
      'force-dry-run': { type: 'boolean', default: false },
      'steam-azure-sas-url': { type: 'string' },
      'linux-depot-id': { type: 'string' },
      'windows-depot-id': { type: 'string' },
      'macos-depot-id': { type: 'string' }
    },
    strict: true
  });

  if (!values.plan) {
    throw new Error('run-portable-version-handoff requires --plan.');
  }

  try {
    const result = await executePortableVersionHandoff({
      planPath: values.plan,
      runRoot: values['run-root'],
      desktopAssetSource: values['desktop-asset-source'],
      serviceAssetSource: values['service-asset-source'],
      serviceAssetSourceMap: values['service-asset-source-map'],
      toolchainConfig: values['toolchain-config'],
      forceDryRun: values['force-dry-run'],
      steamAzureSasUrl: values['steam-azure-sas-url'],
      linuxDepotId: values['linux-depot-id'],
      windowsDepotId: values['windows-depot-id'],
      macosDepotId: values['macos-depot-id']
    });

    await appendSummary([
      '## Portable Version delegated execution complete',
      `- Release tag: ${result.releaseTag}`,
      `- Mode: ${result.status}`,
      `- Run root: ${result.runRoot}`,
      `- Metadata root: ${result.metadataRoot}`
    ]);

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const stage = error.stage ?? 'build-plan-validation';
    const releaseTag = error.releaseTag ?? null;
    const runRoot = path.resolve(values['run-root'] ?? path.join('build', 'portable-version-handoff'));
    const metadataRoot = path.join(runRoot, 'release-metadata');
    await ensureDir(metadataRoot);
    const resultPath = path.join(metadataRoot, 'delegated-release-result.json');
    await writeJson(resultPath, {
      status: 'failed',
      stage,
      releaseTag,
      error: error.message
    });

    annotateError(error.message);
    await appendSummary([
      '## Portable Version delegated execution failed',
      `- Stage: ${stage}`,
      `- Release tag: ${releaseTag ?? '[unresolved]'}`,
      `- Result: ${resultPath}`,
      `- ${error.message}`
    ]);

    console.error(error);
    process.exitCode =
      stage === 'build-plan-validation' ? 10 : stage === 'delegated-packaging' ? 20 : 30;
  }
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main();
}
