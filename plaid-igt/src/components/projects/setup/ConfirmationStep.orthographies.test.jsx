import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, byText, texts } from '@ui/test/renderComponent.jsx';

// The review lists what the Orthographies step lists: the additional
// orthographies, never the Baseline as one of them.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  humanizeError: (e) => String(e),
}));

const { ConfirmationStep } = await import('./ConfirmationStep.jsx');

const review = async (orthographies) => {
  const view = await renderComponent(
    <MemoryRouter>
      <ConfirmationStep
        setupData={{ basicInfo: { projectName: 'P' }, orthographies: { orthographies } }}
        isNewProject={true}
        client={{}}
      />
    </MemoryRouter>,
  );
  const card = byText(view.container, '.rounded-lg', 'orthographies');
  return { view, card };
};

const BASELINE = { name: 'Baseline', isBaseline: true };

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Project setup, the review of orthographies', () => {
  it('lists the additional orthographies only, under that heading', async () => {
    const { view, card } = await review([BASELINE, { name: 'IPA', isBaseline: false }]);
    expect(texts(card, 'p')[0]).toBe('Additional orthographies');
    expect(texts(card, 'li')).toEqual(['IPA']);
    await view.unmount();
  });

  it('says None when there are none', async () => {
    const { view, card } = await review([BASELINE]);
    expect(texts(card, 'p')).toEqual(['Additional orthographies', 'None']);
    expect(card.querySelectorAll('li')).toHaveLength(0);
    await view.unmount();
  });
});
