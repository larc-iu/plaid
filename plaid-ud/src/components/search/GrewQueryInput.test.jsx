import { describe, it, expect } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { parse, parseGrs } from '../../grew/parser.js';
import { GrewParseError, GrewUnsupportedError } from '../../grew/errors.js';
import { GrewQueryInput } from './GrewQueryInput.jsx';

// A query that is valid Grew but uses something UD cannot run is a warning
// (the reader can rephrase it), and a query that does not parse or a search
// that failed is an error. Both are shared Notices announced as alerts, and
// neither borrows the amber of a contributor's value.

const errorOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
};

const mount = (error) =>
  renderComponent(
    <GrewQueryInput value="" onChange={() => {}} onRun={() => {}} running={false} error={error} />,
  );

describe('the Grew query box’s error notice', () => {
  it('shows an unsupported feature as a warning alert', async () => {
    const error = errorOf(() => parseGrs('package p { }'));
    expect(error).toBeInstanceOf(GrewUnsupportedError);
    const view = await mount(error);
    const notice = view.container.querySelector('[data-tone]');
    expect(notice.getAttribute('data-tone')).toBe('warning');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.querySelector('p.font-medium').textContent).toBe('Unsupported feature');
    expect(notice.textContent).toContain(error.message);
    expect(notice.querySelector('svg[aria-hidden="true"]')).not.toBe(null);
    expect(view.container.innerHTML).not.toMatch(/amber-/);
    await view.unmount();
  });

  it('shows a syntax error as an error alert with its caret', async () => {
    const error = errorOf(() => parse('pattern { X [upos=] }'));
    expect(error).toBeInstanceOf(GrewParseError);
    const view = await mount(error);
    const notice = view.container.querySelector('[data-tone]');
    expect(notice.getAttribute('data-tone')).toBe('error');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.querySelector('p.font-medium').textContent).toMatch(/^Syntax error/);
    expect(notice.querySelector('pre').textContent).toMatch(/\^$/);
    await view.unmount();
  });

  it('shows a failed search as an error alert', async () => {
    const view = await mount(new Error('Could not reach the server'));
    const notice = view.container.querySelector('[data-tone]');
    expect(notice.getAttribute('data-tone')).toBe('error');
    expect(notice.textContent).toBe('Failed to searchCould not reach the server');
    await view.unmount();
  });

  it('shows nothing when there is no error', async () => {
    const view = await mount(null);
    expect(view.container.querySelector('[data-tone]')).toBe(null);
    expect(view.container.querySelector('[role="alert"]')).toBe(null);
    await view.unmount();
  });
});
