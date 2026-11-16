import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all, texts } from '@ui/test/renderComponent.jsx';

// A person whose text is written in some orthography read the Baseline as the
// first row of the orthography list, marked Required, and added their
// orthography's name to it as if naming the Baseline. What they made was a
// second row, empty on every word. So the Baseline is a block of its own above
// the list, saying what it is, and the list says what an orthography is.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));

const { OrthographiesSettings } = await import('./OrthographiesSettings.jsx');

const role = (r, extra = {}) => ({ plaid: { role: r }, ...extra });
const project = (orthographies) => ({
  id: 'p1',
  config: {},
  textLayers: [
    {
      id: 'text',
      config: role('baseline'),
      tokenLayers: [
        { id: 'sent', config: role('sentence'), spanLayers: [] },
        { id: 'word', config: role('word', { igt: { orthographies } }), spanLayers: [] },
      ],
    },
  ],
});
const client = {
  tokenLayers: { setConfig: vi.fn(async () => {}) },
  query: async () => ({ results: [[0]] }),
};

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const mount = async (orthographies) => {
  const view = await renderComponent(
    <OrthographiesSettings project={project(orthographies)} client={client} />,
  );
  await view.step(settle);
  return view;
};
const text = () => document.body.textContent.replace(/\s+/g, ' ');

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('Settings > Orthographies, the Baseline and the list', () => {
  it('shows the Baseline as a block of its own, not as a row of the list', async () => {
    const view = await mount([{ name: 'IPA' }]);
    const baseline = document.querySelector('[data-orth-block="baseline"]');
    expect(texts(baseline, 'h2')).toEqual(['Baseline']);
    expect(baseline.textContent).toContain('The text as typed on the Baseline tab.');
    expect(baseline.querySelector('button, input, [data-slot="badge"]')).toBeNull();
    expect(texts(document.body, '[data-orth-row]')).toEqual(['IPA']);
    expect(all(document.body, '[data-orth-row]').every((r) => !!r.querySelector('button'))).toBe(
      true,
    );
    await view.unmount();
  });

  it('heads the list "Additional orthographies" and says what one is', async () => {
    const view = await mount([{ name: 'IPA' }]);
    const list = document.querySelector('[data-orth-block="additional"]');
    expect(texts(list, 'h2')).toEqual(['Additional orthographies']);
    expect(list.textContent.replace(/\s+/g, ' ')).toContain(
      'Other ways of writing the text (IPA, another script, a normalized form). Each is a ' +
        'separate row under every word in the Analyze grid, with its own value for each word, ' +
        'empty until filled in by hand or by a tool.',
    );
    expect(list.querySelectorAll('[data-orth-row]')).toHaveLength(1);
    await view.unmount();
  });

  it('carries no Required badge and none of the old sentences', async () => {
    const view = await mount([{ name: 'IPA' }]);
    expect(text()).not.toContain('Required');
    expect(text()).not.toContain('Baseline cannot be removed');
    expect(text()).not.toContain('The ways this project');
    expect(text()).not.toContain('Add an orthography');
    await view.unmount();
  });

  it('labels the add field Name, with no example, beside "Add orthography"', async () => {
    const view = await mount([{ name: 'IPA' }]);
    const input = document.querySelector('[data-orth-block="additional"] input');
    expect(input.hasAttribute('placeholder')).toBe(false);
    const label = document.querySelector(`label[for="${input.id}"]`);
    expect(label.textContent.trim()).toBe('Name');
    expect(
      all(document.body, 'button').filter((b) => b.textContent.trim() === 'Add orthography'),
    ).toHaveLength(1);
    await view.unmount();
  });

  it('says so when there are no additional orthographies', async () => {
    const view = await mount([]);
    expect(document.querySelectorAll('[data-orth-row]')).toHaveLength(0);
    expect(document.querySelector('[data-orth-block="additional"]').textContent).toContain(
      'No additional orthographies.',
    );
    expect(document.querySelector('[data-orth-block="baseline"]')).not.toBeNull();
    await view.unmount();
  });
});
