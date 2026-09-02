import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@/test/renderComponent.jsx';
import { ProjectValidation } from './ProjectValidation.jsx';

// The Validation tab's own logic: which fields it decides are governed, that it
// finds violations WITHOUT loading a document, that a metadata field goes down
// the other query path, and that a failed query says so instead of hanging.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  humanizeError: (e) => String(e),
}));

const LEIPZIG = { delimiters: '.', mode: 'closed', values: [{ value: 'PL' }, { value: '1SG' }] };

// A project with one governed morpheme field and one governed metadata field.
const project = {
  id: 'p-1',
  config: {
    igt: {
      tagsets: {
        Leipzig: LEIPZIG,
        Genres: { delimiters: '', mode: 'closed', values: [{ value: 'Song' }] },
      },
      documentMetadata: [{ name: 'Genre', tagset: 'Genres' }],
    },
  },
  textLayers: [
    {
      id: 'tl-1',
      config: { plaid: { role: 'baseline' } },
      tokenLayers: [
        {
          id: 'ml-1',
          config: { plaid: { role: 'morpheme' } },
          spanLayers: [
            {
              id: 'msl-0',
              name: 'Gloss',
              config: { igt: { scope: 'Morpheme', tagset: 'Leipzig' } },
            },
          ],
        },
      ],
    },
  ],
};

/** A client whose `query` answers each aggregate with canned [value, count] rows. */
const clientWith = (rowsByCall) => {
  let i = 0;
  return { query: vi.fn(async () => ({ results: rowsByCall[i++] ?? [] })) };
};

const render = (client) =>
  renderComponent(
    <MemoryRouter>
      <ProjectValidation
        project={project}
        projectId="p-1"
        client={client}
        onProjectUpdate={vi.fn()}
      />
    </MemoryRouter>,
  );

describe('the scan', () => {
  it('lists the values a tagset refuses, and stays quiet about the ones it allows', async () => {
    const client = clientWith([
      [
        ['1SG.PL', 7],
        ['1SG.ABL', 3],
      ],
      [['Song', 4]],
    ]);
    const { container, unmount } = await render(client);
    expect(container.textContent).toContain('1SG.ABL');
    expect(container.textContent).not.toContain('1SG.PL');
    expect(container.textContent).toContain('3 occurrences');
    await unmount();
  });

  it('finds them without loading a single document', async () => {
    // The whole point of the two-phase design: one aggregate query per governed
    // field, and documents only when a specific value is opened.
    const client = clientWith([[['1SG.ABL', 3]], []]);
    client.documents = { get: vi.fn() };
    const { unmount } = await render(client);
    expect(client.documents.get).not.toHaveBeenCalled();
    await unmount();
  });

  it('scans metadata fields too, on their own query path', async () => {
    const client = clientWith([[], [['Ballad', 2]]]);
    const { container, unmount } = await render(client);
    expect(container.textContent).toContain('Ballad');
    expect(container.textContent).toContain('document');
    // Two governed fields, so two aggregate queries: one span, one metadata.
    expect(client.query).toHaveBeenCalledTimes(2);
    await unmount();
  });

  it('says everything is clean when it is', async () => {
    const client = clientWith([[['1SG.PL', 7]], [['Song', 4]]]);
    const { container, unmount } = await render(client);
    expect(container.textContent).toContain('is in its tagset');
    await unmount();
  });

  it('reports a failed query instead of sitting on a spinner', async () => {
    const { notifyError } = await import('@/utils/feedback');
    notifyError.mockClear();
    const client = { query: vi.fn(async () => Promise.reject(new Error('boom'))) };
    const { container, unmount } = await render(client);
    // Positive assertions, so this cannot pass by rendering nothing: the scan
    // settled (no spinner), it told the user, and the page still stands.
    expect(container.textContent).not.toContain('Checking values');
    expect(notifyError).toHaveBeenCalled();
    expect(container.textContent).toContain('Re-check');
    await unmount();
  });
});

describe('what it offers to do about a violation', () => {
  it('gives both remedies: add the tag, or go fix the values', async () => {
    // Which one is right is a judgement about the data, so it offers both
    // rather than choosing.
    const client = clientWith([[['1SG.ABL', 3]], []]);
    const { container, unmount } = await render(client);
    const labels = all(container, 'button, a').map((n) => n.textContent);
    expect(labels.some((t) => t.includes('Add to tagset'))).toBe(true);
    expect(labels.some((t) => t.includes('Fix in Bulk Edit'))).toBe(true);
    await unmount();
  });

  it('offers "Add to tagset" only for an unknown part, not a stray delimiter', async () => {
    // There is no tag to add for "1SG." — the value just has a trailing
    // delimiter, and the fix is to edit it.
    const client = clientWith([[['1SG.', 2]], []]);
    const { container, unmount } = await render(client);
    expect(container.textContent).toContain('delimiter with nothing');
    const labels = all(container, 'button, a').map((n) => n.textContent);
    expect(labels.some((t) => t.includes('Add to tagset'))).toBe(false);
    await unmount();
  });

  it('says so when no field uses a tagset at all', async () => {
    const bare = { ...project, config: { igt: {} } };
    const { container, unmount } = await renderComponent(
      <MemoryRouter>
        <ProjectValidation project={bare} projectId="p-1" client={clientWith([])} />
      </MemoryRouter>,
    );
    expect(container.textContent).toContain('No field uses a tagset yet');
    await unmount();
  });
});
