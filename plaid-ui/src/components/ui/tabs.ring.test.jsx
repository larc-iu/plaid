// A tab reached with the keyboard shows where focus is.
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '../../test/renderComponent.jsx';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs.jsx';

describe('TabsTrigger focus ring', () => {
  it('draws a ring on keyboard focus, as a button, as a link and on the panel', async () => {
    const view = await renderComponent(
      <MemoryRouter>
        <Tabs value="one">
          <TabsList>
            <TabsTrigger value="one">One</TabsTrigger>
            <TabsTrigger value="two" to="/x?tab=two">
              Two
            </TabsTrigger>
          </TabsList>
          <TabsContent value="one">Panel</TabsContent>
        </Tabs>
      </MemoryRouter>,
    );
    const tabs = [...view.container.querySelectorAll('[role=tab]')];
    expect(tabs).toHaveLength(2);
    for (const tab of tabs) expect(tab.className).toContain('focus-visible:ring-2');
    // The panel is a stop in the Tab order too.
    const panel = view.container.querySelector('[role=tabpanel]');
    expect(panel.getAttribute('tabindex')).toBe('0');
    expect(panel.className).toContain('focus-visible:ring-2');
    await view.unmount();
  });
});
