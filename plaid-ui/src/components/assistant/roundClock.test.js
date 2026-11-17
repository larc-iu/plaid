import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../../test/apps.js';
import { ROUND_LINES, roundAfter, thinkingFor } from './roundClock.js';

describe('the round under way', () => {
  it('starts when the service says a model call began', () => {
    expect(roundAfter(null, 'Thinking…', 0, 1000)).toEqual({ steps: 0, at: 1000, shown: true });
  });

  it('is not shown while a tool runs or the reply streams, and keeps its start', () => {
    const r = roundAfter(null, 'Thinking…', 0, 1000);
    expect(roundAfter(r, 'Searching…', 0, 5000)).toEqual({ steps: 0, at: 1000, shown: false });
    expect(roundAfter(r, 'Writing…', 0, 5000)).toEqual({ steps: 0, at: 1000, shown: false });
    expect(roundAfter(null, 'Writing…', 0, 5000)).toBeNull();
  });

  it('keeps counting across a wait for a busy model', () => {
    let r = roundAfter(null, 'Thinking more…', 2, 1000);
    r = roundAfter(r, 'Waiting for the model…', 2, 3000);
    r = roundAfter(r, 'Thinking more…', 2, 9000);
    expect(r).toEqual({ steps: 2, at: 1000, shown: true });
  });

  it('starts again with the next round, whose line comes with the last round’s steps', () => {
    let r = roundAfter(null, 'Thinking…', 0, 1000);
    r = roundAfter(r, 'Searching…', 0, 4000);
    r = roundAfter(r, 'Thinking more…', 1, 6000);
    expect(r).toEqual({ steps: 1, at: 6000, shown: true });
  });

  it('is the line the service sends at the start of each model call', () => {
    // The two lines are the service's own (core/agent.py): this pins them.
    const agent = fs.readFileSync(
      path.join(repoRoot(), 'plaid-agent/src/plaid_agent/core/agent.py'),
      'utf8',
    );
    expect(agent).toContain("'Thinking…' if rounds == 0 else 'Thinking more…'");
    expect([...ROUND_LINES]).toEqual(['Thinking…', 'Thinking more…']);
  });
});

describe('thinkingFor', () => {
  it('says seconds, then minutes and seconds', () => {
    expect(thinkingFor(0)).toBe('Thinking, 0 s');
    expect(thinkingFor(45_900)).toBe('Thinking, 45 s');
    expect(thinkingFor(125_000)).toBe('Thinking, 2 min 5 s');
  });
});
