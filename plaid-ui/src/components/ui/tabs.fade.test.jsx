// A tab strip wider than its box fades out at each edge that has tabs past it,
// the one sign of more tabs where the scrollbar is an overlay.
import { describe, it, expect, vi, afterEach } from 'vitest';
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

  // A strip already as wide as its box keeps that width when a tab's label
  // grows ("Comments 9" to "Comments 10"), so watching the strip's own box
  // alone left the fade as it was. Every tab is watched as well.
  describe('when a tab changes size but the strip does not', () => {
    let observers = [];
    class FakeResizeObserver {
      constructor(cb) {
        this.cb = cb;
        this.targets = new Set();
        observers.push(this);
      }
      observe(el) {
        this.targets.add(el);
      }
      unobserve(el) {
        this.targets.delete(el);
      }
      disconnect() {
        this.targets.clear();
      }
    }
    afterEach(() => {
      vi.unstubAllGlobals();
      observers = [];
    });

    it('measures again', async () => {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      const view = await renderComponent(strip());
      const list = view.container.querySelector('[role="tablist"]');
      const tabs = [...list.querySelectorAll('[role="tab"]')];
      const watching = observers.find((o) => o.targets.has(list));
      expect(watching).toBeTruthy();
      for (const tab of tabs) expect(watching.targets.has(tab)).toBe(true);

      await view.step(() => {
        size(list, { scrollWidth: 800, clientWidth: 500 });
        watching.cb([{ target: tabs[1] }]);
      });
      expect(list.style.maskImage).toContain('transparent');
      await view.unmount();
      expect(watching.targets.size).toBe(0);
    });

    it('watches a tab added later', async () => {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      const view = await renderComponent(strip());
      const list = view.container.querySelector('[role="tablist"]');
      const watching = observers.find((o) => o.targets.has(list));
      const added = document.createElement('button');
      added.setAttribute('role', 'tab');
      await view.step(() => {
        list.appendChild(added);
      });
      expect(watching.targets.has(added)).toBe(true);
      await view.unmount();
    });
  });

  // The current tab is brought clear of the fade, not just to the edge where
  // the fade covers it. ud's Comments tab, with Details past it, was drawn cut
  // and pale at 390px, and so was "Project Settings" once the page's own
  // scrollbar arrived after the first reveal and made the strip narrower.
  describe('the current tab', () => {
    let observers = [];
    class FakeResizeObserver {
      constructor(cb) {
        this.cb = cb;
        observers.push(this);
      }
      observe() {}
      disconnect() {}
    }
    const rect = (left, width) => ({ left, right: left + width, width, top: 0, bottom: 36 });
    // A strip whose second tab sits at 460 to 560 when the strip is scrolled
    // to 0. The strip is `box` wide, and holds 800px of tabs.
    const layout = (list, box) => {
      Object.defineProperty(list, 'clientWidth', { configurable: true, value: box });
      Object.defineProperty(list, 'scrollWidth', { configurable: true, value: 800 });
      list.getBoundingClientRect = () => rect(0, box);
      const [, two] = list.querySelectorAll('[role="tab"]');
      two.getBoundingClientRect = () => rect(460 - list.scrollLeft, 100);
    };
    const onTwo = () => (
      <MemoryRouter>
        <Tabs value="two" onValueChange={() => {}}>
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
    afterEach(() => {
      vi.unstubAllGlobals();
      observers = [];
    });

    it('is scrolled clear of the fade at the end', async () => {
      const view = await renderComponent(onTwo());
      const list = view.container.querySelector('[role="tablist"]');
      await view.step(() => {
        list.scrollLeft = 0;
        layout(list, 500);
        // A change of the current tab is what reveals it.
        list.querySelector('[role="tab"]').setAttribute('data-state', 'inactive');
      });
      // Its right edge (560) at 500 - 32, the start of the fade.
      expect(list.scrollLeft).toBe(92);
      await view.unmount();
    });

    it('is brought back into sight when the strip gets narrower', async () => {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
      const view = await renderComponent(onTwo());
      const list = view.container.querySelector('[role="tablist"]');
      const watching = observers[0];
      await view.step(() => {
        list.scrollLeft = 0;
        layout(list, 600);
        watching.cb([]);
      });
      expect(list.scrollLeft).toBe(0);
      await view.step(() => {
        layout(list, 500);
        watching.cb([]);
      });
      expect(list.scrollLeft).toBe(92);
      await view.unmount();
    });
  });
});
