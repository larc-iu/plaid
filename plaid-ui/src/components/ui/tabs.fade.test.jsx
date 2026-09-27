// A tab strip wider than its box fades out at each edge that has tabs past it,
// the one sign of more tabs where the scrollbar is an overlay.
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '../../test/renderComponent.jsx';
import { Tabs, TabsList, TabsTrigger } from './tabs.jsx';

const strip = () => (
  <MemoryRouter>
    <Tabs value="one" onValueChange={() => {}}>
      <TabsList>
        <TabsTrigger value="one" to="/x?tab=one">
          One
        </TabsTrigger>
        <TabsTrigger value="two" to="/x?tab=two">
          Two
        </TabsTrigger>
      </TabsList>
    </Tabs>
  </MemoryRouter>
);

// jsdom lays nothing out, so the strip is given its sizes by hand.
const size = (list, { scrollWidth, clientWidth, scrollLeft = 0 }) => {
  Object.defineProperty(list, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(list, 'clientWidth', { configurable: true, value: clientWidth });
  list.scrollLeft = scrollLeft;
};

describe('a tab strip that does not fit', () => {
  it('fades only the edges with tabs past them', async () => {
    const view = await renderComponent(strip());
    const list = view.container.querySelector('[role="tablist"]');
    expect(list.style.maskImage).toBe('');

    await view.step(() => {
      size(list, { scrollWidth: 800, clientWidth: 500 });
      list.dispatchEvent(new Event('scroll'));
    });
    expect(list.style.maskImage).toBe(
      'linear-gradient(to right, black, black calc(100% - 2rem), transparent)',
    );

    await view.step(() => {
      size(list, { scrollWidth: 800, clientWidth: 500, scrollLeft: 150 });
      list.dispatchEvent(new Event('scroll'));
    });
    expect(list.style.maskImage).toBe(
      'linear-gradient(to right, transparent, black 2rem, black calc(100% - 2rem), transparent)',
    );

    await view.step(() => {
      size(list, { scrollWidth: 800, clientWidth: 500, scrollLeft: 300 });
      list.dispatchEvent(new Event('scroll'));
    });
    expect(list.style.maskImage).toBe('linear-gradient(to right, transparent, black 2rem, black)');
    await view.unmount();
  });

  it('does not fade a strip that fits', async () => {
    const view = await renderComponent(strip());
    const list = view.container.querySelector('[role="tablist"]');
    await view.step(() => {
      size(list, { scrollWidth: 500, clientWidth: 500 });
      list.dispatchEvent(new Event('scroll'));
    });
    expect(list.style.maskImage).toBe('');
    await view.unmount();
  });
});
