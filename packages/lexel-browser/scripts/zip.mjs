import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const outName = process.argv[2] ?? 'lexel-browser.zip';
const distDir = path.resolve(process.cwd(), 'dist');
const outPath = path.resolve(process.cwd(), outName);

async function main() {
  const files = await readdir(distDir);
  if (files.length === 0) {
    throw new Error('dist/ is empty; run build first.');
  }
  const s = await stat(distDir);
  if (!s.isDirectory()) throw new Error('dist/ is not a directory');
  await rm(outPath, { force: true });
  await execFileAsync('zip', ['-rq', outPath, '.'], { cwd: distDir });
  console.log(`Created ${outName}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
