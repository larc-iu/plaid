import { describe, it, expect } from 'vitest';
import { readRole } from '@larc-iu/plaid-client';
import {
  changeLines as changeLinesWith,
  indexLayers as indexLayersWith,
} from '@ui/domain/restoreSummary.js';
import { TOKEN_ROLE_WORDS } from './restoreSummary.js';

// The two halves as the dialog puts them together: the shared reading, and
// this app's words for a token layer's role.
const indexLayers = (raw) => indexLayersWith(raw, readRole);
const changeLines = (summary, layers) => changeLinesWith(summary, layers, TOKEN_ROLE_WORDS);

// A document's layers, plus one token layer belonging to another app that
// shares the substrate (plaid-ud's syntactic words) to check the fallback.
const raw = {
  textLayers: [
    {
      id: 'text',
      tokenLayers: [
        { id: 'sent', name: 'Sentences', config: { plaid: { role: 'sentence' } } },
        {
          id: 'word',
          name: 'Words',
          config: { plaid: { role: 'word' } },
          spanLayers: [{ id: 'gloss', name: 'Gloss' }],
        },
        { id: 'morph', name: 'Morphemes', config: { plaid: { role: 'morpheme' } } },
        { id: 'align', name: 'Alignment', config: { plaid: { role: 'time-alignment' } } },
        { id: 'sw', name: 'Syntactic words', config: { plaid: { role: 'syntactic-word' } } },
      ],
    },
  ],
};

const layers = indexLayers(raw);

describe('changeLines in this app words', () => {
  it('names each token layer by its role', () => {
    const lines = changeLines(
      {
        tokens: {
          byLayer: [
            { layerId: 'sent', inserted: 1 },
            { layerId: 'word', inserted: 2, deleted: 1 },
            { layerId: 'morph', updated: 5 },
            { layerId: 'align', deleted: 1 },
          ],
        },
      },
      layers,
    );
    expect(lines).toEqual(['1 sentence', '3 words', '5 morphemes', '1 time alignment']);
  });

  it('falls back to its own name for a layer another app owns', () => {
    expect(changeLines({ tokens: { byLayer: [{ layerId: 'sw', updated: 2 }] } }, layers)).toEqual([
      '2 tokens in Syntactic words',
    ]);
  });

  it('names the words that read from a restored text', () => {
    expect(changeLines({ texts: { updated: 1 } }, layers)).toEqual([
      'The text, and the words read from it',
    ]);
  });

  it('names a span layer by the name the project gave it', () => {
    expect(
      changeLines({ spans: { byLayer: [{ layerId: 'gloss', inserted: 3 }] } }, layers),
    ).toEqual(['3 annotations in Gloss']);
  });
});
