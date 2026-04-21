#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { annotateError, appendSummary } from './lib/summary.mjs';
import { STEAM_PACKER_HANDOFF_SCHEMA, loadReleasePlan } from './lib/release-plan.mjs';

async function writeGithubOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${String(value)}`);
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, 'utf8');
}

export async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' }
    },
    strict: true
  });

  if (!values.plan) {
    throw new Error('resolve-release-plan requires --plan.');
  }

  const releasePlan = await loadReleasePlan(values.plan);
  await writeGithubOutputs({
    release_tag: releasePlan.releaseTag,
    dry_run: releasePlan.dryRun,
    should_build: releasePlan.shouldBuild,
    platform_matrix: JSON.stringify(releasePlan.platformMatrix),
    handoff_schema: STEAM_PACKER_HANDOFF_SCHEMA
  });

  await appendSummary([
    '## steam_packer release plan accepted',
    `- Release tag: ${releasePlan.releaseTag}`,
    `- Plan: ${path.resolve(values.plan)}`,
    `- Dry run: ${releasePlan.dryRun ? 'true' : 'false'}`,
    `- Platforms: ${releasePlan.platforms.join(', ')}`,
    `- Publication directory: ${releasePlan.publication.versionDirectory}`
  ]);

  console.log(
    JSON.stringify(
      {
        releaseTag: releasePlan.releaseTag,
        dryRun: releasePlan.dryRun,
        shouldBuild: releasePlan.shouldBuild,
        platformMatrix: releasePlan.platformMatrix,
        handoffSchema: STEAM_PACKER_HANDOFF_SCHEMA
      },
      null,
      2
    )
  );
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(async (error) => {
    annotateError(error.message);
    await appendSummary([
      '## steam_packer release plan failed',
      `- ${error.message}`
    ]);
    console.error(error);
    process.exitCode = 1;
  });
}
