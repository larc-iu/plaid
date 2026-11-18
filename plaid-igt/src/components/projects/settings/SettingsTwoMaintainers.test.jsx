import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { sameConfig } from '@ui/domain/configCells.js';
import { LanguagesSettings } from './LanguagesSettings.jsx';
import { ComposeSettings } from './ComposeSettings.jsx';
import { BUILT_IN_TABLE } from '@/domain/composeConfig';

// Two maintainers on one Settings section (H2-12-1). Ana saved. Ben, on a
// page opened before that, saved and was refused as changed elsewhere, and
// his page still showed the list from before Ana's save. His second Save
// wrote that whole list and took Ana's change away. A page read again now
// takes what is stored and puts the person's own edits on it, and a field
// both of them changed says what is stored now.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));

afterEach(() => vi.clearAllMocks());

const makeServer = () => {
  const server = { id: 'p-1', textLayers: [], config: { igt: {} } };
  const client = {
    refused: 0,
    projects: {
      setConfig: async (_id, ns, key, value, _audit, options) => {
        if (options && !sameConfig(options.expected, server.config[ns][key])) {
          client.refused++;
          throw Object.assign(new Error('HTTP 409 changed'), { status: 409 });
        }
        server.config[ns][key] = structuredClone(value);
      },
    },
  };
  return { server, client };
};

// One maintainer's page: its own copy of the project, read again on demand.
const openPage = async (Page, server, client) => {
  const page = { project: structuredClone(server) };
  const el = () => (
    <MemoryRouter>
      <Page
        project={page.project}
        projectId="p-1"
        client={client}
        onProjectUpdate={async () => {
          const copy = structuredClone(server);
          // A held read answers when the test lets it.
          if (page.held) await new Promise((r) => page.held.push(r));
          page.project = copy;
          await page.view.rerender(el());
        }}
      />
    </MemoryRouter>
  );
  page.view = await renderComponent(el());
  return page;
};

const type = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const button = (c, re) => [...c.querySelectorAll('button')].find((b) => re.test(b.textContent));
const press = (page, re) =>
  page.view.step(async () => {
    button(page.view.container, re).click();
    await settle();
  });

describe('Special characters, two maintainers', () => {
  const addCode = async (page, code, char, note) => {
    await press(page, /Add code/);
    const row = page.view.container.querySelector('[data-row-uid]');
    const [codeBox, charBox, noteBox] = row.querySelectorAll('input');
    await page.view.step(() => type(codeBox, code));
    await page.view.step(() => type(charBox, char));
    await page.view.step(() => type(noteBox, note));
  };
  const rowOf = (page, code) => page.view.container.querySelector(`[data-code-row="${code}"]`);
  const stored = (server) => server.config.igt.compose.codes.map((c) => c.code).sort();

  it("a refused save shows the other's code with this one's, and a second save keeps both", async () => {
    const { notifyError } = await import('@/utils/feedback');
    const { server, client } = makeServer();
    const ana = await openPage(ComposeSettings, server, client);
    const ben = await openPage(ComposeSettings, server, client);

    await addCode(ana, 'qq', 'ʔ', 'by Ana');
    await press(ana, /^Save$/);
    expect(stored(server)).toEqual(['qq']);

    await addCode(ben, 'zz', 'ɓ', 'by Ben');
    await press(ben, /^Save$/);
    expect(client.refused).toBe(1);
    expect(stored(server)).toEqual(['qq']);
    expect(notifyError).toHaveBeenLastCalledWith(
      'Changed elsewhere. Now showing the latest version with your edit. Save again.',
      'Failed to save the codes',
    );
    expect(rowOf(ben, 'qq')).not.toBeNull();
    expect(rowOf(ben, 'zz')).not.toBeNull();

    await press(ben, /^Save$/);
    expect(stored(server)).toEqual(['qq', 'zz']);
    await ana.view.unmount();
    await ben.view.unmount();
  });

  it('a code both changed keeps what this page typed and says what is stored', async () => {
    const { server, client } = makeServer();
    const code = Object.keys(BUILT_IN_TABLE)[0];
    const ana = await openPage(ComposeSettings, server, client);
    const ben = await openPage(ComposeSettings, server, client);

    await ana.view.step(() => type(rowOf(ana, code).querySelectorAll('input')[1], 'by Ana'));
    await press(ana, /^Save$/);
    await ben.view.step(() => type(rowOf(ben, code).querySelectorAll('input')[1], 'by Ben'));
    await press(ben, /^Save$/);

    expect(rowOf(ben, code).querySelectorAll('input')[1].value).toBe('by Ben');
    expect(rowOf(ben, code).textContent).toContain(
      `Changed elsewhere to ${BUILT_IN_TABLE[code]} (by Ana).`,
    );
    await press(ben, /^Save$/);
    expect(server.config.igt.compose.codes.map((c) => c.description)).toEqual(['by Ben']);
    expect(rowOf(ben, code).textContent).not.toContain('Changed elsewhere');
    await ana.view.unmount();
    await ben.view.unmount();
  });

  it('an edit made while its own save is read again is not said to be changed elsewhere', async () => {
    const { server, client } = makeServer();
    const code = Object.keys(BUILT_IN_TABLE)[0];
    const ben = await openPage(ComposeSettings, server, client);
    ben.held = [];
    const note = () => rowOf(ben, code).querySelectorAll('input')[1];
    await ben.view.step(() => type(note(), 'one'));
    await press(ben, /^Save$/);
    await ben.view.step(() => type(note(), 'two'));
    ben.held.shift()();
    await ben.view.step(settle);
    expect(note().value).toBe('two');
    expect(rowOf(ben, code).textContent).not.toContain('Changed elsewhere');
    await ben.view.unmount();
  });

  it('a code deleted on this page stays deleted when the list is read again', async () => {
    const { server, client } = makeServer();
    server.config.igt.compose = {
      codes: [{ code: 'kk', char: 'k', modified: '2026-01-01T00:00:00Z' }],
      removed: [],
    };
    const ana = await openPage(ComposeSettings, server, client);
    const ben = await openPage(ComposeSettings, server, client);

    await addCode(ana, 'qq', 'ʔ', '');
    await press(ana, /^Save$/);
    await ben.view.step(async () => {
      rowOf(ben, 'kk').querySelector('button[aria-label="Delete code kk"]').click();
      await settle();
    });
    await press(ben, /^Save$/);
    await press(ben, /^Save$/);
    expect(stored(server)).toEqual(['qq']);
    await ana.view.unmount();
    await ben.view.unmount();
  });
});

describe('Languages, two maintainers', () => {
  const box = (page, id) => page.view.container.querySelector(`#${id}`);

  it("a refused save shows the other's value with this one's, and a second save keeps both", async () => {
    const { notifyError } = await import('@/utils/feedback');
    const { server, client } = makeServer();
    const ana = await openPage(LanguagesSettings, server, client);
    const ben = await openPage(LanguagesSettings, server, client);

    await ana.view.step(() => type(box(ana, 'obj-lang-glottocode'), 'abcd1234'));
    await press(ana, /^Save$/);
    await ben.view.step(() => type(box(ben, 'meta-lang-name'), 'Dutch'));
    await press(ben, /^Save$/);

    expect(client.refused).toBe(1);
    expect(notifyError).toHaveBeenLastCalledWith(
      'Changed elsewhere. Now showing the latest version with your edit. Save again.',
      'Failed to save the languages',
    );
    expect(box(ben, 'obj-lang-glottocode').value).toBe('abcd1234');
    expect(box(ben, 'meta-lang-name').value).toBe('Dutch');

    await press(ben, /^Save$/);
    expect(server.config.igt.languages.object.glottocode).toBe('abcd1234');
    expect(server.config.igt.languages.meta.name).toBe('Dutch');
    await ana.view.unmount();
    await ben.view.unmount();
  });

  it('an edit made while its own save is read again is not said to be changed elsewhere', async () => {
    const { server, client } = makeServer();
    const ben = await openPage(LanguagesSettings, server, client);
    ben.held = [];
    await ben.view.step(() => type(box(ben, 'obj-lang-name'), 'one'));
    await press(ben, /^Save$/);
    await ben.view.step(() => type(box(ben, 'obj-lang-name'), 'two'));
    ben.held.shift()();
    await ben.view.step(settle);
    expect(box(ben, 'obj-lang-name').value).toBe('two');
    expect(ben.view.container.textContent).not.toContain('Changed elsewhere');
    await ben.view.unmount();
  });

  it('a field both changed keeps what this page typed and says what is stored', async () => {
    const { server, client } = makeServer();
    const ana = await openPage(LanguagesSettings, server, client);
    const ben = await openPage(LanguagesSettings, server, client);

    await ana.view.step(() => type(box(ana, 'obj-lang-name'), 'Kalo'));
    await press(ana, /^Save$/);
    await ben.view.step(() => type(box(ben, 'obj-lang-name'), 'Calo'));
    await press(ben, /^Save$/);

    expect(box(ben, 'obj-lang-name').value).toBe('Calo');
    expect(ben.view.container.textContent).toContain('Changed elsewhere to Kalo.');
    await press(ben, /^Save$/);
    expect(server.config.igt.languages.object.name).toBe('Calo');
    expect(ben.view.container.textContent).not.toContain('Changed elsewhere');
    await ana.view.unmount();
    await ben.view.unmount();
  });
});
