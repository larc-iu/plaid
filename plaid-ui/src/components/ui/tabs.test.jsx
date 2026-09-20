// A tab group with a guard asks before it leaves the tab it is on.
import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '../../test/renderComponent.jsx';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs.jsx';

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
