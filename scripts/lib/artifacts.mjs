import path from 'node:path';
import { stat } from 'node:fs/promises';
import { sha256File } from './checksum.mjs';

export async function createArtifactRecord({ archivePath, platformId, metadata = {} }) {
  const fileStat = await stat(archivePath);
  return {
    platform: platformId,
    sourcePath: archivePath,
    outputPath: archivePath,
    fileName: path.basename(archivePath),
    sizeBytes: fileStat.size,
    sha256: await sha256File(archivePath),
    ...metadata
  };
}
