import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { ValidationHeader } from './ValidationHeader.jsx';

const mount = (props) =>
  renderComponent(<ValidationHeader description="Values off the lists." {...props} />);

describe('ValidationHeader', () => {
  it('heads the tab with an h2, the line under it, and "Check again"', async () => {
    const onCheck = vi.fn();
    const { container, unmount } = await mount({ onCheck });
    expect(container.querySelector('h2').textContent).toBe('Validation');
    expect(container.querySelector('p').textContent).toBe('Values off the lists.');
    const button = container.querySelector('button');
    expect(button.textContent).toBe('Check again');
    button.click();
    expect(onCheck).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it('says it is checking while it is, and cannot be pressed', async () => {
    const { container, unmount } = await mount({ busy: true, onCheck: () => {} });
    const button = container.querySelector('button');
    expect(button.textContent).toBe('Checking…');
    expect(button.disabled).toBe(true);
    await unmount();
  });

  it('cannot be pressed when there is nothing to check', async () => {
    const { container, unmount } = await mount({ disabled: true, onCheck: () => {} });
    expect(container.querySelector('button').disabled).toBe(true);
    await unmount();
  });
});
