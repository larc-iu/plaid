// The documented recipe for a built-in rule's version hash, run in node over
// the files on disk (the core manual, "Provenance"): a sha256sum line per file
// named in domain/builtinSources.json, with the line endings the repository
// stores, and the first 8 hex digits of the SHA-256 of those lines.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = normalize(join(dirname(fileURLToPath(import.meta.url)), '../../..'));

// A file of the monorepo by its repository path, as git stores it.
export const readRepoFile = (path) => readFileSync(join(REPO, path), 'utf8').replace(/\r\n/g, '\n');

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

export const BUILTIN_SOURCES = JSON.parse(readRepoFile('plaid-igt/src/domain/builtinSources.json'));

export const manifestHash = (paths, read = readRepoFile) =>
  sha256(paths.map((p) => `${sha256(read(p))}  ${p}\n`).join('')).slice(0, 8);

export const builtinHash = (name) => manifestHash(BUILTIN_SOURCES[name]);
