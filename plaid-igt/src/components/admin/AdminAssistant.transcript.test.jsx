import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all, byText, texts } from '@ui/test/renderComponent.jsx';
import { AdminAssistant } from './AdminAssistant';
import source from './AdminAssistant.jsx?raw';

// The admin transcript is the chat's own `Turn`, read-only: what an operator
// reads is what the owner saw, and opening it writes nothing to the owner's
// record (no settle, no pending clear, no polling).

const PA = '01a04e40-0fbd-7297-9c4b-fef05492ecf1';
const OWNER = 'ada@example.com';

const meta = (convId, title, app = 'igt', extra = {}) => ({
  key: `${app}:assistant:${PA}:meta:${convId}`,
  userId: OWNER,
  updatedAt: '2026-09-01T10:00:00Z',
  value: { title, turns: 2, model: 'glm-5.2', ...extra },
});

const CITE = '<cite doc="Text 1" ref="s3.w2"/>';
const igtCitation = {
  key: CITE,
  documentName: 'Text 1',
  documentId: 'd1',
  sentence: 3,
  sentenceId: 's-3',
  tiers: [{ name: 'Gloss', kind: 'word' }],
  words: [
    { index: 1, surface: 'Ali-di', lines: [{ field: 'Gloss', value: 'Ali-ERG' }] },
    { index: 2, surface: 'gam', begin: 7, lines: [{ field: 'Gloss', value: 'fish' }] },
  ],
  focus: [{ word: 2 }],
};

const where = {
  kind: 'token',
  documentId: 'd1',
  documentName: 'Text 1',
  sentenceId: 's-3',
  sentence: 3,
  word: 2,
  begin: 7,
  surface: 'gam',
};

const IGT_CONV = {
  messages: [
    { role: 'user', content: 'Gloss gam.' },
    { role: 'tool', toolCallId: 't1', content: 'Text 1: 12 sentences' },
  ],
  display: [
    {
      kind: 'user',
      text: 'Gloss gam.',
      files: [{ id: 'f1', name: 'wordlist.csv', bytes: 2048 }],
    },
    {
      kind: 'assistant',
      model: 'glm-5.2',
      text: `It appears in ${CITE} as a noun.`,
      citations: [igtCitation],
      stepsSummary: 'Read 1 document',
      steps: [{ id: 't1', name: 'read_document', label: 'Read Text 1' }],
      elapsedMs: 12000,
      files: [
        {
          id: 'f2',
          name: 'grammar.pdf',
          bytes: 300000,
          source: 'https://example.org/grammar.pdf',
        },
      ],
      plan: {
        id: 'p1',
        summary: '1 field value',
        labels: ['s3.w2 Gloss = "fish"'],
        ops: [{}],
        changes: [{ label: 's3.w2 Gloss = "fish"', where, change: 'Gloss = "fish"' }],
      },
      status: null,
    },
    { kind: 'user', text: 'And the next one?' },
    { kind: 'error', text: 'The assistant stopped responding.' },
    { kind: 'user', text: 'And the next one?' },
    {
      kind: 'assistant',
      model: 'glm-5.2',
      text: 'Done.',
      plan: {
        id: 'p2',
        summary: '1 field value',
        labels: ['s4.w1 Gloss = "go"'],
        opCount: 1,
        changes: [{ label: 's4.w1 Gloss = "go"', where, change: 'Gloss = "go"' }],
      },
      status: 'applied',
    },
    { kind: 'user', text: 'Now s5.' },
    { kind: 'error', stopped: true, text: 'Stopped.' },
  ],
};

const UD_CITE = '<cite doc="dev" ref="s2.w1"/>';
const UD_CONV = {
  messages: [],
  display: [
    { kind: 'user', text: 'Which lemmas are missing?' },
    {
      kind: 'assistant',
      model: 'glm-5.2',
      text: `One:\n${UD_CITE}\nAs in ${UD_CITE}.`,
      citations: [
        {
          key: UD_CITE,
          documentName: 'dev',
          documentId: 'd9',
          sentence: 2,
          sentenceId: 'tok-2',
          text: 'kitab parhi',
          columns: ['ID', 'FORM'],
          rows: [['1', 'kitab']],
        },
      ],
      plan: {
        id: 'p3',
        summary: '1 lemma',
        labels: ['s2.w1 lemma = kitab'],
        ops: [{}],
        changes: [
          {
            label: 's2.w1 lemma = kitab',
            where: {
              kind: 'token',
              documentId: 'd9',
              documentName: 'dev',
              ref: 's2.w1',
              surface: 'kitab',
            },
          },
        ],
      },
      status: null,
    },
  ],
};

// A client that records every call made through it, at any depth, and
// answers only the reads this screen is meant to make.
const READS = {
  'admin.userData': async () => [
    meta('c1', 'Glossing gam'),
    meta('c2', 'Lemmas', 'ud'),
    meta('c3', 'Running now', 'igt', {
      pending: { kind: 'turn', requestId: 'r1' },
    }),
  ],
  'users.list': async () => [{ id: OWNER, displayName: 'Ada Lovelace' }],
  'users.avatarUrl': () => null,
  'projects.list': async () => [{ id: PA, name: 'Kalamang' }],
  // The cap the meter measures the record against.
  'server.limits': async () => ({ userDataValueBytes: 5 * 1048576 }),
  'userData.get': async (_user, key) => ({
    value: key.startsWith('ud:')
      ? UD_CONV
      : key.endsWith(':c3')
        ? { messages: [], display: [{ kind: 'user', text: 'Count the verbs.' }] }
        : IGT_CONV,
  }),
};

const recordingClient = () => {
  const calls = [];
  const at = (path) =>
    new Proxy(() => {}, {
      get: (_t, name) => (typeof name === 'symbol' ? undefined : at([...path, name])),
      apply: (_t, _this, args) => {
        const name = path.join('.');
        calls.push(name);
        return READS[name] ? READS[name](...args) : Promise.reject(new Error(`unexpected ${name}`));
      },
    });
  // `then` must be absent, or awaiting the client would treat it as a promise.
  const client = new Proxy(
    {},
    {
      get: (_t, name) => (name === 'then' || typeof name === 'symbol' ? undefined : at([name])),
    },
  );
  return { client, calls };
};

const open = async (title) => {
  const { client, calls } = recordingClient();
  const r = await renderComponent(
    <MemoryRouter>
      <AdminAssistant client={client} />
    </MemoryRouter>,
  );
  await r.step(async () => byText(r.container, 'tbody button', title).click());
  return { ...r, calls };
};

const buttons = (container) => texts(container, 'button');

describe('the admin transcript of an igt conversation', () => {
  beforeEach(() => localStorage.clear());

  it('draws the plan card with its status and changes and no decision', async () => {
    const { container, unmount } = await open('Glossing gam');
    const cards = all(container, 'div').filter(
      (d) => d.firstElementChild?.firstElementChild?.textContent === 'Proposed changes',
    );
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('Gloss = "fish"');
    expect(cards[1].textContent).toContain('Applied');
    const shown = buttons(container).join(' | ');
    expect(shown).not.toMatch(/Approve|Discard|Apply again/);
    expect(container.textContent).not.toContain('Applying needs write access');
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    await unmount();
  });

  it('draws the citation as a link and its card, the steps, and the reply time', async () => {
    const { container, step, unmount } = await open('Glossing gam');
    const link = all(container, 'a').find((a) => a.textContent.startsWith('Text 1, sentence 3'));
    expect(link.getAttribute('href')).toContain('focusSentence=s-3');
    // The card for an inline citation folds under the reply, as in the chat.
    await step(async () => byText(container, 'button', '1 cited example').click());
    expect(container.textContent).toContain('Ali-ERG');
    await step(async () => byText(container, 'button', 'Read 1 document').click());
    await step(async () => byText(container, 'button', 'Read Text 1').click());
    expect(texts(container, 'pre')).toEqual(['Text 1: 12 sentences']);
    expect(container.textContent).toContain('Answered in');
    await unmount();
  });

  it('draws the attached file and the fetched PDF as the chat does', async () => {
    const { container, unmount } = await open('Glossing gam');
    expect(container.textContent).toContain('wordlist.csv');
    const pdf = all(container, 'a').find((a) => a.textContent.includes('grammar.pdf'));
    expect(pdf.getAttribute('href')).toBe('https://example.org/grammar.pdf');
    // The attachment on a message is a chip, not a link, in the chat as here.
    expect(all(container, 'a').some((a) => a.textContent.includes('wordlist.csv'))).toBe(false);
    await unmount();
  });

  it('draws a failed turn, its retry, and the stopped last turn without a Retry', async () => {
    const { container, unmount } = await open('Glossing gam');
    expect(texts(container, '[role="alert"]')).toEqual(['The assistant stopped responding.']);
    expect(container.textContent).toContain('Done.');
    expect(container.textContent).toContain('You stopped this turn.');
    // The line stands in for the stop record, as in the chat.
    expect(container.textContent).not.toContain('Stopped.');
    expect(buttons(container)).not.toContain('Retry');
    await unmount();
  });

  it('does not call a turn still running unanswered', async () => {
    const { container, unmount } = await open('Running now');
    expect(container.textContent).toContain('Count the verbs.');
    expect(container.textContent).not.toContain('No answer came back');
    await unmount();
  });

  it('only reads, whatever is opened or expanded', async () => {
    const { container, step, calls, unmount } = await open('Glossing gam');
    await step(async () => byText(container, 'button', 'Read 1 document').click());
    await step(async () => byText(container, 'button', '1 cited example').click());
    await new Promise((r) => setTimeout(r, 50));
    expect([...new Set(calls)].sort()).toEqual(
      expect.arrayContaining(['admin.userData', 'projects.list', 'userData.get', 'users.list']),
    );
    const allowed = new Set(Object.keys(READS));
    expect(calls.filter((c) => !allowed.has(c))).toEqual([]);
    expect(calls.filter((c) => c === 'userData.get')).toHaveLength(1);
    await unmount();
  });
});

describe('the admin transcript of another app', () => {
  it('draws its citation plainly and its plan rows by their labels', async () => {
    const { container, calls, unmount } = await open('Lemmas');
    expect(container.textContent).toContain('dev, sentence 2');
    expect(container.textContent).toContain('kitab parhi');
    expect(container.textContent).toContain('s2.w1 lemma = kitab');
    expect(container.textContent).not.toMatch(/<cite/);
    // A row names the word and reference it changes, unlinked, then its label.
    const row = all(container, 'tbody tr').find((tr) => tr.textContent.includes('lemma = kitab'));
    expect(texts(row, 'td span span')).toEqual(['kitab', 's2.w1']);
    expect(texts(row, 'td')[1]).toBe('s2.w1 lemma = kitab');
    // The inline one is its title, not a link to nowhere.
    expect(texts(container, 'strong')).toContain('dev, sentence 2');
    // Nothing links into an editor this app cannot address.
    expect(all(container, 'a').filter((a) => a.getAttribute('href') !== null)).toEqual([]);
    expect(buttons(container).join(' | ')).not.toMatch(/Approve|Discard/);
    expect(calls.filter((c) => !Object.keys(READS).includes(c))).toEqual([]);
    await unmount();
  });

  it('imports no other app', () => {
    const imports = source.match(/from\s+'[^']+'/g) || [];
    expect(imports.filter((i) => /plaid-(ud|umr)|@ud\b|@umr\b/.test(i))).toEqual([]);
  });
});
