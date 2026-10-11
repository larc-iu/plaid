import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { SegmentedControl } from './SegmentedControl.jsx';

// One control for a choice of one among a few, in every app.
describe('SegmentedControl', () => {
  const options = [
    { value: 'a', label: 'Current', count: 3 },
    { value: 'b', label: 'Outdated', count: 0 },
  ];

  it('names its group, presses the chosen segment and shows each count', async () => {
    const view = await renderComponent(
      <SegmentedControl label="Which threads" value="a" onChange={() => {}} options={options} />,
    );
    const group = view.container.querySelector('[role="group"]');
    expect(group.getAttribute('aria-label')).toBe('Which threads');
    const buttons = [...group.querySelectorAll('button')];
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    expect(buttons.map((b) => b.textContent)).toEqual(['Current3', 'Outdated0']);
    await view.unmount();
  });

  it('reports the segment pressed', async () => {
    const onChange = vi.fn();
    const view = await renderComponent(
      <SegmentedControl label="x" value="a" onChange={onChange} options={options} />,
    );
    await view.step(() => view.container.querySelectorAll('button')[1].click());
    expect(onChange).toHaveBeenCalledWith('b');
    await view.unmount();
  });
});
