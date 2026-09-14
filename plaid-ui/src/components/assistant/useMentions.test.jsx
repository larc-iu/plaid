import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { renderComponent } from '../../test/renderComponent.jsx';
import { useMentions } from './useMentions.js';

// `@` in the composer. The pure arithmetic is mentions.test.js; this is the
// half that holds state: when the list is open, what feeds it, and which keys
// it takes before the composer sees them.

const fakeClient = (documents = []) => ({
  projects: {
    listDocumentsPage: vi.fn().mockResolvedValue({ entries: documents }),
  },
});

const key = (k) => {
  let taken = false;
  return { key: k, preventDefault: () => (taken = true), wasPrevented: () => taken };
};

const mount = async (client, { offer, enabled = true, projectId = 'p1' } = {}) => {
  const box = {};
  const Probe = ({ pid }) => {
    const [text, setText] = useState('');
    const inputRef = { current: null };
    box.text = text;
    box.setText = setText;
    box.mentions = useMentions({
      client,
      projectId: pid,
      enabled,
      text,
      setText,
      inputRef,
      offer,
    });
    return (
      <span data-testid="m">
        {box.mentions.open ? box.mentions.items.map((i) => i.value).join(',') || 'empty' : 'shut'}
      </span>
    );
  };
  const r = await renderComponent(<Probe pid={projectId} />);
  return {
    ...r,
    box,
    Probe,
    read: () => r.container.querySelector('[data-testid="m"]').textContent,
    // Type `value` and put the caret at its end, the way the composer does.
    async type(value) {
      await r.step(() => {
        box.setText(value);
        box.mentions.noteCaret(value.length);
      });
    },
  };
};

beforeEach(() => vi.clearAllMocks());

describe('useMentions', () => {
  it('stays shut until an `@` is typed, and does not read the documents before then', async () => {
    const client = fakeClient([{ name: 'Text 1' }]);
    const m = await mount(client);
    await m.type('a plain question');
    expect(m.read()).toBe('shut');
    expect(client.projects.listDocumentsPage).not.toHaveBeenCalled();
    await m.unmount();
  });

  it('offers what the screen has, then the project’s documents', async () => {
    const client = fakeClient([{ name: 'Text 1' }, { name: 'Text 2' }]);
    const offer = vi.fn(() => [{ group: 'Sentences', items: [{ value: 's1', label: 's1' }] }]);
    const m = await mount(client, { offer });
    await m.type('about @');
    expect(m.read()).toBe('s1,Text 1,Text 2');
    expect(client.projects.listDocumentsPage).toHaveBeenCalledWith('p1', { limit: 1000 });
    await m.unmount();
  });

  it('reads the documents once, and again for another project', async () => {
    const client = fakeClient([{ name: 'Text 1' }]);
    const m = await mount(client);
    await m.type('@');
    await m.type('@T');
    expect(client.projects.listDocumentsPage).toHaveBeenCalledTimes(1);
    await m.rerender(<m.Probe pid="p2" />);
    await m.type('@');
    expect(client.projects.listDocumentsPage).toHaveBeenCalledTimes(2);
    await m.unmount();
  });

  it('still offers the screen’s half when the documents cannot be read', async () => {
    const client = fakeClient([]);
    client.projects.listDocumentsPage.mockRejectedValue(new Error('no'));
    const offer = () => [{ group: 'Sentences', items: [{ value: 's1', label: 's1' }] }];
    const m = await mount(client, { offer });
    await m.type('@s');
    expect(m.read()).toBe('s1');
    expect(m.box.mentions.loading).toBe(false);
    await m.unmount();
  });

  it('narrows by what a sentence says, not only by its reference', async () => {
    const client = fakeClient([]);
    const offer = () => [
      {
        group: 'Sentences',
        items: [
          { value: 's1', label: 's1', hint: 'Todos los seres humanos' },
          { value: 's2', label: 's2', hint: 'nacen libres' },
        ],
      },
    ];
    const m = await mount(client, { offer });
    await m.type('@libres');
    expect(m.read()).toBe('s2');
    await m.unmount();
  });

  it('takes the arrows and Enter before the composer can send', async () => {
    const client = fakeClient([{ name: 'Text 1' }, { name: 'Text 2' }]);
    const m = await mount(client);
    await m.type('@Text');
    expect(m.box.mentions.activeValue).toBe('Text 1');

    const down = key('ArrowDown');
    await m.step(() => expect(m.box.mentions.handleKeyDown(down)).toBe(true));
    expect(down.wasPrevented()).toBe(true);
    expect(m.box.mentions.activeValue).toBe('Text 2');

    const enter = key('Enter');
    await m.step(() => expect(m.box.mentions.handleKeyDown(enter)).toBe(true));
    expect(enter.wasPrevented()).toBe(true);
    expect(m.box.text).toBe('Text 2 ');
    await m.unmount();
  });

  it('leaves Enter alone when nothing is being mentioned', async () => {
    const client = fakeClient([]);
    const m = await mount(client);
    await m.type('just a question');
    const enter = key('Enter');
    expect(m.box.mentions.handleKeyDown(enter)).toBe(false);
    expect(enter.wasPrevented()).toBe(false);
    await m.unmount();
  });

  it('Escape shuts the list and leaves the typed text alone', async () => {
    const client = fakeClient([{ name: 'Text 1' }]);
    const m = await mount(client);
    await m.type('@Te');
    const esc = key('Escape');
    await m.step(() => expect(m.box.mentions.handleKeyDown(esc)).toBe(true));
    expect(m.read()).toBe('shut');
    expect(m.box.text).toBe('@Te');
    // It stays dismissed while the same `@` is being typed, and a new one
    // opens the list again.
    await m.type('@Tex');
    expect(m.read()).toBe('shut');
    await m.type('@Tex and @Te');
    expect(m.read()).toBe('Text 1');
    await m.unmount();
  });

  it('offers nothing while a message cannot be sent', async () => {
    const client = fakeClient([{ name: 'Text 1' }]);
    const m = await mount(client, { enabled: false });
    await m.type('@');
    expect(m.read()).toBe('shut');
    await m.unmount();
  });
});
