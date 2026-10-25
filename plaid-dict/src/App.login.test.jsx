import { describe, it, expect, afterEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import App from './App.jsx';

// The sign-in chain is plaid-ui's, as in the other apps (R2-DICT-10): the
// shared form, whose empty fields the browser refuses before anything is sent.

let view;
afterEach(async () => {
  await view?.unmount();
  window.location.hash = '';
});

describe('signing in to the dictionary', () => {
  it('shows the shared sign-in form, its fields required', async () => {
    window.location.hash = '#/login';
    view = await renderComponent(<App />);
    const email = view.container.querySelector('#email');
    const password = view.container.querySelector('#password');
    expect(email.required).toBe(true);
    expect(password.required).toBe(true);
    expect(view.container.textContent).toContain('Sign in to Plaid Dictionary');
  });

  it('sends a reader who is not signed in to the sign-in form', async () => {
    window.location.hash = '#/';
    view = await renderComponent(<App />);
    expect(window.location.hash).toBe('#/login');
    expect(view.container.querySelector('#email')).not.toBeNull();
  });
});
