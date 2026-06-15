import { describe, it, expect, beforeEach } from 'vitest';
import { validateIgtDocument, formatFindingsForClipboard } from './validate.js';
import { getIgtLayerInfo } from './layerInfo.js';
import { buildRawDoc, resetIds } from './test-helpers.js';

const morph = (id, begin, end) => ({ id, text: 'text-1', begin, end, precedence: 1, metadata: {} });

beforeEach(() => resetIds());

describe('validateIgtDocument', () => {
  it('returns no findings for a well-formed document', () => {
    expect(validateIgtDocument(getIgtLayerInfo(buildRawDoc()))).toEqual([]);
  });

  it('flags a residual orphan morpheme (heal tripwire)', () => {
    const raw = buildRawDoc({
      morphemes: [morph('m-1', 0, 3), morph('m-2', 4, 7), morph('m-orphan', 3, 4)],
    });
    const findings = validateIgtDocument(getIgtLayerInfo(raw));
    expect(findings.find(f => f.code === 'morpheme-orphan')).toMatchObject({ severity: 'error' });
  });

  it('flags a residual bare word (heal tripwire)', () => {
    const raw = buildRawDoc({ morphemes: [morph('m-1', 0, 3)] }); // w-2 has no morpheme
    const findings = validateIgtDocument(getIgtLayerInfo(raw));
    expect(findings.find(f => f.code === 'morpheme-missing')).toMatchObject({ severity: 'error' });
  });

  it('flags residual duplicate spans (heal tripwire)', () => {
    const raw = buildRawDoc();
    raw.textLayers[0].tokenLayers[2].spanLayers[0].spans.push(
      { id: 'a', tokens: ['m-1'], value: 'x' },
      { id: 'b', tokens: ['m-1'], value: 'y' },
    );
    const findings = validateIgtDocument(getIgtLayerInfo(raw));
    expect(findings.find(f => f.code === 'span-duplicate')).toMatchObject({ severity: 'error' });
  });

  it('warns about inverted alignment timing (un-healable — needs a human)', () => {
    const findings = validateIgtDocument(getIgtLayerInfo(buildRawDoc()), [
      { id: 'a1', begin: 0, end: 3, metadata: { timeBegin: 5, timeEnd: 2 } },
      { id: 'a2', begin: 4, end: 7, metadata: { timeBegin: 1, timeEnd: 3 } }, // fine
    ]);
    const f = findings.find(x => x.code === 'alignment-time-inverted');
    expect(f).toMatchObject({ severity: 'warning', context: { id: 'a1' } });
    expect(findings.filter(x => x.code === 'alignment-time-inverted')).toHaveLength(1);
  });
});

describe('formatFindingsForClipboard', () => {
  it('renders one line per finding with the document id header', () => {
    const text = formatFindingsForClipboard(
      [{ severity: 'error', code: 'span-duplicate', message: 'two spans', context: { tokens: ['t1'] } }],
      { documentId: 'doc-1' },
    );
    expect(text).toContain('doc-1');
    expect(text).toContain('[error] span-duplicate: two spans');
    expect(text).toContain('"tokens":["t1"]');
  });
});
