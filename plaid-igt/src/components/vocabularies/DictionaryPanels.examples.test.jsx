import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// An entry's examples are references into documents, looked up when the entry
// is shown. A document of a project the viewer cannot open answers 403 without
// `unresolved`: the example is there, the viewer cannot see it, and it is not
// theirs to remove (SEAM-3). A document that is gone answers 404 (an admin) or
// 403 with `unresolved` (anyone else), and the example reads as gone, with
// Remove for a maintainer.

const load = vi.hoisted(() => ({ byDoc: {} }));
vi.mock('./vocabConcordance', () => ({
  sentenceTo: (projectId, docId, sentenceId) => `/projects/${projectId}/${docId}/${sentenceId}`,
  loadConcordanceGroups: async (client, tokenIds, [[docId]]) => {
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
    const view = await mount({ canManage: true, linkedTokenIds: new Set(['t-ok']) });
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
