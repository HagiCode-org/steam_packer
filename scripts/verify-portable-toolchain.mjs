#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readJson, writeJson } from './lib/fs-utils.mjs';
import { annotateError, appendSummary } from './lib/summary.mjs';
import { validateDesktopToolchainContract } from './lib/desktop-toolchain-contract.mjs';

async function main() {
  const { values } = parseArgs({
    options: {
      platform: { type: 'string' },
      workspace: { type: 'string' }
    }
  });

  if (!values.platform || !values.workspace) {
    throw new Error('verify-portable-toolchain requires --platform and --workspace.');
  }

  const workspacePath = path.resolve(values.workspace);
  const workspaceManifest = await readJson(path.join(workspacePath, 'workspace-manifest.json'));
  const reportPath = path.join(workspacePath, `toolchain-validation-${values.platform}.json`);
  const validation = await validateDesktopToolchainContract({
    platformContentRoot: workspaceManifest.desktopAppRoot,
    platformId: values.platform
  });

  const report = {
    platform: values.platform,
    validationPassed: validation.valid,
    ownership: 'desktop-authored',
    toolchainRoot: validation.toolchainRoot,
    toolchainManifestPath: validation.manifestPath,
    owner: validation.owner ?? null,
    source: validation.source ?? null,
    activationPolicy: validation.activationPolicy ?? null,
    bundledToolchainEnabled: validation.activationPolicy?.enabled ?? false,
    nodeVersion: validation.nodeVersion ?? null,
    packageVersions: validation.packageVersions ?? {},
    legacyDetected: validation.legacy,
    failureSummary: validation.valid ? null : validation.errors.join('; '),
    errors: validation.errors
  };

  await writeJson(reportPath, report);

  if (!validation.valid) {
    throw new Error(report.failureSummary);
  }

  await appendSummary([
    `### Desktop toolchain contract verified for ${values.platform}`,
    `- Report: ${reportPath}`,
    `- Toolchain root: ${validation.toolchainRoot}`,
    `- Activation: enabled=${validation.activationPolicy?.enabled ?? false} source=${validation.activationPolicy?.source ?? 'unknown'}`,
    `- Node: ${validation.nodeVersion ?? 'unknown'}`,
    `- Packages: ${Object.entries(validation.packageVersions ?? {}).map(([name, version]) => `${name}@${version}`).join(', ')}`
  ]);

  console.log(JSON.stringify({ reportPath, validationPassed: true }, null, 2));
}

main().catch(async (error) => {
  annotateError(error.message);
  await appendSummary([
    '## Desktop toolchain contract verification failed',
    `- ${error.message}`
  ]);
  console.error(error);
  process.exitCode = 1;
});
