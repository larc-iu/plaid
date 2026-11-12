import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { fakeClient, refusal } from '../../../../plaid-client-js/src/testing.js';
import { settle } from '@/domain/test-helpers.js';

// Ruling 11.3: a maintainer of a vocabulary's project sees the projects that
// link it and can end each borrowing, a project they cannot read included,
// unnamed. The confirm says how many links go, from the unlink's dry run, and
// opening it sends that dry run and nothing else. Read as the real client
// sends it.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  humanizeError: (e) => String(e),
}));
const confirm = vi.hoisted(() => vi.fn(async () => false));
vi.mock('@ui/components/shared/ConfirmProvider', () => ({ useConfirm: () => confirm }));

const { VocabularyBorrowers } = await import('./VocabularyBorrowers.jsx');
const feedback = await import('@/utils/feedback');

const VOCAB = { id: 'V', name: 'Lexicon', project: 'A' };

const server = ({ borrowers, links = {}, unlink } = {}) => {
  let list = structuredClone(borrowers);
  return fakeClient({
    answer: (req) => {
      if (req.kind === 'vocabLayers.borrowers') return structuredClone(list);
      if (req.kind === 'projects.unlinkVocab') {
        const [pid] = req.args;
        if (req.query['dry-run']) return { links: links[pid] ?? 0 };
        unlink?.(pid);
        list = list.filter((b) => b.id !== pid);
        return {};
      }
      if (req.kind === 'vocabLayers.get') return { ...VOCAB, items: [] };
      if (req.kind === 'query') return { results: [] };
      return undefined;
    },
  });
};

// The home as its maintainer reads it.
const HOME = { id: 'A', maintainers: ['u'], writers: [], readers: [] };

const mount = async (client, home = HOME) => {
  const view = await renderComponent(
    <MemoryRouter>
      <VocabularyBorrowers client={client} user={{ id: 'u' }} vocabulary={VOCAB} home={home} />
    </MemoryRouter>,
  );
  await view.step(() => settle(3));
  return view;
};
const rows = () => all(document.body, 'li').map((li) => li.textContent);
const unlinkOf = (label) =>
  all(document.body, 'button').find((b) => b.getAttribute('aria-label') === label);
const sentSince = (client, n) =>
  client.requests.slice(n).map((r) =>
    r.operations
      ? [
          r.method,
          r.path,
          // An op's path carries its operation's group, and nothing else.
          r.operations.map((o) => {
            const [path, query = ''] = o.path.split('?');
            return [o.method, path, query.includes('dry-run')];
          }),
        ]
      : [r.method, r.path, r.query],
  );

beforeEach(() => {
  vi.clearAllMocks();
  confirm.mockImplementation(async () => false);
});

describe('the projects that use a vocabulary', () => {
  it('names those the person can read, and only counts the rest', async () => {
    const client = server({
      borrowers: [
        { id: 'B', name: 'Beeworth' },
        { id: 'X', name: null },
        { id: 'Y', name: null },
      ],
    });
    const view = await mount(client);
    expect(rows()).toEqual(['BeeworthUnlink', 'Another projectUnlink', 'Another projectUnlink']);
    const link = all(document.body, 'a').find((a) => a.textContent === 'Beeworth');
    expect(link.getAttribute('href')).toBe('/projects/B');
    expect(document.body.textContent).not.toContain('X');
    await view.unmount();
  });

  it('says so when no other project uses it', async () => {
    const view = await mount(server({ borrowers: [] }));
    expect(document.body.textContent).toContain('No other project uses this vocabulary.');
    await view.unmount();
  });

  it('sends only the dry run when the confirm opens, and says how many links go', async () => {
    const client = server({ borrowers: [{ id: 'B', name: 'Beeworth' }], links: { B: 14 } });
    const view = await mount(client);
    const before = client.requests.length;
    await view.step(async () => {
      unlinkOf('Unlink from Beeworth').click();
      await settle(5);
    });
    expect(sentSince(client, before)).toEqual([
      ['DELETE', '/api/v1/projects/B/vocabs/V', { 'dry-run': 'true' }],
    ]);
    expect(confirm).toHaveBeenCalledWith({
      title: 'Unlink “⁨Lexicon⁩” from “⁨Beeworth⁩”?',
      description:
        '14 words/morphemes in “⁨Beeworth⁩” are linked to its entries. Those links will be removed.',
      confirmLabel: 'Unlink',
      destructive: true,
    });
    expect(rows()).toEqual(['BeeworthUnlink']);
    await view.unmount();
  });

  it('ends the borrowing of a project the person cannot read, and lists the rest again', async () => {
    confirm.mockImplementation(async () => true);
    const ended = [];
    const client = server({
      borrowers: [
        { id: 'B', name: 'Beeworth' },
        { id: 'X', name: null },
      ],
      unlink: (pid) => ended.push(pid),
    });
    const view = await mount(client);
    const before = client.requests.length;
    await view.step(async () => {
      all(document.body, 'button')
        .filter((b) => b.getAttribute('aria-label') === 'Unlink from another project')[0]
        .click();
      await settle(10);
    });
    expect(confirm).toHaveBeenCalledWith({
      title: 'Unlink “⁨Lexicon⁩” from another project?',
      description: '',
      confirmLabel: 'Unlink',
      destructive: true,
    });
    expect(sentSince(client, before)).toEqual([
      ['DELETE', '/api/v1/projects/X/vocabs/V', { 'dry-run': 'true' }],
      ['POST', '/api/v1/batch', [['DELETE', '/api/v1/projects/X/vocabs/V', false]]],
      ['GET', '/api/v1/vocab-layers/V/borrowers', {}],
    ]);
    expect(ended).toEqual(['X']);
    expect(rows()).toEqual(['BeeworthUnlink']);
    await view.unmount();
  });

  it('says a link count in another project without naming it', async () => {
    const client = server({ borrowers: [{ id: 'X', name: null }], links: { X: 1 } });
    const view = await mount(client);
    await view.step(async () => {
      unlinkOf('Unlink from another project').click();
      await settle(5);
    });
    expect(confirm.mock.calls[0][0].description).toBe(
      '1 word/morpheme in that project is linked to its entries. Those links will be removed.',
    );
    await view.unmount();
  });

  it('puts the project back when the unlink is refused', async () => {
    confirm.mockImplementation(async () => true);
    const client = fakeClient({
      answer: (req) => {
        if (req.kind === 'vocabLayers.borrowers') return [{ id: 'X', name: null }];
        if (req.kind === 'projects.unlinkVocab' && !req.query['dry-run'])
          throw refusal(403, { error: 'Forbidden' });
        if (req.kind === 'projects.unlinkVocab') return { links: 0 };
        return undefined;
      },
    });
    const view = await mount(client);
    await view.step(async () => {
      unlinkOf('Unlink from another project').click();
      await settle(10);
    });
    expect(feedback.notifyError).toHaveBeenCalledWith(
      expect.anything(),
      'Failed to unlink the vocabulary',
    );
    expect(rows()).toEqual(['Another projectUnlink']);
    await view.unmount();
  });

  it('offers no Unlink to someone who does not maintain its project', async () => {
    const client = server({ borrowers: [{ id: 'B', name: 'Beeworth' }] });
    await mount(client, { id: 'A', maintainers: [], writers: ['u'], readers: [] });
    expect(rows()).toEqual(['Beeworth']);
    expect(unlinkOf('Unlink from Beeworth')).toBeUndefined();
  });
});
