import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// JU (owner 2026-11-19): a job's undo is final. The guide (and the
// assistant's copy of it) says so, and never that the undo can be undone or
// that work it took back is brought back from History.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const guides = {
  app: read('../../../../docs/igt-guide.adoc'),
  assistant: read('../../../../../plaid-agent/src/plaid_agent/igt/igt-guide.adoc'),
};

describe.each(Object.entries(guides))('the %s guide', (_name, text) => {
  it('says a job’s undo cannot be undone', () => {
    const section = text.split('== Undoing a job\n')[1].split('\n== ')[0];
    expect(section).toContain("A job's undo cannot itself be undone.");
    expect(section).not.toMatch(/the undo can itself be undone/);
    expect(section).not.toMatch(/brought back from History/);
  });
});
