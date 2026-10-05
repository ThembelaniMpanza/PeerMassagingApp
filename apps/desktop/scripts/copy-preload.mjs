import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const destination = resolve(root, 'dist-electron/preload.cjs');
await mkdir(dirname(destination), { recursive: true });
await copyFile(resolve(root, 'preload.cjs'), destination);