import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// The Compare tab reads the report beside the live documents. A sentence
// edited since the comparison used to show its new graph beside the old
// scores with nothing said, and nothing on the report led to a node.

// Stable across renders, as the real context's are: the tab's effects
// depend on them.
const state = { doc: null, other: null };
const project = { name: 'P' };
const client = { projects: { listDocuments: async () => [] } };
vi.mock('@ui/hooks/useDocumentEditor.js', () => ({
  useDocumentEditor: () => ({
    projectId: 'p1',
    documentId: 'd1',
    doc: state.doc,
    project,
    services: {},
    writeLockHeld: null,
  }),
}));
vi.mock('@ui/hooks/useDocumentTitle.js', () => ({ useDocumentTitle: () => {} }));
vi.mock('../../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: null, getClient: () => client }),
}));
vi.mock('../../domain/UmrDocument.js', () => ({
  UmrDocument: { load: async () => state.other },
}));

const { CompareEditor } = await import('./CompareEditor.jsx');

const AT = '2026-09-28T05:22:03Z';

const documentWith = (thisGraph, otherGraph, live) => ({
  name: 'Lunch',
  raw: {
    metadata: {
      umr: {
        adjudication: {
          version: 4,
          tool: 'ancast 1.0',
          against: { id: 'd2', name: 'lunch' },
          at: AT,
          scope: 'doc',
          sentenceCount: 1,
          scores: { sentence: 1, modal: null, temporal: null, coref: null, comprehensive: 1 },
        },
      },
    },
  },
  layerInfo: {
    sentenceTokenLayer: {
      tokens: [
        {
          begin: 0,
          metadata: {
            umr: {
              adjudication: {
                at: AT,
                index: 1,
                concept: 1,
                labeled: 1,
                unlabeled: 1,
                weighted: 1,
                smatch: 1,
                matches: [['s1s', 's1s', 'school', 'college', false]],
                unmatched: [],
                unmatchedOther: [],
                skipped: null,
                thisGraph,
                otherGraph,
              },
            },
          },
        },
      ],
    },
  },
  sentences: [{ index: 1, text: 'The boy goes to school' }],
  penmanOf: () => live,
});

const mount = async (doc, otherGraph) => {
  state.doc = doc;
  state.other = { penmanOf: () => otherGraph };
  const r = await renderComponent(
    <MemoryRouter>
      <CompareEditor />
    </MemoryRouter>,
  );
  // Let the other document's load settle.
  await r.step(async () => {});
  return r;
};

describe('CompareEditor', () => {
  it('marks a sentence whose graph changed since the comparison', async () => {
    const r = await mount(
      documentWith('(s1s / school)', '(s1s / college)', '(s1s / university)'),
      '(s1s / college)',
    );
    expect(r.container.querySelector('[data-changed-since]')?.textContent).toBe(
      'Changed since this comparison.',
    );
  });

  it('marks a sentence the other document changed since', async () => {
    const r = await mount(
      documentWith('(s1s / school)', '(s1s / college)', '(s1s / school)'),
      '(s1s / university)',
    );
    expect(r.container.querySelector('[data-changed-since]')).not.toBeNull();
  });

  it('says nothing of a sentence neither side has changed', async () => {
    const r = await mount(
      documentWith('(s1s / school)', '(s1s / college)', '(s1s / school)'),
      '(s1s / college)',
    );
    expect(r.container.querySelector('[data-changed-since]')).toBeNull();
  });

  it('links the sentence number and each marked variable to Annotate on that node', async () => {
    const r = await mount(
      documentWith('(s1s / school)', '(s1s / college)', '(s1s / school)'),
      '(s1s / college)',
    );
    const hrefs = [...r.container.querySelectorAll('[data-compare-sentence] a')].map((a) =>
      a.getAttribute('href'),
    );
    expect(hrefs).toEqual([
      '/projects/p1/documents/d1/annotate?sent=1',
      '/projects/p1/documents/d1/annotate?sent=1&var=s1s',
      '/projects/p1/documents/d2/annotate?sent=1&var=s1s',
    ]);
  });
});
