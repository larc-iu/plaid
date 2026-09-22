// A tab group with a guard asks before it leaves the tab it is on, and the
// same question meets a link on the screen under it.
import { describe, it, expect, vi } from 'vitest';
import { act, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '../../test/renderComponent.jsx';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs.jsx';

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn(async () => false) }));
vi.mock('../shared/ConfirmProvider.jsx', () => ({ useConfirm: () => confirm }));

const { useUnsavedDraft, useUnsavedGuard } = await import('../../hooks/useUnsavedDraft.js');

const mount = async (guard) => {
  let seen = [];
  const Harness = () => {
    const [tab, setTab] = useState('one');
    seen = [tab];
    return (
      <MemoryRouter>
        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v);
          }}
          guard={guard}
        >
          <TabsList>
            <TabsTrigger value="one" to="/x?tab=one">
              One
            </TabsTrigger>
            <TabsTrigger value="two" to="/x?tab=two">
              Two
            </TabsTrigger>
          </TabsList>
          <TabsContent value="one">first</TabsContent>
          <TabsContent value="two">second</TabsContent>
        </Tabs>
      </MemoryRouter>
    );
  };
  const view = await renderComponent(<Harness />);
  const tabTwo = [...view.container.querySelectorAll('a')].find((a) => a.textContent === 'Two');
  return { view, tabTwo, tab: () => seen[0] };
};

describe('a guarded tab group', () => {
  it('changes tab when the guard says yes', async () => {
    const { view, tabTwo, tab } = await mount(async () => true);
    await view.step(() => tabTwo.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await view.step(() => {});
    expect(tab()).toBe('two');
  });

  it('stays where it is when the guard says no, and asks again next time', async () => {
    let asked = 0;
    const { view, tabTwo, tab } = await mount(async () => {
      asked += 1;
      return false;
    });
    await view.step(() => tabTwo.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await view.step(() => {});
    expect(tab()).toBe('one');
    expect(asked).toBe(1);
    await view.step(() => tabTwo.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await view.step(() => {});
    expect(tab()).toBe('one');
    expect(asked).toBe(2);
  });
});

// The same screen, guarded by the shared hook rather than by a stub: the tab
// strip and an ordinary link on the page both ask the one question.
describe('a screen holding an unsaved draft', () => {
  let followed = 0;

  const Screen = () => {
    const [tab, setTab] = useState('one');
    useUnsavedDraft('The baseline text you have typed');
    return (
      <MemoryRouter>
        <Tabs value={tab} onValueChange={setTab} guard={useUnsavedGuard()}>
          <TabsList>
            <TabsTrigger value="one" to="/x?tab=one">
              One
            </TabsTrigger>
            <TabsTrigger value="two" to="/x?tab=two">
              Two
            </TabsTrigger>
          </TabsList>
          <TabsContent value="one">
            <a
              href="#/projects/p1/documents"
              id="crumb"
              onClick={(e) => {
                e.preventDefault();
                followed += 1;
              }}
            >
              Documents
            </a>
          </TabsContent>
        </Tabs>
      </MemoryRouter>
    );
  };

  const flush = () => act(async () => {});

  // A real click is a mousedown and then a click, and BOTH reach the screen's
  // guards: Radix acts on the mousedown, and the click listener the draft
  // installs sees the anchor Radix rendered. Only one of them may ask. What
  // keeps the other quiet is the `role="tab"` Radix leaves on that anchor, and
  // this is the test that has it in its hands.
  it('asks once for a real click on a tab, and it is the strip that asks', async () => {
    followed = 0;
    confirm.mockReset();
    confirm.mockResolvedValue(false);
    const view = await renderComponent(<Screen />);
    const tabTwo = [...view.container.querySelectorAll('a')].find((a) => a.textContent === 'Two');
    expect(tabTwo.getAttribute('role')).toBe('tab');

    await view.step(() => {
      tabTwo.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      tabTwo.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(confirm).toHaveBeenCalledTimes(1);
    // Refused, so the screen is where it was and the link beside the tabs is
    // still there to be asked about in its turn.
    expect(view.container.textContent).toContain('Documents');
    expect(followed).toBe(0);

    await view.unmount();
    await flush();
  });

  it('asks on a tab click and on a link click, and keeps both when refused', async () => {
    followed = 0;
    confirm.mockReset();
    confirm.mockResolvedValue(false);
    const view = await renderComponent(<Screen />);

    const tabTwo = [...view.container.querySelectorAll('a')].find((a) => a.textContent === 'Two');
    await view.step(() => tabTwo.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain('Documents');

    view.container
      .querySelector('#crumb')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flush();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(followed).toBe(0);

    await view.unmount();
    await flush();
  });
});
