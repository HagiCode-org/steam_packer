import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';

export async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function writeChecksumFile(entries, filePath) {
  const lines = entries.map((entry) => `${entry.sha256}  ${entry.fileName}`);
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}
