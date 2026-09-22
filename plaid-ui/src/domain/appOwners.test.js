import { describe, it, expect } from 'vitest';
import { APP_OWNERS, ownerOf } from './appOwners.js';
import { APPS } from '../test/apps.js';

// plaid-igt is the app that asks: its admin area lists every project on the
// server, and it knows its own from its own config module. Every OTHER live app
// has to be recognisable from here, or a project of that app's opens in the
// asking app's setup wizard, over somebody else's corpus.
const RECOGNISED = APPS.map((a) => a.tag).filter((tag) => tag !== 'igt');

// The shapes each recogniser looks for: UD's annotation spans under its own
// namespace on the syntactic-word layer, UMR's node token layer.
const udProject = {
  textLayers: [
    {
      tokenLayers: [
        {
          config: { plaid: { role: 'syntactic-word' } },
          spanLayers: [{ config: { ud: { vocab: [] } } }],
        },
      ],
    },
  ],
};
const umrProject = {
  textLayers: [{ tokenLayers: [{ config: { umr: { nodes: true } } }] }],
};

describe('who owns a project', () => {
  it('has a rule for every live app but the one asking', () => {
    expect(APP_OWNERS.map((o) => o.tag)).toEqual(RECOGNISED);
  });

  it('names the app and where the project opens', () => {
    expect(ownerOf(umrProject).shape).toBe('UMR');
    expect(ownerOf(umrProject).url('p1')).toContain('/umr/');
    expect(ownerOf(udProject).shape).toBe('UD');
    expect(ownerOf(udProject).url('p1')).toContain('/ud/');
  });

  it('answers null for a project no app here set up', () => {
    expect(ownerOf({ textLayers: [{ tokenLayers: [] }] })).toBe(null);
    expect(ownerOf(undefined)).toBe(null);
  });
});
