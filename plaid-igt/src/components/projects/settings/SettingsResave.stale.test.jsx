import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { sameConfig } from '@ui/domain/configCells.js';
import { LanguagesSettings } from './LanguagesSettings.jsx';
import { ComposeSettings } from './ComposeSettings.jsx';

// One maintainer alone, on a slow network. A save lands and the page reads
// the project again. A second save made before that read came back expected
// the value from before the first save, and the server refused it as changed
// elsewhere, though nobody else had saved. The page holds its Save until the
// read is back, so the next save expects what the first one stored.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));

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

// The page's project, read again only when the test lets the read answer.
const openPage = async (Page, server, client) => {
  const page = { project: structuredClone(server), reads: [] };
  const props = () => ({
    project: page.project,
    projectId: 'p-1',
    client,
    onProjectUpdate: () =>
      new Promise((resolve) => {
        const copy = structuredClone(server);
        page.reads.push(async () => {
          page.project = copy;
          await view.rerender(
            <MemoryRouter>
              <Page {...props()} />
            </MemoryRouter>,
          );
          resolve();
        });
      }),
  });
  const view = await renderComponent(
    <MemoryRouter>
      <Page {...props()} />
    </MemoryRouter>,
  );
  page.view = view;
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
const saveButton = (container) =>
  [...container.querySelectorAll('button')].find((b) => /^(Save|Saving…)$/.test(b.textContent));

const twoSaves = async (Page, inputs) => {
  const { server, client } = makeServer();
  const page = await openPage(Page, server, client);
  const { view } = page;
  const [first, second] = inputs(view.container);

  await view.step(() => type(first, 'one'));
  await view.step(async () => {
    saveButton(view.container).click();
    await settle();
  });
  // The first save has landed and its read is still on the wire.
  await view.step(() => type(second, 'two'));
  await view.step(async () => {
    saveButton(view.container).click();
    await settle();
  });
  while (page.reads.length) await view.step(() => page.reads.shift()());
  await view.step(settle);
  await view.unmount();
  return client;
};

describe('a second save while the first save reads the project again', () => {
  it('Languages is not refused as changed elsewhere', async () => {
    const client = await twoSaves(LanguagesSettings, (c) => {
      const all = [...c.querySelectorAll('input')];
      return [all[0], all[6]];
    });
    expect(client.refused).toBe(0);
  });

  it('Special characters is not refused as changed elsewhere', async () => {
    const client = await twoSaves(ComposeSettings, (c) => {
      const notes = [...c.querySelectorAll('input[aria-label="Note"]')];
      return [notes[0], notes[1]];
    });
    expect(client.refused).toBe(0);
  });
});
