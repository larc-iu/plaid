import { describe, it, expect } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { Loading } from './Loading.jsx';

// The one loading line a screen or a panel shows.
describe('Loading', () => {
  it('says Loading… in a muted line', async () => {
    const view = await renderComponent(<Loading />);
    const line = view.container.querySelector('p');
    expect(line.textContent).toBe('Loading…');
    expect(line.className).toContain('text-muted-foreground');
    expect(line.className).toContain('p-4');
    // No spinner: the text is the whole indicator.
    expect(view.container.querySelector('svg, .animate-spin')).toBeNull();
    await view.unmount();
  });

  it('takes its own words and replaces the padding it is told to', async () => {
    const view = await renderComponent(<Loading label="Loading entries…" className="p-0" />);
    const line = view.container.querySelector('p');
    expect(line.textContent).toBe('Loading entries…');
    expect(line.className.split(' ')).toContain('p-0');
    expect(line.className.split(' ')).not.toContain('p-4');
    await view.unmount();
  });
});
