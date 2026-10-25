import { describe, it, expect } from 'vitest';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { renderComponent } from '../test/renderComponent.jsx';
import { useDetailParam } from './useDetailParam.js';

// A master-detail screen's open item in the URL (A8-4): every other param
// kept, a push for each item opened, so Back steps through them.

const COMPANIONS = ['parent'];

const Probe = () => {
  const [id, set, hrefFor] = useDetailParam('item', { companions: COMPANIONS });
  const { search } = useLocation();
  const navigate = useNavigate();
  const href = hrefFor('b', { parent: 'p' });
  return (
    <>
      <span data-testid="id">{id ?? 'none'}</span>
      <span data-testid="search">{search || 'empty'}</span>
      <span data-testid="href">{href.search || 'empty'}</span>
      <button type="button" data-testid="a" onClick={() => set('a')} />
      <button type="button" data-testid="b" onClick={() => set('b')} />
      <button
        type="button"
        data-testid="new"
        onClick={() => set('new', undefined, { parent: 'a' })}
      />
      <button type="button" data-testid="swap" onClick={() => set('c', { replace: true })} />
      <button type="button" data-testid="clear" onClick={() => set(null)} />
      <button type="button" data-testid="back" onClick={() => navigate(-1)} />
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
  const click = (name) =>
    r.step(() => r.container.querySelector(`[data-testid="${name}"]`).click());
  return { ...r, text, click };
};

describe('useDetailParam', () => {
  it('opens one item after another as history entries, keeping the other params', async () => {
    const m = await mount('/v?tab=x');
    expect(m.text('id')).toBe('none');
    await m.click('a');
    await m.click('b');
    expect(m.text('search')).toBe('?tab=x&item=b');
    await m.click('back');
    expect(m.text('id')).toBe('a');
    await m.click('back');
    expect(m.text('search')).toBe('?tab=x');
    await m.unmount();
  });

  it('replaces when told to', async () => {
    const m = await mount('/v?item=a');
    await m.click('b');
    await m.click('swap');
    expect(m.text('id')).toBe('c');
    await m.click('back');
    expect(m.text('id')).toBe('a');
    await m.unmount();
  });

  it('carries a companion with one item and drops it on the next', async () => {
    const m = await mount('/v?tab=x');
    await m.click('new');
    expect(m.text('search')).toBe('?tab=x&item=new&parent=a');
    await m.click('b');
    expect(m.text('search')).toBe('?tab=x&item=b');
    await m.click('clear');
    expect(m.text('search')).toBe('?tab=x');
    await m.unmount();
  });

  it('gives a link to an item with every other param kept', async () => {
    const m = await mount('/v?tab=x&item=a&parent=q');
    expect(m.text('href')).toBe('?tab=x&item=b&parent=p');
    await m.unmount();
  });
});
