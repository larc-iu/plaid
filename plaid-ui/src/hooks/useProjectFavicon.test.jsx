import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderComponent } from '../test/renderComponent.jsx';

import { useProjectFavicon } from './useProjectFavicon.js';

// Inside a project the tab wears the project's tartan, and it gets the mark
// back on the way out.

const At = ({ path }) => {
  useProjectFavicon(path);
  return null;
};

const ID = '01a0736b-fbd7-7bc0-900d-da521fe068fd';
let link;
beforeEach(() => {
  link = document.createElement('link');
  link.setAttribute('rel', 'icon');
  link.setAttribute('href', '/plaid.svg');
  document.head.append(link);
});
afterEach(() => link.remove());

describe('useProjectFavicon', () => {
  it('shows the project’s tartan inside a project, and the mark again after', async () => {
    const view = await renderComponent(<At path={`/projects/${ID}/documents/x`} />);
    expect(link.getAttribute('href')).toMatch(/^data:image\/svg\+xml,/);
    expect(decodeURIComponent(link.getAttribute('href'))).toContain('<clipPath');
    await view.unmount();
    expect(link.getAttribute('href')).toBe('/plaid.svg');
  });

  it('leaves the mark outside a project', async () => {
    const view = await renderComponent(<At path="/projects" />);
    expect(link.getAttribute('href')).toBe('/plaid.svg');
    await view.unmount();
  });
});
