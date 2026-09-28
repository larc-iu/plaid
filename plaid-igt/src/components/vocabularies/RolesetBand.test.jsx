import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { renderComponent, texts } from '@ui/test/renderComponent.jsx';
import { RolesetBand } from './RolesetBand';

// Types into a controlled input the way a key press does: the input's value
// set, then an input event React hears.
const type = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

// The band inside a draft that holds its fields, as the entry editor's does.
const mount = async (initial) => {
  const seen = { fields: initial };
  let reset;
  const Harness = () => {
    const [fields, setFields] = useState(initial);
    seen.fields = fields;
    reset = setFields;
    return <RolesetBand uid="e1" fields={fields} setFields={setFields} />;
  };
  const view = await renderComponent(<Harness />);
  const input = (label) => view.container.querySelector(`input[aria-label="${label}"]`);
  const keys = async (label, text) => {
    for (const ch of text) await view.step(() => type(input(label), input(label).value + ch));
  };
  const backspace = async (label) =>
    view.step(() => type(input(label), input(label).value.slice(0, -1)));
  return { ...view, seen, input, keys, backspace, reset: (f) => view.step(() => reset(f)) };
};

// An empty roleset read "leave-02" in every lexicon, Arapaho and Lamkang
// included, where it looked like a value the entry had. A placeholder names
// the box, as every other field's does, and never shows an example value.
describe('RolesetBand', () => {
  it('names its boxes rather than showing example values', async () => {
    const fields = { umr: { roleset: '', args: { ARG0: '' } } };
    const { container, unmount } = await renderComponent(
      <RolesetBand uid="e1" fields={fields} setFields={() => {}} />,
    );
    const placeholders = [...container.querySelectorAll('input[placeholder]')].map((i) =>
      i.getAttribute('placeholder'),
    );
    expect(placeholders).toEqual(['Roleset', 'Description']);
    await unmount();
  });

  it('keeps a space typed at the end of a description', async () => {
    const view = await mount({ umr: { roleset: 'ver-01', args: { ARG0: '' } } });
    await view.keys('Argument 1 description', 'the giver');
    expect(view.input('Argument 1 description').value).toBe('the giver');
    expect(view.seen.fields.umr.args).toEqual({ ARG0: 'the giver' });
    await view.keys('Argument 1 description', ' ');
    expect(view.input('Argument 1 description').value).toBe('the giver ');
    expect(view.seen.fields.umr.args).toEqual({ ARG0: 'the giver' });
    await view.unmount();
  });

  it('keeps a row whose name is being retyped, and its argument in the entry', async () => {
    const view = await mount({
      umr: { roleset: 'ver-01', args: { ARG0: 'giver', ARG1: 'thing', ARG2: 'recipient' } },
    });
    await view.backspace('Argument 3 name');
    expect(view.input('Argument 3 name').value).toBe('ARG');
    expect(view.input('Argument 3 description').value).toBe('recipient');
    expect(texts(view.container, 'p.text-destructive')).toEqual([
      'An argument is named ARG0, ARG1 and so on: ARG',
    ]);
    expect(view.seen.fields.umr.args).toEqual({ ARG0: 'giver', ARG1: 'thing', ARG2: 'recipient' });
    await view.keys('Argument 3 name', '3');
    expect(texts(view.container, 'p.text-destructive')).toEqual([]);
    expect(view.seen.fields.umr.args).toEqual({ ARG0: 'giver', ARG1: 'thing', ARG3: 'recipient' });
    await view.unmount();
  });

  it('keeps two rows given one name apart, and says so', async () => {
    const view = await mount({ umr: { args: { ARG0: 'giver', ARG1: 'thing' } } });
    await view.step(() => type(view.input('Argument 2 name'), 'ARG0'));
    expect(view.input('Argument 2 description').value).toBe('thing');
    expect(texts(view.container, 'p.text-destructive')).toEqual(['ARG0 is named twice.']);
    expect(view.seen.fields.umr.args).toEqual({ ARG0: 'giver', ARG1: 'thing' });
    await view.unmount();
  });

  it('shows the entry again when the draft is put back from outside', async () => {
    const view = await mount({ umr: { roleset: 'ver-01', args: { ARG0: 'giver' } } });
    await view.keys('Argument 1 description', ' of');
    await view.reset({ umr: { roleset: 'ver-02', args: { ARG1: 'thing' } } });
    expect(view.input('Argument 1 name').value).toBe('ARG1');
    expect(view.input('Argument 1 description').value).toBe('thing');
    await view.reset({ gloss: 'give' });
    expect(view.input('Argument 1 name')).toBeNull();
    await view.unmount();
  });

  it('keeps what is typed when another field of the entry changes', async () => {
    const view = await mount({ umr: { args: { ARG0: 'giver' } } });
    await view.keys('Argument 1 description', ' ');
    await view.reset({ ...view.seen.fields, gloss: 'give' });
    expect(view.input('Argument 1 description').value).toBe('giver ');
    await view.unmount();
  });
});
