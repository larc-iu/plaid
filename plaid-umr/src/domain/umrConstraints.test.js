import { describe, it, expect } from 'vitest';
import { relationRules } from './umrConstraints.js';

describe('relationRules', () => {
  it('asks the sentence graph to stay inside the sentence layer, and nothing more', () => {
    expect(relationRules('sent')).toEqual([{ type: 'same-ancestor', tokenLayer: 'sent' }]);
  });
});
