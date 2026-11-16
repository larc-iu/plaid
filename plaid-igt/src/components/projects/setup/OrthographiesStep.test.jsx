import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all, texts } from '@ui/test/renderComponent.jsx';

// Setup's step says what Settings says: the Baseline is a block of its own,
// the list is headed "Additional orthographies", and adding asks for a Name.
// Its default list (IPA) and what it hands the wizard are unchanged.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
}));

const { OrthographiesStep } = await import('./OrthographiesStep.jsx');

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const text = () => document.body.textContent.replace(/\s+/g, ' ');

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Project setup, the Orthographies step', () => {
  it('shows the Baseline apart from the list, as Settings does', async () => {
    const onDataChange = vi.fn();
    const view = await renderComponent(<OrthographiesStep data={{}} onDataChange={onDataChange} />);
    await view.step(settle);
    const baseline = document.querySelector('[data-orth-block="baseline"]');
    expect(texts(baseline, 'h2')).toEqual(['Baseline']);
    expect(baseline.textContent).toContain('The text as typed on the Baseline tab.');
    const list = document.querySelector('[data-orth-block="additional"]');
    expect(texts(list, 'h2')).toEqual(['Additional orthographies']);
    expect(list.textContent.replace(/\s+/g, ' ')).toContain(
      'Each is a separate row under every word in the Analyze grid, with its own value for ' +
        'each word, empty until filled in by hand or by a tool.',
    );
    expect(texts(document.body, '[data-orth-row]')).toEqual(['IPA']);
    expect(text()).not.toContain('Required');
    expect(text()).not.toContain('is the text as you type it');
    expect(text()).not.toContain('Add other ways of writing each word');
    const input = list.querySelector('input');
    expect(input.hasAttribute('placeholder')).toBe(false);
    expect(document.querySelector(`label[for="${input.id}"]`).textContent.trim()).toBe('Name');
    expect(
      all(document.body, 'button').filter((b) => b.textContent.trim() === 'Add orthography'),
    ).toHaveLength(1);
    // What the wizard is handed keeps the Baseline row first, as before.
    expect(onDataChange).toHaveBeenCalledWith({
      orthographies: [
        { name: 'Baseline', isBaseline: true },
        { name: 'IPA', isBaseline: false },
      ],
    });
    await view.unmount();
  });
});
