import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// H9-1, H11-5: Settings > Annotation has no way to rename a field, so the
// guide (and the assistant's copy of it) must not promise one.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const guides = {
  app: read('../../../../docs/igt-guide.adoc'),
  assistant: read('../../../../../plaid-agent/src/plaid_agent/igt/igt-guide.adoc'),
};

describe.each(Object.entries(guides))('the %s guide', (_name, text) => {
  it('promises no renaming of an annotation field', () => {
    expect(text).not.toMatch(/add, rename, reorder/);
    expect(text).not.toMatch(/a renamed field stays the default/);
    expect(text).toContain('You can add, reorder, and remove them');
  });
});
