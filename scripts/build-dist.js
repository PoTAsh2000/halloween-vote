// Collects everything the NAS needs to build and run the app into dist/, so one folder can be copied over.
import { cpSync, rmSync } from 'node:fs';

const FILES = [
  'src',
  'public',
  'package.json',
  'package-lock.json',
  'Dockerfile',
  '.dockerignore',
  'docker-compose.yml',
  '.env.example',
];

rmSync('dist', { recursive: true, force: true });
for (const file of FILES) cpSync(file, `dist/${file}`, { recursive: true });
console.log(`dist/ ready: ${FILES.join(', ')}`);
