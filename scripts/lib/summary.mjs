import { appendFile } from 'node:fs/promises';

export async function appendSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  const content = Array.isArray(lines) ? `${lines.join('\n')}\n` : `${lines}\n`;
  await appendFile(process.env.GITHUB_STEP_SUMMARY, content, 'utf8');
}

export function annotateError(message) {
  console.error(`::error::${message}`);
}

export function annotateWarning(message) {
  console.warn(`::warning::${message}`);
}
