import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
export async function hashFile(file, { signal } = {}) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}
export function runProcess(command, args, { timeoutMs = 3600000, capture = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'],
      windowsHide: true,
      signal,
    });
    let output = capture ? [] : null,
      error = '',
      processError;
    if (capture) child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => {
      error = (error + chunk).slice(-4000);
    });
    const timer = setTimeout(() => {
      processError = new Error(`${command} timed out`);
      child.kill();
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      processError = err;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (processError) reject(processError);
      else if (code !== 0) reject(new Error(`${command} exit ${code}: ${error}`));
      else resolve(capture ? Buffer.concat(output) : undefined);
    });
  });
}
