#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeReleasePlan, main } from './run-release-plan.mjs';

export const executePortableVersionHandoff = executeReleasePlan;

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
