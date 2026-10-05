// A tab reached with the keyboard shows where focus is.
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '../../test/renderComponent.jsx';
import { Tabs, TabsList, TabsTrigger } from './tabs.jsx';

describe('TabsTrigger focus ring', () => {
  it('draws a ring on keyboard focus, as a button and as a link', async () => {
    const view = await renderComponent(
      <MemoryRouter>
        <Tabs value="one">
          <TabsList>
            <TabsTrigger value="one">One</TabsTrigger>
            <TabsTrigger value="two" to="/x?tab=two">
              Two
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </MemoryRouter>,
    );
    const tabs = [...view.container.querySelectorAll('[role=tab]')];
    expect(tabs).toHaveLength(2);
    for (const tab of tabs) expect(tab.className).toContain('focus-visible:ring-2');
    await view.unmount();
  });
});
