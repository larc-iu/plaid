import { describe, it, expect } from 'vitest';
import { IgtDocument } from './IgtDocument.js';

// Every public async method of IgtDocument is a declared write (WRITES), so it
// takes its ids settled (DocumentModel `_runWrite`), or is listed here as one
// that writes nothing or takes no id from the screen.
const EXEMPT = [
  // Reads.
  'atAsOf',
  'refreshVocabulary',
];

const AsyncFunction = (async () => {}).constructor;

describe('IgtDocument writes', () => {
  it('declares every public async method, or exempts it', () => {
    const proto = IgtDocument.prototype;
    const declared = new Set(IgtDocument.WRITES);
    const unlisted = Object.getOwnPropertyNames(proto).filter((name) => {
      if (name.startsWith('_') || name === 'constructor' || declared.has(name)) return false;
      const d = Object.getOwnPropertyDescriptor(proto, name);
      return d.value instanceof AsyncFunction && !EXEMPT.includes(name);
    });
    expect(unlisted).toEqual([]);
    for (const name of IgtDocument.WRITES) expect(typeof proto[name]).toBe('function');
  });
});
