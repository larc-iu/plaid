import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { refusal } from '../../../../../plaid-client-js/src/testing.js';

// Respelling an entry renames it, which only a maintainer of the
// vocabulary's project may do, wherever they stand. For a vocabulary this
// project borrows, its project is read. The entries a person may not respell
// are listed: "maintainers only" with a tooltip naming the project when they
// can read it, else "read only", since it belongs to another project.

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

// `projects.get` as core answers it: p2 ("Roots home") with `homeRoles` to
// a member, else 403. Each id asked is kept in `reads`.
let reads = [];
const client = (homeRoles = {}) => ({
  projects: {
    get: async (id) => {
      reads.push(id);
      const p = id === 'p2' ? { id: 'p2', name: 'Roots home', ...homeRoles } : null;
      const member = [p?.maintainers, p?.writers, p?.readers].some((l) => l?.includes('u1'));
      if (!p || !member) throw refusal(403, { error: 'Forbidden' });
      return p;
    },
  },
});

const preview = async (roles, homeRoles) => {
  reads = [];
  asked.canRespellIn = null;
  const view = await renderComponent(
    <MemoryRouter>
      <RespellPanel
        project={{ id: 'p1', name: 'Story', ...roles, vocabs: [OWN, BORROWED] }}
        projectId="p1"
        client={client(homeRoles)}
        layerInfo={{}}
      />
    </MemoryRouter>,
  );
  await vi.waitFor(() => expect(reads).toEqual(['p2']));
  await act(async () => {});
  await act(async () => type(view.container.querySelector('#bulk-find'), 'b'));
  await act(async () => type(view.container.querySelector('#bulk-repl'), 'p'));
  const button = all(view.container, 'button').find((b) => b.textContent === 'Preview');
  await act(async () => button.click());
  await vi.waitFor(() => expect(asked.canRespellIn).not.toBe(null));
  return view;
};

describe('RespellPanel and who may respell an entry', () => {
  it('lets a maintainer of the project respell its own vocabulary', async () => {
    const view = await preview({ maintainers: ['u1'] });
    expect(asked.canRespellIn(OWN)).toBe(true);
    expect(asked.canRespellIn(BORROWED)).toBe(false);
    await view.unmount();
  });

  it("lets a maintainer of a borrowed vocabulary's project respell it", async () => {
    const view = await preview({ maintainers: ['u1'] }, { maintainers: ['u1'] });
    expect(asked.canRespellIn(BORROWED)).toBe(true);
    await view.unmount();
  });

  for (const role of ['writers', 'readers']) {
    it(`lets one of the ${role} of a borrowed vocabulary's project respell nothing in it`, async () => {
      const view = await preview({ maintainers: ['u1'] }, { [role]: ['u1'] });
      expect(asked.canRespellIn(BORROWED)).toBe(false);
      await view.unmount();
    });
  }

  it('lets a writer of the project respell nothing', async () => {
    const view = await preview({ writers: ['u1'] });
    expect(asked.canRespellIn(OWN)).toBe(false);
    await view.unmount();
  });

  const marks = (view) =>
    all(view.container, '[title]')
      .filter((s) => /maintainers only|read only/.test(s.textContent))
      .map((s) => [s.textContent.replace(/^ · /, ''), s.getAttribute('title')]);

  it('marks a kept entry "maintainers only" naming the project, or "read only" when it belongs to another', async () => {
    const view = await preview({ writers: ['u1'] });
    await vi.waitFor(() => expect(marks(view)).toHaveLength(2));
    expect(marks(view)).toEqual([
      ['maintainers only', 'Needs a maintainer of “Story”.'],
      ['read only', 'This vocabulary belongs to another project.'],
    ]);
    await view.unmount();
  });

  it("names a borrowed vocabulary's project to someone who reads it", async () => {
    const view = await preview({ maintainers: ['u1'] }, { writers: ['u1'] });
    await vi.waitFor(() => expect(marks(view)).toHaveLength(2));
    expect(marks(view)[1]).toEqual(['maintainers only', 'Needs a maintainer of “Roots home”.']);
    await view.unmount();
  });
});
