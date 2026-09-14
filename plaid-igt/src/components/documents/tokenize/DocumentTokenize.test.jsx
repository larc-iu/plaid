import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { DocumentProvider } from '../contexts/DocumentContext.jsx';
import { TokenComponent } from './DocumentTokenize.jsx';

// Alt+click on a word here opens the same word on the Analyze tab. It used to
// ask for the tab by dispatching a window event that the tab hook listens for,
// which is the island's way in and not a React screen's: both sit under one
// provider, and a listener is invisible to anything reading this file. The
// switch now goes through the context, and nothing on the window hears it.

const piece = { id: 'w1', begin: 0, end: 3, content: 'abc', isToken: true };
const sentence = { id: 's1', pieces: [piece] };

const mount = (ctx, props) =>
  renderComponent(
    <DocumentProvider value={{ doc: { id: 'd1' }, goToTab: () => {}, ...ctx }}>
      <TokenComponent
        ops={{ splitSentence: () => {} }}
        sentence={sentence}
        piece={piece}
        pieceIndex={1}
        drag={null}
        setDrag={() => {}}
        dragRef={{ current: null }}
        {...props}
      />
    </DocumentProvider>,
  );

const click = (el, init) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));

afterEach(() => vi.restoreAllMocks());

describe('a word on the Tokenize tab', () => {
  it('asks the document for the Analyze tab on Alt+click', async () => {
    const goToTab = vi.fn();
    const view = await mount({ goToTab });
    const token = view.container.querySelector('.token');
    await view.step(() => click(token, { altKey: true }));
    expect(goToTab).toHaveBeenCalledWith('analyze');
    await view.unmount();
  });

  it('does not go through the window to reach it', async () => {
    const heard = vi.fn();
    window.addEventListener('igt:navigate-tab', heard);
    const view = await mount({ goToTab: vi.fn() });
    const token = view.container.querySelector('.token');
    await view.step(() => click(token, { altKey: true }));
    window.removeEventListener('igt:navigate-tab', heard);
    expect(heard).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('switches tabs read-only too, since it changes nothing', async () => {
    const goToTab = vi.fn();
    const view = await mount({ goToTab }, { readOnly: true });
    const token = view.container.querySelector('.token');
    await view.step(() => click(token, { altKey: true }));
    expect(goToTab).toHaveBeenCalledWith('analyze');
    await view.unmount();
  });

  it('leaves Ctrl/Cmd+click as the sentence split', async () => {
    const goToTab = vi.fn();
    const splitSentence = vi.fn();
    const view = await mount({ goToTab }, { ops: { splitSentence } });
    const token = view.container.querySelector('.token');
    await view.step(() => click(token, { ctrlKey: true }));
    expect(splitSentence).toHaveBeenCalledWith(0);
    await view.step(() => click(token, { metaKey: true }));
    expect(splitSentence).toHaveBeenCalledTimes(2);
    expect(goToTab).not.toHaveBeenCalled();
    await view.unmount();
  });
});
