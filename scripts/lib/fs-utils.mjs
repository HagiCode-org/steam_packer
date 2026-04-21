import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(directoryPath) {
  await mkdir(directoryPath, { recursive: true });
  return directoryPath;
}

export async function cleanDir(directoryPath) {
  await rm(directoryPath, { recursive: true, force: true });
  await ensureDir(directoryPath);
  return directoryPath;
}

export async function readJson(filePath) {
  const content = await readFile(filePath, 'utf8');
  return JSON.parse(content);
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return filePath;
}

export async function copyDir(sourcePath, targetPath) {
  await ensureDir(path.dirname(targetPath));
  await cp(sourcePath, targetPath, { recursive: true, force: true });
  return targetPath;
}

export async function copySingleFile(sourcePath, targetPath) {
  await ensureDir(path.dirname(targetPath));
  await copyFile(sourcePath, targetPath);
  return targetPath;
}

export async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function listFilesRecursively(rootPath) {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(entryPath)));
      continue;
    }
    files.push(entryPath);
  }
  return files;
}

export async function findFirstMatchingDirectory(rootPath, predicate) {
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (await predicate(entryPath)) {
        return entryPath;
      }
      const nested = await findFirstMatchingDirectory(entryPath, predicate);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}
