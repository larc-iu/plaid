import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The write queue and the derived cache are the parts of DocumentModel most
// likely to change, so only DocumentModel touches them. A subclass or a screen
// goes through the base's own calls: `_reloadOnceDrained`, `_queuedBehind`,
// `_reloadInSend` (which answers what it read), `_invalidate`, `user` and
// `reload`.

const here = path.dirname(fileURLToPath(import.meta.url));

// The repo root, found rather than counted: this package is reached through a
// node_modules symlink, so how many levels up it sits depends on the app.
const repoRoot = () => {
  let dir = here;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'plaid-igt', 'src'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`No repo root above ${here}`);
};
const repo = repoRoot();

const ROOTS = ['plaid-ui/src', 'plaid-igt/src', 'plaid-ud/src', 'plaid-umr/src', 'plaid-dict/src'];

const sources = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(full);
        return e.isFile() && /\.jsx?$/.test(e.name) && !/\.(test|spec)\.jsx?$/.test(e.name)
          ? [full]
          : [];
      })
    : [];

const hits = (pattern, allowed) =>
  ROOTS.flatMap((root) => sources(path.join(repo, root)))
    .map((file) => path.relative(repo, file))
    .filter((rel) => !allowed.includes(rel))
    .flatMap((rel) =>
      fs
        .readFileSync(path.join(repo, rel), 'utf8')
        .split('\n')
        .map((line, i) => (pattern.test(line) ? `${rel}:${i + 1}` : null))
        .filter(Boolean),
    );

describe('DocumentModel privates', () => {
  it('only DocumentModel reaches into its write queue and derived cache', () => {
    expect(
      hits(/\b_writes\.|\b_derivedCache\b/, [
        'plaid-ui/src/domain/DocumentModel.js',
        // A queue of its own, not the document's.
        'plaid-ui/src/domain/CommentStore.js',
      ]),
    ).toEqual([]);
  });

  it('no screen reads a document model private user or reload', () => {
    expect(
      hits(/(?<!\bthis)\._(user\b|reload\()/, [
        // Outside this lane: doc.reload() when its owner next touches it.
        'plaid-ui/src/hooks/useResumedRun.js',
      ]),
    ).toEqual([]);
  });
});
