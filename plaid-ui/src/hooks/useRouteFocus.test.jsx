// A new page puts focus on its heading, unless the page already put it
// somewhere, and a change to the query string alone is not a new page.
import { describe, it, expect } from 'vitest';
import { StrictMode, act, useEffect, useRef, useState } from 'react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { renderComponent } from '../test/renderComponent.jsx';
import { focusMain, useRouteFocus } from './useRouteFocus.js';

const settle = (ms = 40) => act(() => new Promise((r) => setTimeout(r, ms)));

const nav = { to: null };
const go = (path) => nav.to(path);
const Shell = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    nav.to = navigate;
  }, [navigate]);
  const main = useRef(null);
  useRouteFocus(location.pathname, main);
  return (
    <>
      <a href="#x" data-id="header-link">
        Projects
      </a>
      <main ref={main}>{children}</main>
    </>
  );
};

// A heading that arrives after the data does.
const Late = ({ title }) => {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 10);
    return () => clearTimeout(t);
  }, []);
  return ready ? <h1>{title}</h1> : <p>Loading</p>;
};

// A page whose tab strip is its own, drawn afresh on every tab (ud, umr).
const Strip = ({ on }) => (
  <>
    <h1>Project</h1>
    <div role="tablist">
      {['t1', 't2'].map((t) => (
        <button key={t} role="tab" aria-selected={t === on} data-tab={t}>
          {t}
        </button>
      ))}
    </div>
  </>
);

// A page that holds focus for a moment, then lets it go.
const Flicker = () => {
  const [held, setHeld] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setHeld(false), 20);
    return () => clearTimeout(t);
  }, []);
  return (
    <>
      <h1>Flicker</h1>
      {held && <input aria-label="Brief" autoFocus />}
    </>
  );
};

const mount = () =>
  renderComponent(
    <StrictMode>
      <MemoryRouter initialEntries={['/a']}>
        <Shell>
          <Routes>
            <Route path="/a" element={<h1>Page A</h1>} />
            <Route path="/b" element={<Late title="Page B" />} />
            <Route
              path="/typing"
              element={
                <>
                  <h1>New</h1>
                  <textarea aria-label="Text" autoFocus />
                </>
              }
            />
            <Route path="/t1" element={<Strip key="t1" on="t1" />} />
            <Route path="/t2" element={<Strip key="t2" on="t2" />} />
            <Route path="/flicker" element={<Flicker />} />
          </Routes>
        </Shell>
      </MemoryRouter>
    </StrictMode>,
  );

describe('useRouteFocus', () => {
  it('leaves focus alone on the first page, under StrictMode too', async () => {
    const view = await mount();
    await settle();
    expect(document.activeElement).toBe(document.body);
    await view.unmount();
  });

  it('focuses the new page heading once it is drawn, from a header link', async () => {
    const view = await mount();
    await act(async () => view.container.querySelector('[data-id=header-link]').focus());
    await act(async () => go('/b'));
    await settle();
    expect(document.activeElement.textContent).toBe('Page B');
    expect(document.activeElement.getAttribute('tabindex')).toBe('-1');
    await view.unmount();
  });

  it('leaves focus where the new page put it', async () => {
    const view = await mount();
    await act(async () => go('/typing'));
    await settle();
    expect(document.activeElement.getAttribute('aria-label')).toBe('Text');
    await view.unmount();
  });

  it('does not move focus for a query string change', async () => {
    const view = await mount();
    const link = view.container.querySelector('[data-id=header-link]');
    await act(async () => link.focus());
    await act(async () => go('/a?tab=two'));
    await settle();
    expect(document.activeElement).toBe(link);
    await view.unmount();
  });

  it('focusMain, the skip link, goes to the heading', async () => {
    const view = await mount();
    focusMain(view.container.querySelector('main'));
    expect(document.activeElement.textContent).toBe('Page A');
    await view.unmount();
  });

  it("puts focus on the new page's selected tab when a tab of the old strip had it", async () => {
    const view = await mount();
    await act(async () => go('/t1'));
    await settle();
    await act(async () => view.container.querySelector('[data-tab=t1]').focus());
    await act(async () => go('/t2'));
    await settle();
    expect(document.activeElement.getAttribute('data-tab')).toBe('t2');
    await view.unmount();
  });

  it('counts focus the page held and lost as lost, and goes to the heading', async () => {
    const view = await mount();
    await act(async () => go('/flicker'));
    await settle(80);
    expect(document.activeElement.textContent).toBe('Flicker');
    await view.unmount();
  });
});
