import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { checkRelease, PACKAGE_ROOT } from './check-release.mjs';

const { version, files } = await checkRelease();
const destination = path.resolve(process.argv[2] || path.join(PACKAGE_ROOT, 'dist'));
const name = `codex-reset-v${version}.tar.gz`;
const archive = path.join(destination, name);

await mkdir(destination, { recursive: true });
execFileSync('tar', [
  '--create', '--gzip', '--file', archive,
  '--format=ustar', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
  '--directory', PACKAGE_ROOT, '--', ...files,
], { stdio: 'inherit' });

const digest = createHash('sha256').update(await readFile(archive)).digest('hex');

await writeFile(`${archive}.sha256`, `${digest}  ${name}\n`);
console.log(`Архив: ${archive}`);
console.log(`SHA-256: ${digest}`);
