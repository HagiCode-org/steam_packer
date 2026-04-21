#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readJson, writeJson } from './lib/fs-utils.mjs';
import { annotateError, appendSummary } from './lib/summary.mjs';
import {
  buildPortablePath,
  readPortableToolchainConfig,
  resolveToolchainRoots
} from './lib/toolchain.mjs';
import { runCommandResult } from './lib/command.mjs';

function shellEscapeWindows(value) {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }

  return `"${String(value).replace(/"/g, '\\"')}"`;
}

async function runPortableCommand(command, args, env) {
  if (process.platform === 'win32') {
    const expression = [command, ...args].map(shellEscapeWindows).join(' ');
    return runCommandResult('cmd.exe', ['/d', '/s', '/c', expression], {
      env
    });
  }

  return runCommandResult(command, args, {
    env
  });
}

function normalizeNodeVersion(version) {
  return version.startsWith('v') ? version : `v${version}`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      platform: { type: 'string' },
      workspace: { type: 'string' },
      'toolchain-config': { type: 'string' }
    }
  });

  if (!values.platform || !values.workspace) {
    throw new Error('verify-portable-toolchain requires --platform and --workspace.');
  }

  const workspacePath = path.resolve(values.workspace);
  const workspaceManifest = await readJson(path.join(workspacePath, 'workspace-manifest.json'));
  const toolchainConfig = await readPortableToolchainConfig(values['toolchain-config']);
  const toolchainRoots = resolveToolchainRoots(workspaceManifest.portableFixedRoot);
  const toolchainManifest = await readJson(toolchainRoots.toolchainManifestPath);
  const reportPath = path.join(workspacePath, `toolchain-validation-${values.platform}.json`);
  const env = {
    ...process.env,
    PATH: buildPortablePath(toolchainRoots.toolchainRoot, values.platform, process.env.PATH)
  };

  const checks = [
    {
      name: 'node',
      args: ['--version'],
      expected: normalizeNodeVersion(toolchainConfig.node.version),
      matcher: (stdout, expected) => stdout.trim() === expected
    },
    {
      name: 'openspec',
      args: ['--version'],
      expected: toolchainConfig.openspec.version,
      matcher: (stdout, expected) => stdout.trim() === expected
    },
    {
      name: 'opsx',
      args: ['status', '--help'],
      expected: 'Usage: openspec status',
      matcher: (stdout, expected) => stdout.includes(expected)
    }
  ];

  const results = [];
  let validationPassed = true;
  let failureSummary = null;

  try {
    if (toolchainManifest.node.version !== toolchainConfig.node.version) {
      throw new Error(
        `Toolchain manifest Node version drifted. Expected ${toolchainConfig.node.version}, got ${toolchainManifest.node.version}.`
      );
    }
    if (toolchainManifest.openspec.version !== toolchainConfig.openspec.version) {
      throw new Error(
        `Toolchain manifest OpenSpec version drifted. Expected ${toolchainConfig.openspec.version}, got ${toolchainManifest.openspec.version}.`
      );
    }

    for (const check of checks) {
      const result = await runPortableCommand(check.name, check.args, env);
      const stdout = result.stdout.trim();
      const stderr = result.stderr.trim();
      const passed = result.code === 0 && check.matcher(stdout, check.expected);

      results.push({
        command: check.name,
        args: check.args,
        exitCode: result.code,
        stdout,
        stderr,
        expected: check.expected,
        passed
      });

      if (!passed) {
        throw new Error(
          `Portable toolchain command validation failed for ${check.name} ${check.args.join(' ')}.`
        );
      }
    }
  } catch (error) {
    validationPassed = false;
    failureSummary = error.message;
  }

  await writeJson(reportPath, {
    platform: values.platform,
    validationPassed,
    toolchainManifestPath: toolchainRoots.toolchainManifestPath,
    nodeVersion: toolchainManifest.node.version,
    openspecVersion: toolchainManifest.openspec.version,
    shimPaths: toolchainManifest.commands,
    results,
    failureSummary
  });

  if (!validationPassed) {
    throw new Error(failureSummary);
  }

  await appendSummary([
    `### Portable toolchain verified for ${values.platform}`,
    `- Report: ${reportPath}`,
    `- Node: ${toolchainManifest.node.version}`,
    `- OpenSpec: ${toolchainManifest.openspec.version}`
  ]);

  console.log(JSON.stringify({ reportPath, validationPassed }, null, 2));
}

main().catch(async (error) => {
  annotateError(error.message);
  await appendSummary([
    '## Portable toolchain verification failed',
    `- ${error.message}`
  ]);
  console.error(error);
  process.exitCode = 1;
});
