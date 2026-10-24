import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished } from 'vitest';

// What the repo-wide gates (the *.test.js files at this package's root that
// read every package) share: a `git grep -P` over the tracked files, the
// marker that lets one line through with its reason, and a scratch repo the
// gates' self-tests plant their bad and clean lines in, so each self-test runs
// the same grep the gate does rather than a JavaScript copy of its patterns.

/**
 * Every line under `pathspecs` that matches one of `patterns` (PCRE, as
 * `git grep -P` reads them), as `{ file, line, text }`, file relative to
 * `root`. Only tracked files are read.
 */
export const gitGrep = (root, patterns, pathspecs) => {
  const args = ['-C', root, 'grep', '-P', '-n', '-I', '--no-color'];
  for (const p of patterns) args.push('-e', p);
  args.push('--', ...pathspecs);
  let out;
  try {
    out = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    // 1 is git grep's "nothing matched". Anything else is a broken pattern
    // or pathspec, which must fail the gate rather than pass it.
    if (e.status === 1 && !e.stderr?.length) return [];
    throw new Error(`git grep failed: ${e.stderr || e.message}`, { cause: e });
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const m = /^(.*?):(\d+):(.*)$/.exec(row);
      return { file: m[1], line: Number(m[2]), text: m[3] };
    });
};

/**
 * The marker that lets a line through: `<tag>: <reason>` on the line itself
 * or on the line above, the reason at least two words, so the reason stays in
 * the code and moves with it.
 */
const markerPattern = (tag) => new RegExp(`\\b${tag}:\\s*\\S+(\\s+\\S+)+`);

/**
 * The hits that carry no marker, as `file:line: text`. A run of hits on
 * consecutive lines (an if and its else if) shares one marker above the first
 * of them.
 */
export const unmarked = (root, hits, tag) => {
  const marker = markerPattern(tag);
  const files = new Map();
  const linesOf = (file) => {
    if (!files.has(file))
      files.set(file, fs.readFileSync(path.join(root, file), 'utf8').split('\n'));
    return files.get(file);
  };
  const hitLines = new Set(hits.map(({ file, line }) => `${file}:${line}`));
  const covered = ({ file, line }) => {
    const lines = linesOf(file);
    for (let n = line; n >= 1; n -= 1) {
      if (marker.test(lines[n - 1] || '')) return true;
      if (n < line && !hitLines.has(`${file}:${n}`)) return false;
    }
    return false;
  };
  return hits
    .filter((hit) => !covered(hit))
    .map(({ file, line, text }) => `${file}:${line}: ${text.trim()}`);
};

/**
 * A throwaway git repo holding `files` (path -> content), every file added,
 * for a gate's self-test. Returns its root, which is removed when the test
 * that made it ends.
 */
export const scratchRepo = (files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plaid-gate-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  execFileSync('git', ['-C', root, 'add', '-A']);
  return root;
};

/**
 * The tracked files under `pathspecs`, repo-relative, that are on disk. The
 * one answer the repo-wide gates give to "what is a source file": what git
 * tracks, so node_modules, build output and scratch probes never count.
 */
export const trackedFiles = (root, pathspecs) =>
  execFileSync('git', ['-C', root, 'ls-files', '--', ...pathspecs], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter((f) => f && fs.existsSync(path.join(root, f)));

/** A line that is only a comment: `//`, a block comment's line, or JSX's `{/*`. */
export const isComment = (line) => /^\s*(\/\/|\/?\*|\{\/\*)/.test(line);
