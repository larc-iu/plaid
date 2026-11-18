import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderComponent } from '../test/renderComponent.jsx';
import { useHistoryParam } from './useHistoryParam.js';

// The view of a History entry (`?historyView=document`) is set from a click on
// the entry on screen. The router commits a pick's address in a transition, so
// that click can come while the address still names the entry before, or none
// (FLK2-1): the view written then must name the entry on screen.

const seen = {};

const Probe = ({ selectedId }) => {
  const param = useHistoryParam({ selectedId, ready: true, open: vi.fn() });
  seen.setView = param.setView;
  seen.search = useLocation().search;
  return null;
};

const mount = (at, selectedId) =>
  renderComponent(
    <MemoryRouter initialEntries={[at]}>
      <Probe selectedId={selectedId} />
    </MemoryRouter>,
  );

describe('useHistoryParam setView', () => {
  it('names the entry on screen when the address still names the one before', async () => {
    const m = await mount('/d?tab=analyze&history=e1', 'e2');
    await m.step(() => seen.setView('document'));
    expect(seen.search).toBe('?tab=analyze&history=e2&historyView=document');
    await m.unmount();
  });

  it('names the entry on screen when the address names none yet', async () => {
    const m = await mount('/d?tab=analyze', 'e2');
    await m.step(() => seen.setView('document'));
    expect(seen.search).toBe('?tab=analyze&history=e2&historyView=document');
    await m.unmount();
  });

  it('back to what it changed keeps the entry and drops the view', async () => {
    const m = await mount('/d?tab=analyze&history=e2&historyView=document', 'e2');
    await m.step(() => seen.setView('changes'));
    expect(seen.search).toBe('?tab=analyze&history=e2');
    await m.unmount();
  });
});
