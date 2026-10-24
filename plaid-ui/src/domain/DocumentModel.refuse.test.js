// B5-5: a guard's refusal is said every time, so the same gesture refused
// twice in a row is answered twice. setError says a standing message once.
import { describe, expect, it } from 'vitest';
import { DocumentModel } from './DocumentModel.js';

const make = () => {
  const doc = new DocumentModel({ raw: { id: 'd1' }, client: {}, projectId: 'p1' });
  const said = [];
  doc.onError = (msg) => said.push(msg);
  return { doc, said };
};

describe('refuse', () => {
  it('says the same refusal twice in a row, and answers false', () => {
    const { doc, said } = make();
    expect(doc.refuse('Word not found')).toBe(false);
    expect(doc.refuse('Word not found')).toBe(false);
    expect(said).toEqual(['Word not found', 'Word not found']);
    expect(doc.error).toBe('Word not found');
  });

  it('leaves setError saying a standing message once', () => {
    const { doc, said } = make();
    doc.setError('Offline');
    doc.setError('Offline');
    expect(said).toEqual(['Offline']);
  });
});
