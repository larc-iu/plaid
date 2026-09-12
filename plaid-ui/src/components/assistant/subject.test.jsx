import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { AssistantSubjectProvider } from './AssistantSubject.jsx';
import { useAssistantScope, useAssistantSubject } from './subject.js';

// The screen publishes what it is showing and the shell's panel reads it. The
// two things worth pinning down: a screen that passes its callbacks inline
// (every screen does) must not re-publish on every render, and a screen
// leaving must not wipe a subject that has since been published.

// Renders whatever the panel would see, and counts how often it changed.
const Watcher = ({ seen }) => {
  const subject = useAssistantScope();
  seen.push(subject);
  return <span data-testid="subject">{subject ? `${subject.kind}:${subject.id}` : 'none'}</span>;
};

const Screen = ({ onApplied, ...props }) => {
  useAssistantSubject({ onApplied, ...props });
  return null;
};

const read = (container) => container.querySelector('[data-testid="subject"]').textContent;

// Only the values the panel actually keys on, so a re-render with new callback
// identities does not read as a new subject.
const identity = (s) => (s ? `${s.projectId}/${s.kind}/${s.id}/${s.name}/${s.canWrite}` : null);
const distinct = (seen) => {
  const out = [];
  for (const s of seen)
    if (!out.length || identity(out[out.length - 1]) !== identity(s)) out.push(s);
  return out;
};

describe('useAssistantSubject', () => {
  it('publishes what the screen is showing', async () => {
    const seen = [];
    const { container, unmount } = await renderComponent(
      <AssistantSubjectProvider>
        <Watcher seen={seen} />
        <Screen projectId="p1" projectName="Lezgi" kind="document" id="d1" name="Text 1" />
      </AssistantSubjectProvider>,
    );
    expect(read(container)).toBe('document:d1');
    const last = seen[seen.length - 1];
    expect(last.projectId).toBe('p1');
    expect(last.projectName).toBe('Lezgi');
    expect(last.name).toBe('Text 1');
    await unmount();
  });

  it('does not re-publish when only the callbacks are new', async () => {
    // A screen writes `onApplied={() => …}` in its JSX, so every render hands
    // over a different function. Treating that as a new subject reset the
    // panel on every keystroke anywhere on the screen.
    const seen = [];
    const tree = (n) => (
      <AssistantSubjectProvider>
        <Watcher seen={seen} />
        <Screen
          projectId="p1"
          kind="document"
          id="d1"
          name="Text 1"
          onApplied={() => n}
          onFocusHere={() => n}
        />
      </AssistantSubjectProvider>
    );
    const { rerender, unmount } = await renderComponent(tree(1));
    const after = distinct(seen).length;
    await rerender(tree(2));
    await rerender(tree(3));
    expect(distinct(seen).length).toBe(after);
    await unmount();
  });

  it("reaches the screen's CURRENT callback, not the one it published with", async () => {
    // The published subject is held while the screen re-renders, so the panel
    // must not be holding a stale closure over the screen's old state.
    const first = vi.fn();
    const second = vi.fn();
    const seen = [];
    const tree = (fn) => (
      <AssistantSubjectProvider>
        <Watcher seen={seen} />
        <Screen projectId="p1" kind="document" id="d1" name="Text 1" onApplied={fn} />
      </AssistantSubjectProvider>
    );
    const { rerender, unmount } = await renderComponent(tree(first));
    await rerender(tree(second));
    seen[seen.length - 1].onApplied();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it('publishes nothing without a project, because the assistant is per project', async () => {
    const seen = [];
    const { container, unmount } = await renderComponent(
      <AssistantSubjectProvider>
        <Watcher seen={seen} />
        <Screen kind="lexicon" id="v1" name="Verbs" />
      </AssistantSubjectProvider>,
    );
    expect(read(container)).toBe('none');
    await unmount();
  });

  it('clears when the screen goes', async () => {
    const seen = [];
    const tree = (withScreen) => (
      <AssistantSubjectProvider>
        <Watcher seen={seen} />
        {withScreen && <Screen projectId="p1" kind="document" id="d1" name="Text 1" />}
      </AssistantSubjectProvider>
    );
    const { container, rerender, unmount } = await renderComponent(tree(true));
    expect(read(container)).toBe('document:d1');
    await rerender(tree(false));
    expect(read(container)).toBe('none');
    await unmount();
  });

  it('a leaving screen does not wipe the arriving one', async () => {
    // The navigation case. Whichever order the two effects run in, what the
    // panel ends up with has to be the screen that is actually on show.
    const seen = [];
    const { container, rerender, unmount } = await renderComponent(
      <AssistantSubjectProvider>
        <Watcher seen={seen} />
        <Screen key="a" projectId="p1" kind="document" id="d1" name="Text 1" />
      </AssistantSubjectProvider>,
    );
    await rerender(
      <AssistantSubjectProvider>
        <Watcher seen={seen} />
        <Screen key="b" projectId="p1" kind="lexicon" id="v1" name="Verbs" />
      </AssistantSubjectProvider>,
    );
    expect(read(container)).toBe('lexicon:v1');
    await unmount();
  });

  it('a screen that changes what it shows republishes', async () => {
    // One screen, a different document: the reader followed a link within the
    // same route, so no component unmounted.
    const seen = [];
    const tree = (id) => (
      <AssistantSubjectProvider>
        <Watcher seen={seen} />
        <Screen projectId="p1" kind="document" id={id} name={`Text ${id}`} />
      </AssistantSubjectProvider>
    );
    const { container, rerender, unmount } = await renderComponent(tree('d1'));
    await rerender(tree('d2'));
    expect(read(container)).toBe('document:d2');
    expect(seen[seen.length - 1].name).toBe('Text d2');
    await unmount();
  });
});
