#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { annotateError, appendSummary } from './lib/summary.mjs';
import {
  PORTABLE_VERSION_HANDOFF_SCHEMA,
  loadPortableVersionHandoff
} from './lib/portable-version-handoff.mjs';

async function writeGithubOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${String(value)}`);
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' }
    },
    strict: true
  });

  if (!values.plan) {
    throw new Error('resolve-portable-version-handoff requires --plan.');
  }

  const handoff = await loadPortableVersionHandoff(values.plan);
  await writeGithubOutputs({
    release_tag: handoff.releaseTag,
    dry_run: handoff.dryRun,
    should_build: handoff.shouldBuild,
    platform_matrix: JSON.stringify(handoff.platformMatrix),
    handoff_schema: PORTABLE_VERSION_HANDOFF_SCHEMA
  });

  await appendSummary([
    '## Portable Version delegated handoff accepted',
    `- Release tag: ${handoff.releaseTag}`,
    `- Plan: ${path.resolve(values.plan)}`,
    `- Dry run: ${handoff.dryRun ? 'true' : 'false'}`,
    `- Platforms: ${handoff.platforms.join(', ')}`,
    `- Publication directory: ${handoff.publication.versionDirectory}`
  ]);

  console.log(
    JSON.stringify(
      {
        releaseTag: handoff.releaseTag,
        dryRun: handoff.dryRun,
        shouldBuild: handoff.shouldBuild,
        platformMatrix: handoff.platformMatrix,
        handoffSchema: PORTABLE_VERSION_HANDOFF_SCHEMA
      },
      null,
      2
    )
  );
}

main().catch(async (error) => {
  annotateError(error.message);
  await appendSummary([
    '## Portable Version delegated handoff failed',
    `- ${error.message}`
  ]);
  console.error(error);
  process.exitCode = 1;
});
