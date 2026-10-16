import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all, byText, texts } from '@ui/test/renderComponent.jsx';
import { ProjectValidation } from './ProjectValidation.jsx';
import { notifyError, notifySuccess, notifyWarning } from '@/utils/feedback';
import { MIXED, hitsClient } from './cellReadingFixture.js';

// The Validation tab's own logic: which fields it decides are governed, that it
// finds violations WITHOUT loading a document, that a metadata field goes down
// the other query path, and that a failed query says so instead of hanging.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
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

/**
 * A client whose `query` answers each aggregate with canned [value, count]
 * rows. A morpheme field's linked-morpheme query takes `linked` instead and
 * uses up no canned answer, so the field's rows go to its unlinked query.
 */
const clientWith = (rowsByCall, linked = []) => {
  let i = 0;
  const links = (q) => (q?.where || []).filter((c) => c[0] === 'vocab-link').length;
  return {
    query: vi.fn(async (q) => {
      // Two link clauses ask for morphemes linked twice: there are none here.
      if (links(q) === 2) return { results: [] };
      return { results: links(q) === 1 ? linked : (rowsByCall[i++] ?? []) };
    }),
  };
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
    // Two governed fields: the morpheme field's linked and unlinked queries
    // and the metadata one, plus the morpheme-form sweep the zero-morph check runs.
    expect(client.query).toHaveBeenCalledTimes(5);
    await unmount();
  });

  it('lists the values an OPEN list does not hold, without calling them errors', async () => {
    const open = {
      ...project,
      config: {
        igt: {
          ...project.config.igt,
          tagsets: { ...project.config.igt.tagsets, Leipzig: { ...LEIPZIG, mode: 'suggest' } },
        },
      },
    };
    const client = clientWith([[['1SG.ABL', 3]], [['Song', 4]]]);
    const { container, unmount } = await renderComponent(
      <MemoryRouter>
        <ProjectValidation
          project={open}
          projectId="p-1"
          client={client}
          onProjectUpdate={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(container.textContent).toContain('1SG.ABL');
    expect(container.textContent).toContain('1 not in the tagset');
    // Only the clean metadata field reads as clean.
    expect(container.textContent.match(/All in the tagset/g)).toHaveLength(1);
    expect(container.textContent).not.toContain('outside the tagset');
    expect(container.textContent).not.toContain('is in its tagset');
    expect(byText(container, 'button', 'Add to tagset')).toBeTruthy();
    await unmount();
  });

  it("puts an open list's word-like values in a closed group with no Add, and counts red only what the cells mark", async () => {
    const open = {
      ...project,
      config: {
        igt: {
          ...project.config.igt,
          tagsets: { ...project.config.igt.tagsets, Leipzig: { ...LEIPZIG, mode: 'suggest' } },
        },
      },
    };
    const client = clientWith([
      [
        ['dog', 9],
        ['1SG.ABL', 3],
        ['1SG.', 1],
      ],
      [['Song', 4]],
    ]);
    const { container, step, unmount } = await renderComponent(
      <MemoryRouter>
        <ProjectValidation
          project={open}
          projectId="p-1"
          client={client}
          onProjectUpdate={vi.fn()}
        />
      </MemoryRouter>,
    );
    const text = () => container.textContent;
    // The stray delimiter is the one value the cell marks.
    expect(text()).toContain('1 outside the tagset');
    expect(text()).toContain('2 not in the tagset');
    expect(text()).toContain('1SG.ABL');
    const group = byText(container, 'button', 'not written in capitals');
    expect(group.textContent).toContain('1 not written in capitals');
    expect(group.getAttribute('aria-expanded')).toBe('false');
    expect(text()).not.toMatch(/\bdog\b/);
    await step(() => group.click());
    expect(text()).toMatch(/\bdog\b/);
    // Add to tagset stays on the tag's row only.
    const adds = all(container, 'button').filter((b) => b.textContent.includes('Add to tagset'));
    expect(adds.map((b) => b.title)).toEqual(['Add ABL to Leipzig']);
    await unmount();
  });

  it('says everything is clean when it is', async () => {
    const client = clientWith([[['1SG.PL', 7]], [['Song', 4]]]);
    const { container, unmount } = await render(client);
    expect(container.textContent).toContain('is in its tagset');
    await unmount();
  });

  it('flags a morpheme form that looks like a zero written another way', async () => {
    // Third call is the morpheme-form sweep: two governed fields come first.
    const client = clientWith([
      [],
      [],
      [
        ['dog', 12],
        ['\u00d8', 4],
        ['0', 1],
        ['\u2205', 30],
      ],
    ]);
    const { container, unmount } = await render(client);
    expect(container.textContent).toContain('looks like a zero morph');
    expect(container.textContent).toContain('2 forms to check');
    // The real zero and an ordinary form are both left alone.
    expect(container.textContent).not.toContain('dog');
    await unmount();
  });

  it('says nothing about zero morphs when every form is fine', async () => {
    const client = clientWith([
      [],
      [],
      [
        ['dog', 12],
        ['\u2205', 30],
      ],
    ]);
    const { container, unmount } = await render(client);
    expect(container.textContent).not.toContain('looks like a zero morph');
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
    expect(container.textContent).toContain('Check again');
    // The header every app's Validation tab wears.
    expect(container.querySelector('h2')?.textContent).toBe('Validation');
    await unmount();
  });
});

describe('a morpheme field', () => {
  // A mixed Leipzig tagset: the grid holds a suffix's sbj:3.pfv to the list and
  // lets a stem's through, and so must the scan.
  const mixed = {
    ...project,
    config: {
      igt: {
        ...project.config.igt,
        tagsets: { ...project.config.igt.tagsets, Leipzig: { ...LEIPZIG, mode: 'mixed' } },
      },
    },
  };

  it("reads each value by its morph type and form, and flags only a suffix's occurrences", async () => {
    const client = clientWith(
      [
        [
          ['sbj:3.pfv', 'stem', 'sa', 9],
          ['go.PL', 'stem', 'ka', 6],
        ],
        [['Song', 4]],
      ],
      // Linked to a suffix entry, though the token's cached type still says stem.
      [['sbj:3.pfv', 'suffix', null, 'stem', 'ti', 4]],
    );
    const { container, unmount } = await renderComponent(
      <MemoryRouter>
        <ProjectValidation project={mixed} projectId="p-1" client={client} />
      </MemoryRouter>,
    );
    expect(container.textContent).toContain('sbj:3.pfv');
    expect(container.textContent).toContain('4 occurrences');
    expect(container.textContent).toContain('"sbj:3", "pfv" not in the tagset');
    expect(container.textContent).toContain('2 distinct values');
    expect(container.textContent).not.toContain('go.PL');
    await unmount();
  });
});

describe('opening a morpheme field value', () => {
  // The scan sees one failing sbj:3.pfv, the suffix's. The document holds it
  // three times: the suffix's, a stem's alone in its word (passes) and a stem's
  // beside another stem (fails in the grid, which the scan cannot see).
  const mixed = {
    ...project,
    config: {
      igt: { ...project.config.igt, tagsets: { ...project.config.igt.tagsets, Leipzig: MIXED } },
    },
  };
  const client = (docIds = ['doc-1']) => {
    const gloss = [
      ['sbj:3.pfv', 'suffix', 'ti', 1],
      ['sbj:3.pfv', 'stem', 'sa', 1],
      ['sbj:3.pfv', 'stem', 'bu', 1],
      ['go', 'stem', 'ka', 1],
      ['dog', 'stem', 'har', 1],
    ];
    // Each scan asks for the Gloss rows, the metadata rows and the forms.
    const scan = clientWith([gloss, [], [], gloss, [], []]);
    const hits = hitsClient(docIds);
    return {
      query: vi.fn(async (q) =>
        q?.return?.group?.[0] === '?d' || q?.find?.[0] === '?s' ? hits.query(q) : scan.query(q),
      ),
      documents: hits.documents,
    };
  };

  const open = async (c) => {
    const view = await renderComponent(
      <MemoryRouter>
        <ProjectValidation project={mixed} projectId="p-1" client={c} />
      </MemoryRouter>,
    );
    expect(view.container.textContent).toContain('1 occurrence ·');
    const toggle = all(view.container, 'button[title="Show occurrences"]')[0];
    await view.step(() => toggle.click());
    return view;
  };

  it('lists only the occurrences the grid flags, and counts those', async () => {
    const { container, unmount } = await open(client());
    const rows = texts(container, 'a[href*="doc-1"]');
    expect(rows).toEqual(['1kati', '3harbu']);
    // The document's count and the row's are the two listed.
    expect(container.textContent).toContain('Text doc-1(2)');
    expect(container.textContent).toContain('2 occurrences ·');
    await unmount();
  });

  it('names only documents, not hits, for the documents it did not load', async () => {
    const ids = Array.from({ length: 13 }, (_, i) => `doc-${i + 1}`);
    const { container, unmount } = await open(client(ids));
    expect(container.textContent).toContain('1 more document with this value not shown.');
    // Not every document was loaded, so the scan's count stands.
    expect(container.textContent).toContain('1 occurrence ·');
    await unmount();
  });

  it("puts the scan's count back on checking again", async () => {
    const { container, step, unmount } = await open(client());
    expect(container.textContent).toContain('2 occurrences ·');
    await step(() => byText(container, 'button', 'Check again').click());
    expect(container.textContent).toContain('1 occurrence ·');
    expect(container.textContent).not.toContain('harbu');
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

// REV2-WIRE-2: a page read before another maintainer pointed a second field
// at Leipzig. Adding a part to the list puts the new list on that field too.
describe('Add to tagset', () => {
  it('declares the new list on every field the tagset governs now', async () => {
    const server = structuredClone(project);
    server.textLayers[0].tokenLayers[0].spanLayers.push({
      id: 'msl-1',
      name: 'Lex Gloss',
      config: { igt: { scope: 'Morpheme', tagset: 'Leipzig' } },
      constraints: { igt: [{ type: 'single-span' }] },
    });
    const declared = [];
    const client = {
      ...clientWith([[['1SG.ABL', 3]], [['Song', 4]]]),
      projects: {
        get: vi.fn(async () => structuredClone(server)),
        setConfig: vi.fn((_id, ns, key, value) => {
          server.config[ns][key] = value;
        }),
      },
      spanLayers: {
        setConstraints: (id, _ns, constraints) => declared.push([id, constraints]),
        repairConstraints: vi.fn(),
        refusedValues: vi.fn(async () => ({ count: 0, valueCount: 0, values: [] })),
        checkConstraints: vi.fn(async () => ({ violations: [], violationCount: 0 })),
      },
      withOperation: async (_m, fn) => fn(),
      batched: async (fn) => fn(client),
    };
    const { container, step, unmount } = await render(client);
    const add = all(container, 'button').find((b) => b.title === 'Add ABL to Leipzig');
    await step(async () => {
      add.click();
      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    });
    expect(client.projects.setConfig).toHaveBeenCalled();
    // The field in force takes it in the save's batch, the one out of force
    // (it holds no list) in the heal after it.
    expect(declared.map(([id]) => id)).toEqual(['msl-0', 'msl-1']);
    expect(client.spanLayers.repairConstraints).not.toHaveBeenCalled();
    expect(declared[1][1]).toContainEqual({
      type: 'value-set',
      values: ['PL', '1SG', 'ABL'],
      delimiters: '.',
      parts: 'all',
    });
    await unmount();
  });
});

// REV3-WIRE-5: the field moved to another tagset after the page was read.
// Nothing is added to the list it no longer uses.
describe('Add to tagset, the field moved since the page was read', () => {
  it('adds nothing and says which tagset the field uses now', async () => {
    const server = structuredClone(project);
    server.config.igt.tagsets.POS = { delimiters: '', mode: 'suggest', values: [] };
    server.textLayers[0].tokenLayers[0].spanLayers[0].config.igt.tagset = 'POS';
    const client = {
      ...clientWith([[['1SG.ABL', 3]], [['Song', 4]]]),
      projects: { get: vi.fn(async () => structuredClone(server)), setConfig: vi.fn() },
      spanLayers: { setConstraints: vi.fn() },
      batched: async (fn) => fn(client),
    };
    const { container, step, unmount } = await render(client);
    const add = all(container, 'button').find((b) => b.title === 'Add ABL to Leipzig');
    await step(async () => {
      add.click();
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
    expect(client.projects.setConfig).not.toHaveBeenCalled();
    expect(client.spanLayers.setConstraints).not.toHaveBeenCalled();
    expect(notifySuccess).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith(
      'Gloss uses “POS” now. Nothing was added.',
      'Failed to update the tagset',
    );
    await unmount();
  });
});

// A closed list the server does not hold (an unfinished import, another
// client): the tab says so and puts it in force on request, or names the
// values in the way (REV3-WIRE-2).
describe('a closed list not in force', () => {
  const held = (answer) => {
    const declared = [];
    const client = {
      ...clientWith([[['PL', 3]], [['Song', 4]]]),
      projects: { get: vi.fn(async () => structuredClone(project)) },
      spanLayers: {
        refusedValues: vi.fn(async () => answer),
        checkConstraints: vi.fn(async () => ({ violations: [], violationCount: 0 })),
        setConstraints: vi.fn(async (id, _ns, list) => declared.push([id, list])),
        repairConstraints: vi.fn(),
      },
      withOperation: async (_m, fn) => fn(),
      batched: async (fn) => fn(client),
    };
    return { client, declared };
  };
  const leipzig = { type: 'value-set', values: ['PL', '1SG'], delimiters: '.', parts: 'all' };

  it('names it, and Put in force declares it', async () => {
    vi.clearAllMocks();
    const { client, declared } = held({ count: 0, valueCount: 0, values: [] });
    const { container, step, unmount } = await render(client);
    const notice = container.querySelector('[data-testid="rules-out-of-force"]');
    expect(notice.textContent).toContain(
      'Not in force: Leipzig and one annotation a morpheme on Gloss.',
    );
    await step(async () => {
      byText(notice, 'button', 'Put in force').click();
      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    });
    expect(declared).toEqual([['msl-0', [{ type: 'single-span' }, leipzig]]]);
    expect(notifySuccess).toHaveBeenCalledWith('In force on Gloss');
    expect(notifyWarning).not.toHaveBeenCalled();
    await unmount();
  });

  it('leaves the list out and names the values in the way', async () => {
    vi.clearAllMocks();
    const { client, declared } = held({
      count: 1,
      valueCount: 1,
      values: [{ value: 'QQ', parts: ['QQ'], count: 1 }],
    });
    const { container, step, unmount } = await render(client);
    const notice = container.querySelector('[data-testid="rules-out-of-force"]');
    await step(async () => {
      byText(notice, 'button', 'Put in force').click();
      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    });
    expect(declared).toEqual([['msl-0', [{ type: 'single-span' }]]]);
    expect(notifyWarning).toHaveBeenCalledWith(
      '“Leipzig” is not in force on Gloss: 1 annotation not in the list, QQ (1). Change these values, then choose Put in force.',
      'Not in force',
    );
    expect(notifySuccess).not.toHaveBeenCalled();
    await unmount();
  });
});

// REV4-WIRE-3: each state is named for what it is, with its own action, and
// the toast says what happened. REV4-WIRE-2: Put in force changes no
// annotation, so a field that would need its annotations joined is named.
describe('rules not as the settings want, by state', () => {
  const renderWith = (client, proj) =>
    renderComponent(
      <MemoryRouter>
        <ProjectValidation
          project={proj}
          projectId="p-1"
          client={client}
          onProjectUpdate={vi.fn()}
        />
      </MemoryRouter>,
    );
  const leipzig = { type: 'value-set', values: ['PL', '1SG'], delimiters: '.', parts: 'all' };
  const withFields = (fields, tagsets = project.config.igt.tagsets) => {
    const p = structuredClone(project);
    p.config.igt.tagsets = structuredClone(tagsets);
    p.textLayers[0].tokenLayers[0].spanLayers = fields;
    return p;
  };
  const clientFor = (proj, doubled = 0) => {
    const declared = [];
    const client = {
      ...clientWith([[['PL', 3]], [['Song', 4]]]),
      projects: { get: vi.fn(async () => structuredClone(proj)) },
      spanLayers: {
        refusedValues: vi.fn(async () => ({ count: 0, valueCount: 0, values: [] })),
        checkConstraints: vi.fn(async (_id, rules) =>
          rules.some((r) => r.type === 'single-span') && doubled
            ? { violations: [{ constraint: 'single-span' }], violationCount: doubled }
            : { violations: [], violationCount: 0 },
        ),
        setConstraints: vi.fn(async (id, _ns, list) => declared.push([id, list])),
        repairConstraints: vi.fn(),
      },
      withOperation: async (_m, fn) => fn(),
      batched: async (fn) => fn(client),
    };
    return { client, declared };
  };

  it('a list no closed tagset names: Remove the list, and the toast says it is removed', async () => {
    vi.clearAllMocks();
    const proj = withFields(
      [
        {
          id: 'msl-0',
          name: 'Gloss',
          config: { igt: { scope: 'Morpheme', tagset: 'Leipzig' } },
          constraints: { igt: [{ type: 'single-span' }, leipzig] },
        },
      ],
      { ...project.config.igt.tagsets, Leipzig: { ...LEIPZIG, mode: 'suggest' } },
    );
    const { client, declared } = clientFor(proj);
    const { container, step, unmount } = await renderWith(client, proj);
    const notice = container.querySelector('[data-testid="rules-out-of-force"]');
    expect(notice.textContent).toContain('In force with no closed tagset: the list on Gloss.');
    expect(notice.textContent).not.toContain('Put in force');
    await step(async () => {
      byText(notice, 'button', 'Remove the list').click();
      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    });
    expect(declared).toEqual([['msl-0', [{ type: 'single-span' }]]]);
    expect(notifySuccess).toHaveBeenCalledWith('The list on Gloss is removed');
    await unmount();
  });

  it('a field holding no rules: one annotation a unit, named when its annotations would need joining', async () => {
    vi.clearAllMocks();
    const proj = withFields([
      {
        id: 'msl-0',
        name: 'Gloss',
        config: { igt: { scope: 'Morpheme', tagset: 'Leipzig' } },
        constraints: { igt: [{ type: 'single-span' }, leipzig] },
      },
      {
        id: 'msl-1',
        name: 'Raw two',
        config: { igt: { scope: 'Morpheme' } },
        constraints: {},
      },
    ]);
    const { client, declared } = clientFor(proj, 1);
    const { container, step, unmount } = await renderWith(client, proj);
    const notice = container.querySelector('[data-testid="rules-out-of-force"]');
    expect(notice.textContent).toContain('Not in force: one annotation a morpheme on Raw two.');
    expect(notice.textContent).not.toContain('list');
    await step(async () => {
      byText(notice, 'button', 'Put in force').click();
      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    });
    expect(client.spanLayers.repairConstraints).not.toHaveBeenCalled();
    expect(declared).toEqual([]);
    expect(notifyWarning).toHaveBeenCalledWith(
      'Raw two: 1 morpheme with more than one annotation. Leave one annotation on each, then choose Put in force.',
      'Not in force',
    );
    expect(notifySuccess).not.toHaveBeenCalled();
    await unmount();
  });

  it('a field holding no rules on clean data: Put in force declares them', async () => {
    vi.clearAllMocks();
    const proj = withFields([
      { id: 'msl-1', name: 'Raw two', config: { igt: { scope: 'Morpheme' } }, constraints: {} },
    ]);
    const { client, declared } = clientFor(proj, 0);
    const { container, step, unmount } = await renderWith(client, proj);
    const notice = container.querySelector('[data-testid="rules-out-of-force"]');
    await step(async () => {
      byText(notice, 'button', 'Put in force').click();
      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    });
    expect(declared).toEqual([['msl-1', [{ type: 'single-span' }]]]);
    expect(notifySuccess).toHaveBeenCalledWith('In force on Raw two');
    await unmount();
  });
});

// REV5-WIRE-3: a field that needs one annotation left on some units lists
// each unit, with its values and a link to it in Analyze. REV5-WIRE-4: a
// field with its list and one annotation a unit out of force names both.
describe('units holding more than one annotation', () => {
  const doc = {
    id: 'd-1',
    name: 'Text 1',
    textLayers: [
      {
        id: 'tl-1',
        config: { plaid: { role: 'baseline' } },
        text: { body: 'Ali-di gam' },
        tokenLayers: [
          {
            id: 'sl',
            config: { plaid: { role: 'sentence' } },
            tokens: [{ id: 's-1', begin: 0, end: 10 }],
          },
          {
            id: 'ml-1',
            config: { plaid: { role: 'morpheme' } },
            tokens: [
              { id: 'm-1', begin: 0, end: 3 },
              { id: 'm-2', begin: 7, end: 10 },
            ],
            spanLayers: [
              {
                id: 'msl-0',
                spans: [
                  { id: 'sp-1', value: 'ERG', tokens: ['m-1'] },
                  { id: 'sp-2', value: 'ZZ', tokens: ['m-1'] },
                  { id: 'sp-3', value: 'PL', tokens: ['m-2'] },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const proj = structuredClone(project);
  proj.textLayers[0].tokenLayers[0].spanLayers[0].constraints = { igt: [] };
  const client = {
    ...clientWith([[['PL', 3]], [['Song', 4]]]),
    projects: { get: vi.fn(async () => structuredClone(proj)) },
    documents: { get: vi.fn(async () => structuredClone(doc)) },
    spanLayers: {
      refusedValues: vi.fn(async () => ({ count: 0, valueCount: 0, values: [] })),
      checkConstraints: vi.fn(async () => ({
        violations: [
          { constraint: 'single-span', document: 'd-1', at: 'm-1', ids: ['sp-1', 'sp-2'] },
        ],
        violationCount: 1,
      })),
    },
  };

  it('lists each unit with its values and a link to it in Analyze', async () => {
    vi.clearAllMocks();
    const { container, unmount } = await renderComponent(
      <MemoryRouter>
        <ProjectValidation
          project={proj}
          projectId="p-1"
          client={client}
          onProjectUpdate={vi.fn()}
        />
      </MemoryRouter>,
    );
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    const notice = container.querySelector('[data-testid="rules-out-of-force"]');
    expect(notice.textContent).toContain(
      'Not in force: Leipzig and one annotation a morpheme on Gloss.',
    );
    const list = container.querySelector('[data-testid="doubled-units"]');
    expect(list.textContent).toContain('Gloss: 1 morpheme with more than one annotation');
    expect(list.textContent).toContain('Text 1 · Ali');
    expect(list.textContent).toContain('ERG | ZZ');
    expect(list.querySelector('a').getAttribute('href')).toBe(
      '/projects/p-1/documents/d-1?tab=analyze&focusSentence=s-1',
    );
    expect(client.documents.get).toHaveBeenCalledTimes(1);
    await unmount();
  });
});
