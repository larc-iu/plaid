import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../../test/apps.js';

// The assistant service is the only writer of a conversation record (Luke's
// ruling, 2026-10-09, design/SINGLE-WRITER.md). The page sends requests and
// reads, so no module of the Assistant writes or deletes the user's data. The
// one exception is deleting a conversation when no assistant of the app is
// online on its project (`deleteOffline` in jobs.js, ruled the same day).

const HERE = join(repoRoot(), 'plaid-ui', 'src', 'components', 'assistant');

const sources = readdirSync(HERE).filter(
  (f) => /\.(js|jsx)$/.test(f) && !/\.test\.(js|jsx)$/.test(f),
);

const writes = /userData\s*\.\s*(put|delete)\s*\(/g;

describe('the assistant page', () => {
  it('writes no user data, but for a delete with no assistant online', () => {
    const found = [];
    for (const f of sources) {
      const text = readFileSync(join(HERE, f), 'utf8');
      for (const m of text.matchAll(writes)) {
        const before = text.slice(0, m.index);
        const fn = [...before.matchAll(/\nconst (\w+) = /g)].at(-1)?.[1];
        found.push(`${f}:${fn}:${m[1]}`);
      }
    }
    expect(found.length).toBeGreaterThan(0);
    expect([...new Set(found)]).toEqual(['jobs.js:deleteOffline:delete']);
  });
});
