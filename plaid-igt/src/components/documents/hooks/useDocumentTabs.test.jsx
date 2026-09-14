import { describe, it, expect } from 'vitest';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { useDocumentTabs } from './useDocumentTabs.js';

// The tab a document opens on is a URL decision made partly by the app, and the
// ways it goes wrong are quiet. A landing that fires twice sends a reader who
// walked back to Metadata straight to Analyze again. A landing that pushes
// instead of replacing makes Back undo the landing rather than leave the
// document. And a landing on a snapshot moves the reader off the tab their
// history click was about.

const tokenized = { sentences: [{ tokens: [{ id: 't1' }] }] };
const untokenized = { sentences: [{ tokens: [] }] };

// The probe hands what it knows out on a stable object, since a test cannot
// read a setter or a navigate off the DOM.
const hook = {};
const last = () => hook.last;
const goBack = () => hook.navigate(-1);

const Probe = ({ doc, asOf = null }) => {
  const [activeTab, setActiveTab] = useDocumentTabs({ doc, asOf });
  const { pathname, search } = useLocation();
  hook.navigate = useNavigate();
  hook.last = { activeTab, setActiveTab, pathname, search };
  return <span data-testid="tab">{activeTab}</span>;
};

const mount = async (entries, props) => {
  const view = await renderComponent(
    <MemoryRouter initialEntries={entries}>
      <Probe {...props} />
    </MemoryRouter>,
  );
  return view;
};

describe('the document tab', () => {
  it('lands on Analyze for a tokenized document nobody asked a tab for', async () => {
    const view = await mount(['/d'], { doc: tokenized });
    expect(last().activeTab).toBe('analyze');
    expect(last().search).toBe('?tab=analyze');
    await view.unmount();
  });

  it('leaves an untokenized document on Metadata', async () => {
    const view = await mount(['/d'], { doc: untokenized });
    expect(last().activeTab).toBe('metadata');
    await view.unmount();
  });

  it('honours a tab the URL asked for', async () => {
    const view = await mount(['/d?tab=baseline'], { doc: tokenized });
    expect(last().activeTab).toBe('baseline');
    await view.unmount();
  });

  it('honours Metadata asked for by name, which is why the fallback writes itself', async () => {
    // A bare URL means "no tab chosen" here, so `?tab=metadata` is the only way
    // to say Metadata and have it stay.
    const view = await mount(['/d?tab=metadata'], { doc: tokenized });
    expect(last().activeTab).toBe('metadata');
    await view.unmount();
  });

  it('lands once, so walking back to Metadata sticks', async () => {
    const view = await mount(['/d'], { doc: tokenized });
    expect(last().activeTab).toBe('analyze');
    await view.step(() => last().setActiveTab('metadata'));
    expect(last().activeTab).toBe('metadata');
    // The document is re-read (a save, an applied plan). A fresh object must
    // not send the reader back to Analyze.
    await view.rerender(
      <MemoryRouter initialEntries={['/d']}>
        <Probe doc={{ sentences: [{ tokens: [{ id: 't1' }] }] }} />
      </MemoryRouter>,
    );
    expect(last().activeTab).toBe('metadata');
    await view.unmount();
  });

  it('does not land while a snapshot is being viewed', async () => {
    const view = await mount(['/d'], { doc: tokenized, asOf: '2026-09-01T00:00:00Z' });
    expect(last().activeTab).toBe('metadata');
    await view.unmount();
  });

  it('waits for the document', async () => {
    const view = await mount(['/d'], { doc: null });
    expect(last().activeTab).toBe('metadata');
    await view.unmount();
  });

  it('leaves the document on Back instead of undoing the landing', async () => {
    const view = await mount(['/projects/p', '/d'], { doc: tokenized });
    expect(last().activeTab).toBe('analyze');
    await view.step(() => goBack());
    expect(last().pathname).toBe('/projects/p');
    await view.unmount();
  });

  it('switches when the island asks for a tab', async () => {
    const view = await mount(['/d?tab=analyze'], { doc: tokenized });
    await view.step(() =>
      window.dispatchEvent(new CustomEvent('igt:navigate-tab', { detail: { tab: 'tokenize' } })),
    );
    expect(last().activeTab).toBe('tokenize');
    await view.unmount();
  });

  it('ignores an island event that names no tab', async () => {
    const view = await mount(['/d?tab=analyze'], { doc: tokenized });
    await view.step(() =>
      window.dispatchEvent(new CustomEvent('igt:navigate-tab', { detail: {} })),
    );
    expect(last().activeTab).toBe('analyze');
    await view.unmount();
  });

  it('stops listening once the screen is gone', async () => {
    const view = await mount(['/d?tab=analyze'], { doc: tokenized });
    await view.unmount();
    // Nothing left to throw at: the listener went with the screen.
    window.dispatchEvent(new CustomEvent('igt:navigate-tab', { detail: { tab: 'tokenize' } }));
    expect(last().activeTab).toBe('analyze');
  });
});
