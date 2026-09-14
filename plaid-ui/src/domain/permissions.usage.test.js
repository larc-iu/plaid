import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAINTAINER_HINT } from './permissions.js';

// Two things about the project roles that no rendered screen can check, because
// the point is agreement BETWEEN screens in two apps.
//
// The levels are the server's. A reader of one app's Access screen and a reader
// of the other's Invites screen are being told about the same four grants, and
// four hand-written copies of the sentence is how one of them ends up saying
// something else. Three of the four were already written out in full and the
// fourth named the levels and nothing else.

const here = path.dirname(fileURLToPath(import.meta.url));

// The repo root, found rather than counted: this package is reached through a
// node_modules symlink, so how many levels up it sits depends on which app's
// test run this is.
const repoRoot = () => {
  let dir = here;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'plaid-igt', 'src'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`No repo root above ${here}`);
};
const repo = repoRoot();

const APPS = ['plaid-igt/src', 'plaid-ud/src'];

const sources = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return sources(full);
        return e.isFile() && /\.jsx?$/.test(e.name) ? [full] : [];
      })
    : [];

// Every screen where a project role is CHOSEN. A role offered without a line
// saying what it grants leaves "a Reader cannot comment" to be learned by
// granting someone Reader and hearing about it.
const ROLE_PICKERS = [
  'plaid-igt/src/components/projects/AccessManagement.jsx',
  'plaid-ud/src/components/projects/ProjectManagement.jsx',
  'plaid-ud/src/components/projects/ProjectInvites.jsx',
];

// Every `{...}` in `text` with its braces balanced, so an option object is seen
// whole however much it holds.
const objectLiterals = (text) => {
  const out = [];
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{') stack.push(i);
    else if (text[i] === '}' && stack.length) {
      const start = stack.pop();
      out.push({ text: text.slice(start, i + 1), line: text.slice(0, start).split('\n').length });
    }
  }
  return out;
};

// An object's OWN keys: nested `{...}` removed.
const ownKeys = (text) => {
  let out = '';
  let depth = 0;
  for (let i = 1; i < text.length - 1; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') depth -= 1;
    else if (depth === 0) out += text[i];
  }
  return out;
};

describe('project role copy', () => {
  it('writes the maintainer line once, here', () => {
    const copies = APPS.flatMap((app) => sources(path.join(repo, app)))
      .filter((file) => fs.readFileSync(file, 'utf8').includes(MAINTAINER_HINT))
      .map((file) => path.relative(repo, file));
    expect(copies).toEqual([]);
  });

  it('finds the pickers, so a passing run is not an empty one', () => {
    for (const rel of ROLE_PICKERS) {
      expect(fs.existsSync(path.join(repo, rel)), rel).toBe(true);
    }
  });

  it('says what every role it offers grants', () => {
    const bare = [];
    for (const rel of ROLE_PICKERS) {
      const text = fs.readFileSync(path.join(repo, rel), 'utf8');
      for (const block of objectLiterals(text)) {
        const own = ownKeys(block.text);
        if (!/value:\s*'(none|reader|writer|maintainer)'/.test(own)) continue;
        if (!/\bhint:/.test(own)) bare.push(`${rel}:${block.line}`);
      }
    }
    expect(bare).toEqual([]);
  });
});
