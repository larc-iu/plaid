import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { appTrees, repoRoot } from '../../test/apps.js';

// What every screen that publishes an assistant subject has to say about the
// reader, checked against the source rather than by rendering.
//
// `canWrite` and `contributor` are two halves of one answer: the first decides
// whether an approved plan may write at all, the second how its writes are
// attributed and whether the reader is offered the withheld-review checkbox.
// Four screens published both and the vocabulary screen published only the
// first, so a reviewed contributor's approved plan on a vocabulary was stamped
// `contributedBy: null` and shown a control others are denied. That is the
// shape this repo keeps hitting: a rule taught to one writer.
//
// A static read is the right tool: the property is "this prop is present at
// this call site", which a reader of the source can see and a renderer cannot.
// It reads EVERY app and this package, since the hook is shared and a new
// screen anywhere can break it, which is why it sits beside `subject.js` here
// rather than in one of them. It runs under plaid-igt's vitest, like every test
// in this package.

const repo = repoRoot();

// This package as well as the apps: the project tab strip publishes the project
// for every project-level screen and lives here now, so a read of the apps
// alone would find four call sites and pass on a false floor.
const TREES = ['plaid-ui/src', ...appTrees('src'), 'plaid-dict/src'];

const sources = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return sources(full);
        return e.isFile() && /\.jsx?$/.test(e.name) && !/\.test\.jsx?$/.test(e.name) ? [full] : [];
      })
    : [];

// Every `useAssistantSubject({ … })` across the apps, as {file, line, args}.
// Brace-balanced, since the argument holds callbacks full of JSX.
const callSites = () =>
  TREES.flatMap((tree) => sources(path.join(repo, tree))).flatMap((file) => {
    const text = fs.readFileSync(file, 'utf8');
    const out = [];
    const marker = 'useAssistantSubject({';
    let from = 0;
    for (;;) {
      const at = text.indexOf(marker, from);
      if (at === -1) break;
      let depth = 0;
      let end = at + marker.length - 1;
      for (let i = end; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      out.push({
        file: path.relative(repo, file),
        line: text.slice(0, at).split('\n').length,
        args: text.slice(at, end + 1),
      });
      from = end + 1;
    }
    return out;
  });

const at = (site) => `${site.file}:${site.line}`;

describe('useAssistantSubject call sites', () => {
  it('finds the screens, so a passing run is not an empty one', () => {
    expect(callSites().length).toBeGreaterThanOrEqual(5);
  });

  it('all publish who the reader is, not just what they may do', () => {
    const half = callSites().filter(
      (s) => /\bcanWrite:/.test(s.args) && !/\bcontributor:/.test(s.args),
    );
    expect(half.map(at)).toEqual([]);
  });
});
