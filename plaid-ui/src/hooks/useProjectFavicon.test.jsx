import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderComponent } from '../test/renderComponent.jsx';

import { useProjectFavicon } from './useProjectFavicon.js';

// Inside a project the tab wears the project's tartan, and it gets the mark
// back on the way out, or keeps it when the project has tartans off.

const In = ({ project }) => {
  useProjectFavicon(project);
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
    const view = await renderComponent(<In project={{ id: ID, config: {} }} />);
    expect(link.getAttribute('href')).toMatch(/^data:image\/svg\+xml,/);
    expect(decodeURIComponent(link.getAttribute('href'))).toContain('<clipPath');
    await view.unmount();
    expect(link.getAttribute('href')).toBe('/plaid.svg');
  });

  it('keeps the mark while the project loads, and when its tartan is off', async () => {
    const loading = await renderComponent(<In project={null} />);
    expect(link.getAttribute('href')).toBe('/plaid.svg');
    await loading.unmount();
    const off = await renderComponent(
      <In project={{ id: ID, config: { plaid: { tartan: false } } }} />,
    );
    expect(link.getAttribute('href')).toBe('/plaid.svg');
    await off.unmount();
  });
});
