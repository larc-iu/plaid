import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// The header over a Respell preview counts what Apply would respell: the
// lexicon entries only while "Also respell lexicon entries" is on (LP2-19).

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
const word = (id) => ({
  id,
  kind: 'word',
  docId: 'doc1',
  docName: 'D',
  sentenceIdx: 0,
  old: 'ba',
  new: 'pa',
  morphemes: [],
});
const lex = (id) => ({ id, kind: 'lexicon', old: 'ba', new: 'pa', vocabName: 'Lexicon' });
vi.mock('./bulkRunner.js', () => ({
  planRespell: async () => ({
    rows: [word('w1'), word('w2')],
    lexiconRows: [lex('x1')],
    docs: [],
    versions: {},
    replan: async () => null,
  }),
  applyRespell: async () => ({}),
}));
const { RespellPanel } = await import('./RespellPanel.jsx');

const type = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const header = (container) =>
  all(container, 'span').find((s) => /^\d+ match/.test(s.textContent)).textContent;

describe('RespellPanel header', () => {
  it('leaves the lexicon entries out of the count while they are not included', async () => {
    const { container, unmount } = await renderComponent(
      <MemoryRouter>
        <RespellPanel
          project={{ id: 'p1', vocabs: [] }}
          projectId="p1"
          client={{}}
          layerInfo={{}}
        />
      </MemoryRouter>,
    );
    await act(async () => type(container.querySelector('#bulk-find'), 'b'));
    await act(async () => type(container.querySelector('#bulk-repl'), 'p'));
    const preview = all(container, 'button').find((b) => b.textContent === 'Preview');
    await act(async () => preview.click());
    await vi.waitFor(() => expect(header(container)).toBe('2 matches in 1 document, 2 selected'));

    const box = all(container, 'label')
      .find((l) => l.textContent.includes('Also respell lexicon entries'))
      .querySelector('input[type="checkbox"]');
    await act(async () => box.click());
    expect(header(container)).toBe('3 matches in 1 document, 3 selected');
    await unmount();
  });
});
