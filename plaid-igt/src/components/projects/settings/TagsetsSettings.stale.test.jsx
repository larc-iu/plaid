import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { sameConfig } from '@ui/domain/configCells.js';
import { TagsetsSettings } from './TagsetsSettings.jsx';

// Two maintainers on Settings, Annotation. C added a tagset, then A, on a page
// loaded before that, added another, and the whole map A wrote dropped C's
// (V6 H6-2). A write now expects the tagsets the page read, the server refuses
// it when someone else saved in between, and the page reads them again. The
// tagset editor also takes a new read in place of its draft.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));

const tagset = () => ({ delimiters: '', mode: 'suggest', values: [] });

// A core that keeps one project and does the compare-and-set.
const makeServer = () => {
  const server = { id: 'p-1', textLayers: [], config: { igt: { tagsets: { Cats: tagset() } } } };
  const client = {
    writes: [],
    projects: {
      setConfig: async (_id, ns, key, value, _audit, options) => {
        client.writes.push({ key, value, options });
        if (options && !sameConfig(options.expected, server.config[ns][key])) {
          throw Object.assign(new Error('HTTP 409 changed'), { status: 409 });
        }
        server.config[ns][key] = structuredClone(value);
      },
    },
    spanLayers: { setConfig: async () => {}, setConstraints: async () => {} },
    // A batch queues its writes and sends them in turn on submit, a refusal
    // refusing the batch.
    async batched(fn) {
      const ops = [];
      const queue = (bundle) =>
        new Proxy(
          {},
          {
            get:
              (_, method) =>
              (...args) =>
                ops.push(() => this[bundle][method](...args)),
          },
        );
      fn({ projects: queue('projects'), spanLayers: queue('spanLayers') });
      for (const op of ops) await op();
      return [];
    },
  };
  return { server, client };
};

// One maintainer's page: its own copy of the project, read again on demand.
const openPage = async (server, client) => {
  const page = { project: structuredClone(server) };
  const props = () => ({
    project: page.project,
    projectId: 'p-1',
    client,
    onProjectUpdate: page.reread,
  });
  const view = await renderComponent(<TagsetsSettings {...props()} />);
  page.reread = vi.fn(async () => {
    page.project = structuredClone(server);
    await view.rerender(<TagsetsSettings {...props()} />);
  });
  await view.rerender(<TagsetsSettings {...props()} />);
  page.view = view;
  return page;
};

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const typeInto = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const addTagset = async (page, name) => {
  const { container, step } = page.view;
  const box = all(container, 'input').find((i) => /tagset name/i.test(i.placeholder || ''));
  await step(() => typeInto(box, name));
  const add = all(container, 'button').find((b) => /^Add tagset$/i.test(b.textContent.trim()));
  await step(async () => {
    add.click();
    await settle();
  });
};
const shownNames = (page) => page.view.container.textContent;

afterEach(() => vi.clearAllMocks());

describe('Settings, tagsets, two maintainers', () => {
  it("refuses a stale page's save and shows what is stored, which a second try keeps", async () => {
    const { server, client } = makeServer();
    const a = await openPage(server, client);
    const c = await openPage(server, client);

    await addTagset(c, 'Cx');
    expect(Object.keys(server.config.igt.tagsets)).toEqual(['Cats', 'Cx']);

    await addTagset(a, 'Ay');
    expect(Object.keys(server.config.igt.tagsets)).toEqual(['Cats', 'Cx']);
    expect(a.reread).toHaveBeenCalled();
    expect(shownNames(a)).toContain('Cx');

    await addTagset(a, 'Ay');
    expect(Object.keys(server.config.igt.tagsets)).toEqual(['Cats', 'Cx', 'Ay']);

    await a.view.unmount();
    await c.view.unmount();
  });

  it('two changes in a row on one page do not refuse each other', async () => {
    const { server, client } = makeServer();
    const a = await openPage(server, client);
    await addTagset(a, 'One');
    await addTagset(a, 'Two');
    expect(Object.keys(server.config.igt.tagsets)).toEqual(['Cats', 'One', 'Two']);
    expect(a.reread).toHaveBeenCalledTimes(2);
    await a.view.unmount();
  });
});
