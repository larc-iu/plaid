import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { useTokenPositions } from './useTokenPositions.js';

// The arcs are drawn over MEASURED token positions, and the document hands the
// grid fresh token objects on every save. An edit that changes no geometry (a
// deprel value, an arc added or removed) must therefore leave the measured
// positions ALONE, or the tree re-renders and re-measures a second time for
// nothing on every keystroke that commits.
//
// What holds that is the deep compare, and only a test that watches the
// positions across two measurements can see it: the positions are correct
// either way, so anything reading the end state passes with the compare gone.

// A rect per token, so a "widened" token can be told from an unchanged one.
const rect = (left, width) => ({
  left,
  top: 0,
  width,
  height: 20,
  right: left + width,
  bottom: 20,
});

const Probe = ({ tokenData, lemmaSpans, widths, seen }) => {
  const { tokenPositions, sentenceGridRef, tokenRefs } = useTokenPositions(tokenData, lemmaSpans);
  seen.push(tokenPositions);
  return (
    <div
      ref={(el) => {
        if (el) {
          el.getBoundingClientRect = () => rect(0, 500);
          sentenceGridRef.current = el;
        }
      }}
    >
      {tokenData.map((data, index) => (
        <span
          key={data.token.id}
          ref={(el) => {
            if (el) {
              el.getBoundingClientRect = () => rect(index * 100, widths[index]);
              tokenRefs.current.set(data.token.id, el);
            }
          }}
        >
          {data.tokenForm}
        </span>
      ))}
    </div>
  );
};

// The grid rebuilds its rows on every save, so the token objects are new each
// time even when nothing about them moved.
const rows = () => ['t1', 't2'].map((id) => ({ token: { id }, tokenForm: id.toUpperCase() }));
const spans = () => [
  { id: 'l1', tokens: ['t1'] },
  { id: 'l2', tokens: ['t2'] },
];

// Measuring is deferred to a timeout, so a test has to let it come due.
const measure = (view) => view.step(() => vi.advanceTimersByTime(10));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => vi.useRealTimers());

describe('measured token positions', () => {
  it('are the same array again when a rebuild moved nothing', async () => {
    const seen = [];
    const widths = [50, 60];
    const view = await renderComponent(
      <Probe tokenData={rows()} lemmaSpans={spans()} widths={widths} seen={seen} />,
    );
    await measure(view);
    const measured = seen.at(-1);
    expect(measured).toHaveLength(2);
    expect(measured[0].width).toBe(50);

    // A save: new token objects, new span objects, same layout.
    await view.rerender(
      <Probe tokenData={rows()} lemmaSpans={spans()} widths={widths} seen={seen} />,
    );
    await measure(view);
    expect(seen.at(-1)).toBe(measured);
    await view.unmount();
  });

  it('are measured again when the layout really did change', async () => {
    const seen = [];
    const widths = [50, 60];
    const view = await renderComponent(
      <Probe tokenData={rows()} lemmaSpans={spans()} widths={widths} seen={seen} />,
    );
    await measure(view);
    const measured = seen.at(-1);

    widths[0] = 90; // a longer form in the first cell
    await view.rerender(
      <Probe tokenData={rows()} lemmaSpans={spans()} widths={widths} seen={seen} />,
    );
    await measure(view);
    expect(seen.at(-1)).not.toBe(measured);
    expect(seen.at(-1)[0].width).toBe(90);
    await view.unmount();
  });
});
