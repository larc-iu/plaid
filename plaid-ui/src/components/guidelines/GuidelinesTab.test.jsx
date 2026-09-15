import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all, texts, byText } from '../../test/renderComponent.jsx';
import { GuidelinesTab } from './GuidelinesTab.jsx';

// What the screen is for, in four properties:
//
//   1. A READER sees the manual and none of the controls that would 403.
//   2. The list is in READING ORDER, pinned first then by title, which is the
//      order the assistant is given them in too.
//   3. Opening one fetches its BODY. The list deliberately does not carry
//      bodies, so a screen that forgot to fetch would render every guideline
//      as empty and look like a data problem.
//   4. The editor is LAZY, so a reader never pays for Tiptap.

const INDEX = [
  { id: 'g1', title: 'Zeta', summary: 'Last by title.', pinned: false, bodyChars: 5 },
  { id: 'g2', title: 'Alpha', summary: 'First by title.', pinned: false, bodyChars: 2 },
  {
    id: 'g3',
    title: 'Translations',
    summary: 'Pinned, so first of all.',
    pinned: true,
    bodyChars: 9,
  },
];

const BODIES = {
  g1: 'The zeta body.',
  g2: 'The alpha body.',
  g3: 'Free translations are **idiomatic**.',
};

const fakeClient = (overrides = {}) => ({
  guidelines: {
    list: vi.fn().mockResolvedValue(INDEX),
    get: vi.fn(async (id) => ({
      ...INDEX.find((g) => g.id === id),
      body: BODIES[id],
    })),
    create: vi.fn().mockResolvedValue({ id: 'new' }),
    update: vi.fn(async (id, changes) => ({ ...INDEX.find((g) => g.id === id), ...changes })),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  },
});

const mount = ({ client = fakeClient(), ...props } = {}) =>
  renderComponent(
    <MemoryRouter>
      <GuidelinesTab client={client} projectId="p1" canWrite={false} {...props} />
    </MemoryRouter>,
  ).then((r) => ({ ...r, client }));

// Typing into a controlled input. React keeps its own record of the value and
// skips onChange when the DOM value is assigned directly, so the change has to
// go through the native setter first.
const typeInto = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

/** The titles in the list, in the order they are drawn. */
const rowTitles = (container) => texts(container, 'button[class*="border-b"] span.font-medium');

describe('the guidelines list', () => {
  it('reads the index without bodies and shows pinned first, then by title', async () => {
    const { container, client, unmount } = await mount();

    expect(client.guidelines.list).toHaveBeenCalledWith('p1');
    expect(rowTitles(container)).toEqual(['Translations', 'Alpha', 'Zeta']);
    await unmount();
  });

  it('fetches the body only when a guideline is opened', async () => {
    const { container, client, step, unmount } = await mount();

    expect(client.guidelines.get).not.toHaveBeenCalled();

    const alpha = byText(container, 'button', 'Alpha');
    await step(() => alpha.click());

    expect(client.guidelines.get).toHaveBeenCalledWith('g2');
    expect(container.textContent).toContain('The alpha body.');
    await unmount();
  });

  it('renders a body as Markdown rather than as its source', async () => {
    const { container, step, unmount } = await mount();
    await step(() => byText(container, 'button', 'Translations').click());

    expect(all(container, 'strong').map((n) => n.textContent)).toContain('idiomatic');
    expect(container.textContent).not.toContain('**idiomatic**');
    await unmount();
  });

  it('says so when the project has no guidelines yet', async () => {
    const client = fakeClient({ list: vi.fn().mockResolvedValue([]) });
    const { container, unmount } = await mount({ client });
    expect(container.textContent).toContain('No guidelines yet');
    await unmount();
  });
});

describe('a reader is shown no control that would be refused', () => {
  it('offers no New, Edit, Delete or pin', async () => {
    const { container, step, unmount } = await mount({ canWrite: false });
    await step(() => byText(container, 'button', 'Alpha').click());

    const labels = all(container, 'button').map((b) => b.textContent.trim());
    expect(labels).not.toContain('New');
    expect(labels).not.toContain('Edit');
    expect(all(container, '[aria-label="Delete"]')).toHaveLength(0);
    expect(all(container, '[aria-label="Pin"]')).toHaveLength(0);
    await unmount();
  });

  it('never loads the editor, which is the only thing that pulls in Tiptap', async () => {
    const { container, unmount } = await mount({ canWrite: false });
    // The editor mounts only from the draft state, which a reader cannot enter.
    expect(all(container, '.guideline-editor__doc')).toHaveLength(0);
    await unmount();
  });
});

describe('a writer', () => {
  it('is offered New, and Edit on what is open', async () => {
    const { container, step, unmount } = await mount({ canWrite: true });
    const labels = () => all(container, 'button').map((b) => b.textContent.trim());

    expect(labels()).toContain('New');
    await step(() => byText(container, 'button', 'Alpha').click());
    expect(labels()).toContain('Edit');
    await unmount();
  });

  it('notes a title already in use while typing, and still saves it', async () => {
    // Titles are not unique and the server does not police them. The note has
    // to appear before there is any work to lose, and must not block the save.
    const { container, client, step, unmount } = await mount({ canWrite: true });
    await step(() => byText(container, 'button', 'New').click());
    const title = container.querySelector('#guideline-title');
    await step(() => typeInto(title, 'Alpha'));
    expect(container.querySelector('#guideline-title-taken')?.textContent).toBe(
      'Another guideline has this title.',
    );

    await step(() => typeInto(container.querySelector('#guideline-summary'), 'A second one.'));
    await step(() => byText(container, 'button', 'Save').click());
    expect(client.guidelines.create).toHaveBeenCalledWith('p1', 'Alpha', 'A second one.', {
      body: '',
      pinned: false,
    });
    await unmount();
  });

  it('pins a guideline without restating the rest of it', async () => {
    const { container, client, step, unmount } = await mount({ canWrite: true });
    await step(() => byText(container, 'button', 'Alpha').click());

    const pin = container.querySelector('[aria-label="Pin"]');
    await step(() => pin.click());

    // A patch that named the title as well would be the one that can 409 on a
    // title someone else took in the meantime.
    expect(client.guidelines.update).toHaveBeenCalledWith('g2', { pinned: true });
    await unmount();
  });
});
