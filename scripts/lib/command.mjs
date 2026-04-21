import { spawn } from 'node:child_process';

export function shouldUseWindowsShell(command, shell, platform = process.platform) {
  if (shell || platform !== 'win32') {
    return shell;
  }

  return /\.(?:cmd|bat)$/i.test(String(command));
}

export async function runCommand(command, args, options = {}) {
  const {
    cwd,
    env,
    input,
    shell = false,
    stdio = 'inherit'
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: shouldUseWindowsShell(command, shell),
      stdio: stdio === 'pipe' ? ['pipe', 'pipe', 'pipe'] : stdio
    });

    let stdout = '';
    let stderr = '';

    if (stdio === 'pipe') {
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      if (input) {
        child.stdin?.write(input);
        child.stdin?.end();
      }
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `Command failed: ${command} ${args.join(' ')}${stderr ? `\n${stderr}` : ''}`
        )
      );
    });
  });
}

export async function runCommandResult(command, args, options = {}) {
  const {
    cwd,
    env,
    input,
    shell = false
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: shouldUseWindowsShell(command, shell),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    if (input) {
      child.stdin?.write(input);
    }
    child.stdin?.end();

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}
