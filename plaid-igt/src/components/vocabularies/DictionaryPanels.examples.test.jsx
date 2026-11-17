import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// An entry's examples are references into documents, looked up when the entry
// is shown. A document of a project the viewer cannot open answers 403 without
// `unresolved`: the example is there, the viewer cannot see it, and it is not
// theirs to remove (SEAM-3). A document that is gone answers 404 (an admin) or
// 403 with `unresolved` (anyone else), and the example reads as gone, with
// Remove for a maintainer.

const load = vi.hoisted(() => ({ byDoc: {}, options: [] }));
vi.mock('./vocabConcordance', () => ({
  sentenceTo: (projectId, docId, sentenceId) => `/projects/${projectId}/${docId}/${sentenceId}`,
  loadConcordanceGroups: async (client, tokenIds, [[docId]], options) => {
    load.options.push(options);
    const answer = load.byDoc[docId];
    if (answer instanceof Error) throw answer;
    return [answer];
  },
}));

const { ExamplesPanel } = await import('./DictionaryPanels.jsx');

const failure = (status, body) =>
  Object.assign(new Error(`HTTP ${status} ${body.error}`), {
    status,
    method: 'GET',
    responseData: body,
  });
const LACKS = 'User b@x.org lacks sufficient privileges to read the project this entity belongs to';

const GONE_TEXT = 'This example no longer exists, or its word is no longer linked to this entry.';
const REFUSED_TEXT = 'This example is in a document you cannot open.';

const item = {
  id: 'e1',
  form: 'tsu',
  metadata: {
    examples: [
      { document: 'd-ok', token: 't-ok' },
      { document: 'd-theirs', token: 't-theirs' },
      { document: 'd-deleted', token: 't-deleted' },
      { document: 'd-admin-gone', token: 't-admin-gone' },
    ],
  },
};

const mount = (props) =>
  renderComponent(
    <MemoryRouter>
      <ExamplesPanel item={item} client={{}} onRemove={() => {}} {...props} />
    </MemoryRouter>,
  );

const rows = (root) => all(root, 'ol > li');

describe('ExamplesPanel, an example the viewer cannot open', () => {
  load.byDoc = {
    'd-ok': {
      projectId: 'p1',
      docName: 'Story',
      rows: [
        { sentenceId: 's1', sentenceIndex: 0, text: 'kai tsu', marks: [], tokenIds: ['t-ok'] },
      ],
    },
    'd-theirs': failure(403, { error: LACKS }),
    'd-deleted': failure(403, { error: LACKS, unresolved: true }),
    'd-admin-gone': failure(404, { error: 'Document not found' }),
  };

  it('says the document cannot be opened and offers no Remove', async () => {
    // The concordance reads only projects the viewer can open, so the
    // refused example's token is not among the linked ones either.
    const view = await mount({ canEdit: true, linkedTokenIds: new Set(['t-ok']) });
    await view.step(() => new Promise((r) => setTimeout(r, 0)));
    const [ok, theirs, deleted, adminGone] = rows(view.container);
    expect(ok.textContent).toContain('Story');
    expect(ok.querySelector('[aria-label="Remove example"]')).not.toBeNull();
    expect(theirs.textContent).toContain(REFUSED_TEXT);
    expect(theirs.textContent).not.toContain('no longer exists');
    expect(theirs.querySelector('[aria-label="Remove example"]')).toBeNull();
    expect(deleted.textContent).toContain(GONE_TEXT);
    expect(deleted.querySelector('[aria-label="Remove example"]')).not.toBeNull();
    expect(adminGone.textContent).toContain(GONE_TEXT);
    expect(adminGone.querySelector('[aria-label="Remove example"]')).not.toBeNull();
    await view.unmount();
  });
});

// GH #68: an example of a morpheme entry picks the morpheme out in its word,
// as the Concordance tab on the same page does.
describe('ExamplesPanel, a morpheme example', () => {
  it('asks for the morpheme detail and stacks a segmented word', async () => {
    load.byDoc['d-morph'] = {
      projectId: 'p1',
      docName: 'Matthew 1',
      rows: [
        {
          sentenceId: 's1',
          sentenceIndex: 0,
          text: 'Ukunguut nengllugutet .',
          marks: [{ begin: 0, end: 8 }],
          stacks: [
            {
              begin: 0,
              end: 8,
              parts: [
                { joiner: null, form: 'uku', hit: false },
                { joiner: '-', form: 'nge', hit: true },
                { joiner: '-', form: 'ut', hit: false },
              ],
            },
          ],
          tokenIds: ['t-m'],
        },
      ],
    };
    load.options.length = 0;
    const view = await mount({
      item: {
        id: 'e2',
        form: 'ngu',
        metadata: { examples: [{ document: 'd-morph', token: 't-m' }] },
      },
      linkedTokenIds: new Set(['t-m']),
    });
    await view.step(() => new Promise((r) => setTimeout(r, 0)));
    expect(load.options).toEqual([{ morphemes: true }]);
    const stack = view.container.querySelector('[data-stack]');
    expect(stack.querySelector('mark').textContent).toBe('Ukunguut');
    expect(stack.querySelector('[data-segmentation]').textContent).toBe('uku-nge-ut');
    await view.unmount();
  });
});
