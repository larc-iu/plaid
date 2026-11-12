import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// Respelling an entry renames it, which only a maintainer of the
// vocabulary's project may do. A vocabulary this project borrows is read only
// here. The entries a person may not respell are listed, marked
// "maintainers only", with a tooltip naming who can.

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
const asked = vi.hoisted(() => ({ canRespellIn: null }));
const lex = (id, vocabId, locked) => ({
  id,
  kind: 'lexicon',
  vocabId,
  old: 'ba',
  new: 'pa',
  vocabName: vocabId === 'v-own' ? 'Lexicon' : 'Roots',
  ...(locked ? { locked: true } : {}),
});
vi.mock('./bulkRunner.js', () => ({
  planRespell: async (_client, _project, _layerInfo, { canRespellIn }) => {
    asked.canRespellIn = canRespellIn;
    return {
      rows: [],
      lexiconRows: [lex('x1', 'v-own', true), lex('x2', 'v-borrowed', true)],
      docs: [],
      versions: {},
      replan: async () => null,
    };
  },
  applyRespell: async () => ({}),
}));
const { RespellPanel } = await import('./RespellPanel.jsx');

const type = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const OWN = { id: 'v-own', name: 'Lexicon', project: 'p1' };
const BORROWED = { id: 'v-borrowed', name: 'Roots', project: 'p2' };

const preview = async (roles) => {
  const view = await renderComponent(
    <MemoryRouter>
      <RespellPanel
        project={{ id: 'p1', name: 'Story', ...roles, vocabs: [OWN, BORROWED] }}
        projectId="p1"
        client={{}}
        layerInfo={{}}
      />
    </MemoryRouter>,
  );
  await act(async () => type(view.container.querySelector('#bulk-find'), 'b'));
  await act(async () => type(view.container.querySelector('#bulk-repl'), 'p'));
  const button = all(view.container, 'button').find((b) => b.textContent === 'Preview');
  await act(async () => button.click());
  await vi.waitFor(() => expect(asked.canRespellIn).not.toBe(null));
  return view;
};

describe('RespellPanel and who may respell an entry', () => {
  it('lets a maintainer of the project respell its own vocabulary, never a borrowed one', async () => {
    const view = await preview({ maintainers: ['u1'] });
    expect(asked.canRespellIn(OWN)).toBe(true);
    expect(asked.canRespellIn(BORROWED)).toBe(false);
    await view.unmount();
  });

  it('lets a writer of the project respell nothing', async () => {
    const view = await preview({ writers: ['u1'] });
    expect(asked.canRespellIn(OWN)).toBe(false);
    await view.unmount();
  });

  it('marks a kept entry "maintainers only", with a tooltip naming the project or saying it belongs to another', async () => {
    const view = await preview({ writers: ['u1'] });
    await vi.waitFor(() =>
      expect(
        all(view.container, 'span').some((s) => s.textContent.includes('maintainers only')),
      ).toBe(true),
    );
    const marks = all(view.container, '[title]').filter((s) =>
      s.textContent.includes('maintainers only'),
    );
    expect(marks.map((s) => s.getAttribute('title'))).toEqual([
      'Needs a maintainer of “Story”.',
      'This vocabulary belongs to another project.',
    ]);
    await view.unmount();
  });
});
