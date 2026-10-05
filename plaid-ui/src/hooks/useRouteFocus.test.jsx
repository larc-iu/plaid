// A new page puts focus on its heading, unless the page already put it
// somewhere, and a change to the query string alone is not a new page.
import { describe, it, expect } from 'vitest';
import { act, useEffect, useRef, useState } from 'react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { renderComponent } from '../test/renderComponent.jsx';
import { focusMain, useRouteFocus } from './useRouteFocus.js';

const settle = (ms = 40) => act(() => new Promise((r) => setTimeout(r, ms)));

let go;
const Shell = ({ children }) => {
  const location = useLocation();
  go = useNavigate();
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

const mount = () =>
  renderComponent(
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
        </Routes>
      </Shell>
    </MemoryRouter>,
  );

describe('useRouteFocus', () => {
  it('leaves focus alone on the first page', async () => {
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
});
