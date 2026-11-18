import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = process.cwd();
const distDir = path.resolve(rootDir, 'dist');
const downloadsDir = path.join(distDir, 'downloads');
const tempZip = path.resolve(rootDir, 'lexel-lab-standalone.zip');
const distZip = path.join(downloadsDir, 'lexel-lab-standalone.zip');

async function main() {
  const s = await stat(distDir);
  if (!s.isDirectory()) {
    throw new Error('dist/ does not exist; run vite build first.');
  }

  await chmod(path.join(distDir, 'start-lexel-lab.sh'), 0o755).catch(() => undefined);
  await rm(downloadsDir, { recursive: true, force: true });
  await rm(tempZip, { force: true });

  await execFileAsync('zip', ['-r', tempZip, '.'], { cwd: distDir });
  await mkdir(downloadsDir, { recursive: true });
  await copyFile(tempZip, distZip);
  console.log(`Packaged standalone lab bundle: ${tempZip} and ${distZip}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
