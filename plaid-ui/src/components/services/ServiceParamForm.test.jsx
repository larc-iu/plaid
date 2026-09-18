import { describe, it, expect } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { ServiceParamForm } from './ServiceParamForm.jsx';

// A `field` parameter is chosen from the project's fields when the app lists
// them, and typed like any string when it does not.
const SCHEMA = [
  { key: 'gloss_field', label: 'Gloss field', type: 'field', scope: 'Morpheme', default: 'Gloss' },
];

describe('ServiceParamForm, a field parameter', () => {
  it("offers the project's fields at the parameter's scope", async () => {
    const { container, unmount } = await renderComponent(
      <ServiceParamForm
        schema={SCHEMA}
        values={{ gloss_field: 'Gloss (pmy)' }}
        onChange={() => {}}
        fields={{ Morpheme: ['Gloss (pmy)', 'Gloss (en)'], Sentence: ['Translation'] }}
      />,
    );
    const trigger = container.querySelector('#svc-param-gloss_field');
    expect(trigger.getAttribute('role')).toBe('combobox');
    expect(trigger.textContent).toBe('Gloss (pmy)');
    expect(container.querySelector('input')).toBeNull();
    await unmount();
  });

  it('asks for a choice when none is made, and says when there is none to make', async () => {
    const r = await renderComponent(
      <ServiceParamForm
        schema={SCHEMA}
        values={{ gloss_field: '' }}
        onChange={() => {}}
        fields={{ Morpheme: ['Gloss (pmy)', 'Gloss (en)'] }}
      />,
    );
    expect(r.container.querySelector('#svc-param-gloss_field').textContent).toBe('Choose a field');
    await r.rerender(
      <ServiceParamForm
        schema={SCHEMA}
        values={{ gloss_field: '' }}
        onChange={() => {}}
        fields={{ Morpheme: [] }}
      />,
    );
    const trigger = r.container.querySelector('#svc-param-gloss_field');
    expect(trigger.textContent).toBe('No fields');
    expect(trigger.disabled).toBe(true);
    await r.unmount();
  });

  it('is a text box without the fields', async () => {
    const { container, unmount } = await renderComponent(
      <ServiceParamForm schema={SCHEMA} values={{ gloss_field: 'Gloss' }} onChange={() => {}} />,
    );
    expect(container.querySelector('input#svc-param-gloss_field').value).toBe('Gloss');
    await unmount();
  });
});
