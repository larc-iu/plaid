import { describe, it, expect } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderComponent } from '../../test/renderComponent.jsx';
import { useConversationParam } from './conversationParam.js';

// The Assistant tab keeps the conversation in the URL, so a thread is
// shareable and the back button works. Everything else in the query string
// belongs to the screen and has to survive.

const Probe = () => {
  const [id, set] = useConversationParam();
  const { search } = useLocation();
  return (
    <>
      <span data-testid="id">{id ?? 'none'}</span>
      <span data-testid="search">{search || 'empty'}</span>
      <button type="button" data-testid="open" onClick={() => set('c2')} />
      <button type="button" data-testid="clear" onClick={() => set(null, { replace: true })} />
    </>
  );
};

const mount = async (at) => {
  const r = await renderComponent(
    <MemoryRouter initialEntries={[at]}>
      <Probe />
    </MemoryRouter>,
  );
  const text = (name) => r.container.querySelector(`[data-testid="${name}"]`).textContent;
  const click = (name) => r.container.querySelector(`[data-testid="${name}"]`).click();
  return { ...r, text, click };
};

describe('useConversationParam', () => {
  it('reads the conversation the URL names', async () => {
    const m = await mount('/projects/p1?tab=assistant&conversation=c1');
    expect(m.text('id')).toBe('c1');
    await m.unmount();
  });

  it('names none when the URL does not', async () => {
    const m = await mount('/projects/p1?tab=assistant');
    expect(m.text('id')).toBe('none');
    await m.unmount();
  });

  it('opens another without losing what else is in the query', async () => {
    const m = await mount('/projects/p1?tab=assistant&conversation=c1');
    await m.step(() => m.click('open'));
    expect(m.text('id')).toBe('c2');
    expect(m.text('search')).toBe('?tab=assistant&conversation=c2');
    await m.unmount();
  });

  it('drops the conversation and keeps the tab', async () => {
    const m = await mount('/projects/p1?tab=assistant&conversation=c1');
    await m.step(() => m.click('clear'));
    expect(m.text('id')).toBe('none');
    expect(m.text('search')).toBe('?tab=assistant');
    await m.unmount();
  });
});
