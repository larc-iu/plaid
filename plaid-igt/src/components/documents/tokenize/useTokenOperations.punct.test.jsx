// REV8-PUNCT-3: a merge on the Tokenize tab across a punctuation token ud
// made asks what a merge across untokenized punctuation asks, since igt
// reads that token as text: ud's lemma on the comma is not counted, as
// Baseline's question and Clear tokens leave it out.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { DocumentProvider } from '../contexts/DocumentContext.jsx';
import { useTokenOperations } from './useTokenOperations.js';
import { buildRawDoc, resetIds, makeIgtDoc, settle } from '../../../domain/test-helpers.js';

vi.mock('@ui/hooks/useServiceRequest.js', () => ({
  useServiceRequest: () => ({
    availableServices: [],
    isDiscovering: false,
    discoverServices: () => {},
    isProcessing: false,
    requestService: vi.fn(),
    cancelRequest: () => {},
    hasServices: false,
    progressPercent: null,
    progressMessage: null,
  }),
}));
vi.mock('@ui/hooks/useServiceSpot.js', () => ({
  useServiceSpot: () => ({ service: null, params: { errors: {}, coerced: () => ({}) } }),
}));
vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
}));

beforeEach(() => resetIds());

const build = (punct) => {
  const raw = buildRawDoc({
    body: 'ab, cd',
    words: [
      { id: 'w-1', begin: 0, end: 2 },
      ...(punct ? [{ id: 'p-1', begin: 2, end: 3 }] : []),
      { id: 'w-3', begin: 4, end: 6 },
    ],
    morphemes: [],
  });
  const layer = raw.textLayers[0].tokenLayers.find((l) => l.id === 'wordL');
  layer.config.plaid.ignoredTokens = { type: 'unicodePunctuation', whitelist: [] };
  if (punct) {
    layer.spanLayers.push({
      id: 'ud-lemma',
      name: 'Lemma',
      config: {},
      spans: [{ id: 'sp-ud', tokens: ['p-1'], value: ',' }],
      relationLayers: [],
    });
  }
  return makeIgtDoc({ raw });
};

const mount = async (doc) => {
  const lock = { release: vi.fn(), setStatus: () => {} };
  let ops;
  const Probe = () => {
    ops = useTokenOperations();
    return null;
  };
  const view = await renderComponent(
    <DocumentProvider value={{ doc, client: doc.client, acquireWriteLock: () => lock }}>
      <Probe />
    </DocumentProvider>,
  );
  return { view, ops: () => ops };
};

describe("a merge across ud's punctuation token", () => {
  it('merges at once, as across untokenized punctuation', async () => {
    for (const punct of [false, true]) {
      const doc = build(punct);
      const { view, ops } = await mount(doc);
      await view.step(() => ops().mergeTokens(['w-1', 'w-3']));
      await settle();
      expect(ops().pendingStructural, punct ? 'with the token' : 'without').toBe(null);
      expect(doc.layerInfo.primaryTokenLayer.tokens.map((t) => [t.begin, t.end])).toEqual([[0, 6]]);
      await view.unmount();
    }
  });
});
