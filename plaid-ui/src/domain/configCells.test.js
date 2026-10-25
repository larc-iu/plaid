import { describe, it, expect } from 'vitest';
import { storedConfig, withStoredConfig } from './configCells.js';

describe('withStoredConfig', () => {
  it('sets one cell and keeps the rest of the entity and its config', () => {
    const project = {
      id: 'p1',
      name: 'Texts',
      config: { igt: { tagsets: { a: 1 }, scope: 'Word' }, plaid: { tartan: false } },
    };
    const next = withStoredConfig(project, 'igt', 'tagsets', { b: 2 });
    expect(next).toEqual({
      id: 'p1',
      name: 'Texts',
      config: { igt: { tagsets: { b: 2 }, scope: 'Word' }, plaid: { tartan: false } },
    });
    expect(storedConfig(project, 'igt', 'tagsets')).toEqual({ a: 1 });
  });

  it('makes the namespace and the config when the entity has neither', () => {
    expect(withStoredConfig({ id: 'l1' }, 'ud', 'vocab', ['x'])).toEqual({
      id: 'l1',
      config: { ud: { vocab: ['x'] } },
    });
    expect(withStoredConfig(undefined, 'plaid', 'confidence', { threshold: 0.5 })).toEqual({
      config: { plaid: { confidence: { threshold: 0.5 } } },
    });
  });
});
