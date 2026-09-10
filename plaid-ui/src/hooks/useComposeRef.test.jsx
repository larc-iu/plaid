// The seam between an app's character composer and this package's fields.
// It is one indirection, and it is invisible until someone types a code into a
// field the package owns, so it gets a test of its own.
import { describe, it, expect, afterEach } from 'vitest';
import { renderComponent } from '../test/renderComponent.jsx';
import { configureUi } from '../lib/uiConfig.js';
import { Textarea } from '../components/ui/textarea.jsx';
import { Input } from '../components/ui/input.jsx';

afterEach(() => configureUi());

describe('useComposeRef', () => {
  it('hands a composing field to the app’s attacher, and takes it back', async () => {
    const attached = [];
    let released = 0;
    configureUi({
      attachCompose: (el) => {
        attached.push(el);
        return () => {
          released += 1;
        };
      },
    });
    const view = await renderComponent(<Textarea compose />);
    expect(attached).toHaveLength(1);
    expect(attached[0]).toBe(view.container.querySelector('textarea'));
    await view.unmount();
    expect(released).toBe(1);
  });

  it('leaves a field alone when it does not opt in', async () => {
    const attached = [];
    configureUi({ attachCompose: (el) => attached.push(el) });
    const view = await renderComponent(<Input />);
    expect(attached).toHaveLength(0);
    await view.unmount();
  });

  it('still forwards the caller’s ref', async () => {
    const seen = [];
    configureUi({ attachCompose: () => () => {} });
    const view = await renderComponent(<Input compose ref={(el) => seen.push(el)} />);
    expect(seen[0]).toBe(view.container.querySelector('input'));
    await view.unmount();
  });

  it('is inert in an app that registers no composer', async () => {
    const view = await renderComponent(<Textarea compose />);
    expect(view.container.querySelector('textarea')).not.toBeNull();
    await view.unmount();
  });
});
