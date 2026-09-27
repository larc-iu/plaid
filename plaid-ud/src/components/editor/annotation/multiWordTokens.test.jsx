import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { press } from '../../../test/keyboard.js';
import { SentenceRow } from './SentenceRow.jsx';
import { EditorSessionContext } from './editorSession.js';
import { multiWordTokens, widenForLabels, bracketWidth } from './multiWordTokens.js';

// A multi-word token in the annotation grid: "del" is the words "de" and "el",
// one column each, and a bracket under their forms labelled "del" says they
// were one written token.

vi.mock('../../../utils/feedback.jsx', () => ({ notifyWarning: vi.fn() }));

const SESSION = {
  isReadOnly: false,
  onAnnotationUpdate: vi.fn(() => Promise.resolve()),
  onToggleField: vi.fn(),
  visibleFields: { lemma: true, xpos: true, upos: true, feats: true },
  vocab: {},
  validators: {},
  descriptions: {},
  colors: {},
  reviewable: () => false,
};

// A word row as buildSentenceRows makes it. `word` is the written token the
// word belongs to, and `parts` how many words that token has.
const row = (id, form, word, parts = 1, wordForm = form) => ({
  token: { id, begin: 0, end: 1, metadata: {} },
  tokenForm: form,
  wordForm,
  word,
  wordHasMultipleMorphemes: parts > 1,
  form: { id: `${id}-f`, metadata: {} },
  lemma: { id: `${id}-l`, value: form, metadata: {} },
  xpos: { id: `${id}-x`, value: '', metadata: {} },
  upos: { id: `${id}-u`, value: 'ADP', metadata: {} },
  feats: [],
  spanIds: { form: `${id}-f`, lemma: `${id}-l`, upos: `${id}-u`, xpos: `${id}-x`, features: [] },
});

const del = { id: 'w2', metadata: { form: 'del' } };
const rows = () => [
  row('t1', 'vamos', { id: 'w1', metadata: {} }),
  row('t2', 'de', del, 2, 'del'),
  row('t3', 'el', del, 2, 'del'),
  row('t4', 'pueblo', { id: 'w3', metadata: {} }),
];

describe('which columns make up a multi-word token', () => {
  it('finds each token with more than one word, and its written form', () => {
    expect(multiWordTokens(rows())).toEqual([{ start: 1, size: 2, form: 'del' }]);
  });

  it('falls back to the text when no form was stored', () => {
    const w = { id: 'w9', metadata: {} };
    const r = [row('a', 'و', w, 2, 'وقال'), row('b', 'قال', w, 2, 'وقال')];
    expect(multiWordTokens(r)).toEqual([{ start: 0, size: 2, form: 'وقال' }]);
  });

  it('finds none in a sentence of one-word tokens', () => {
    expect(multiWordTokens([rows()[0], rows()[3]])).toEqual([]);
  });

  it('spans from the first form to the last across the gaps between columns', () => {
    // Two 40px columns, each padded 8px a side and 8px apart.
    expect(bracketWidth([100, 40, 40], 1, 2, 8)).toBe(40 + 40 + 8 - 16);
  });

  it('widens the last word when the label would not fit', () => {
    const groups = [{ start: 0, size: 2, form: 'x'.repeat(20) }];
    const widths = widenForLabels([40, 40, 60], groups, 8);
    expect(bracketWidth(widths, 0, 2, 8)).toBeGreaterThanOrEqual(20 * 8);
    expect(widths[0]).toBe(40);
    expect(widths[2]).toBe(60);
  });

  it('leaves the widths alone when the label fits', () => {
    const widths = [80, 80];
    expect(widenForLabels(widths, [{ start: 0, size: 2, form: 'del' }], 8)).toBe(widths);
  });
});

const mountRow = (tokens, session = {}) =>
  renderComponent(
    <EditorSessionContext.Provider value={{ ...SESSION, ...session }}>
      <SentenceRow
        sentenceData={{ tokens, relations: [], enhancedRelations: [], lemmaSpans: [] }}
        totalTokensBefore={0}
        sentenceIndex={0}
      />
    </EditorSessionContext.Provider>,
  );

describe('the bracket in the grid', () => {
  it('hangs from the first word of the token, labelled with its written form', async () => {
    const { container, unmount } = await mountRow(rows());
    const brackets = all(container, '.mwt-bracket');
    expect(brackets.length).toBe(1);
    expect(brackets[0].textContent).toBe('del');
    const columns = all(container, '.token-column');
    expect(columns[1].querySelector('.mwt-bracket')).toBe(brackets[0]);
    // As wide as the two columns it groups, so it ends under "el".
    const w = (el) => parseFloat(el.style.width);
    expect(w(brackets[0])).toBe(w(columns[1]) + w(columns[2]) + 8 - 16);
    await unmount();
  });

  it('holds its row open in every column and the labels column, so rows stay aligned', async () => {
    const { container, unmount } = await mountRow(rows());
    expect(all(container, '.token-column .mwt-row').length).toBe(4);
    expect(all(container, '.labels-column .mwt-row').length).toBe(1);
    await unmount();
  });

  it('adds nothing to a sentence without one', async () => {
    const { container, unmount } = await mountRow([rows()[0], rows()[3]]);
    expect(all(container, '.mwt-row').length).toBe(0);
    await unmount();
  });

  it('reads its label in its own direction', async () => {
    const { container, unmount } = await mountRow(rows(), { textDirection: 'rtl' });
    expect(container.querySelector('.mwt-bracket__form').getAttribute('dir')).toBe('auto');
    await unmount();
  });

  it('is left out of what a screen reader reads, so the first word is not read as "de del"', async () => {
    // In reading order the label falls straight after the first word's form,
    // and the grid read aloud came out as "de del el". The Text Editor says
    // which words are one written token.
    const { container, unmount } = await mountRow(rows());
    const bracket = container.querySelector('.mwt-bracket');
    expect(bracket.closest('[aria-hidden="true"]')).not.toBe(null);
    await unmount();
  });

  it('takes no focus, so the arrow keys cross it as before', async () => {
    const { container, unmount } = await mountRow(rows());
    expect(all(container, '.mwt-row [tabindex], .mwt-row input, .mwt-row button').length).toBe(0);
    const lemma = (i) => all(container, 'input[id$="-lemma"]')[i];
    for (const [from, key, to] of [
      [0, 'ArrowRight', 1],
      [1, 'ArrowRight', 2],
      [2, 'ArrowRight', 3],
      [3, 'ArrowLeft', 2],
    ]) {
      const input = lemma(from);
      input.focus();
      input.selectionStart = input.selectionEnd = key === 'ArrowRight' ? input.value.length : 0;
      press(input, key);
      expect(document.activeElement?.id).toBe(lemma(to).id);
    }
    // Down from LEMMA still reaches XPOS in the same column.
    const first = lemma(1);
    first.focus();
    press(first, 'ArrowDown');
    expect(document.activeElement?.id).toBe('t2-xpos');
    await unmount();
  });
});
