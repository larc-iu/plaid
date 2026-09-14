import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// Running the built-in detector, and the two ways a run ends without becoming
// proposals: it was stopped, or a second run replaced it.
//
// Neither is visible in what the tab settles on once everything has landed.
// A superseded run's result arrives after the run the linguist is waiting for,
// so a missing guard shows up as the proposals CHANGING under them, from the
// ones they asked for to the ones they abandoned, and the persistence effect
// writes the abandoned set to the document on the way past.
//
// The model and the derivation are somebody else's tests
// (speechProbabilities, speechTimestamps). Here they are the seam, so the
// probabilities ARE the regions and the derivation is the identity.

vi.mock('../../../domain/vad/speechProbabilities.js', () => ({
  speechProbabilities: vi.fn(),
}));
vi.mock('../../../domain/vad/speechTimestamps.js', async (importOriginal) => ({
  ...(await importOriginal()),
  speechTimestamps: (probs) => probs,
  toSeconds: (regions) => regions,
}));

const { speechProbabilities } = await import('../../../domain/vad/speechProbabilities.js');
const { useVadProposals } = await import('./useVadProposals.js');

const BLOB = { size: 4096 };
const FIRST = [{ timeBegin: 0.1, timeEnd: 1 }];
const SECOND = [{ timeBegin: 5, timeEnd: 6.25 }];
const idsOf = (vad) => vad.proposals.map((p) => p.id).join(' ');

// One deferred per call, so two runs can be in flight at once and land out of
// order.
let runs;
const nextRun = () => {
  let finish;
  let fail;
  const promise = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // Nothing waits on the rejection but the hook, and an unhandled one fails the
  // run.
  promise.catch(() => {});
  runs.push({ promise, finish, fail });
  return promise;
};

let api;
let seq;

// `seq` is every DISTINCT thing the dialog has shown, in order, not just what
// it ends on: the status is half of what it says, and a run that landed after
// the one it lost to used to set it back to idle over proposals that were on
// screen.
const Probe = () => {
  const vad = useVadProposals({
    mediaBlob: BLOB,
    mediaKey: 'blob:4096',
    alignmentTokens: [],
    params: {},
    methodKey: 'builtin',
  });
  api = vad;
  useEffect(() => {
    const shown = `${vad.status}:${idsOf(vad)}`;
    if (seq[seq.length - 1] !== shown) seq.push(shown);
  });
  return null;
};

const settle = (view) =>
  view.step(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

beforeEach(() => {
  runs = [];
  seq = [];
  speechProbabilities.mockReset();
  speechProbabilities.mockImplementation(() => nextRun());
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a detection run that is not the one on screen', () => {
  it('is dropped when a second run replaced it, however late it lands', async () => {
    const view = await renderComponent(<Probe />);
    await view.step(() => {
      api.detect();
    });
    await view.step(() => {
      api.detect();
    });
    expect(speechProbabilities).toHaveBeenCalledTimes(2);

    // The run the linguist is waiting for lands first, then the one they
    // replaced.
    await view.step(() => runs[1].finish({ probs: SECOND, lengthSamples: 10 }));
    await settle(view);
    await view.step(() => runs[0].finish({ probs: FIRST, lengthSamples: 10 }));
    await settle(view);

    // One set of proposals, ever: the ones the second run found. The abandoned
    // run's are never on screen, not even for a render, and it does not get to
    // say the tab is idle on its way out.
    expect(seq).toEqual(['idle:', 'running:', 'ready:vad-5.000-6.250']);
    expect(api.status).toBe('ready');
    expect(api.hasAnalysis).toBe(true);
    await view.unmount();
  });

  it('cannot speak over a run that is still going', async () => {
    // The replaced run fails while the one that replaced it is still working.
    // Tearing its worker down mid-run is how that happens. The dialog stays on
    // the run in flight rather than dropping to idle underneath it.
    const view = await renderComponent(<Probe />);
    await view.step(() => {
      api.detect();
    });
    await view.step(() => {
      api.detect();
    });
    await view.step(() => runs[0].fail(new Error('worker gone')));
    await settle(view);
    expect(api.status).toBe('running');
    expect(api.error).toBe(null);

    await view.step(() => runs[1].finish({ probs: SECOND, lengthSamples: 10 }));
    await settle(view);
    expect(seq).toEqual(['idle:', 'running:', 'ready:vad-5.000-6.250']);
    await view.unmount();
  });

  it('leaves the tab on the proposals it already had when a rerun is stopped', async () => {
    // Detect, then Detect again, then Stop. The earlier run's proposals are
    // still on screen the whole way, so the tab is ready, not idle. The run
    // being stopped was built before the first one landed, so it can only tell
    // them apart by asking for the proposals as they are now.
    const view = await renderComponent(<Probe />);
    await view.step(() => {
      api.detect();
    });
    await view.step(() => runs[0].finish({ probs: FIRST, lengthSamples: 10 }));
    await settle(view);
    expect(api.status).toBe('ready');

    await view.step(() => {
      api.detect();
    });
    await view.step(() => api.cancel());
    await view.step(() => runs[1].finish(null));
    await settle(view);

    expect(api.status).toBe('ready');
    expect(idsOf(api)).toBe('vad-0.100-1.000');
    await view.unmount();
  });

  it('says nothing when a stopped run comes back as an error', async () => {
    const view = await renderComponent(<Probe />);
    await view.step(() => {
      api.detect();
    });
    await view.step(() => runs[0].finish({ probs: FIRST, lengthSamples: 10 }));
    await settle(view);

    await view.step(() => {
      api.detect();
    });
    await view.step(() => api.cancel());
    await view.step(() => runs[1].fail(new Error('worker gone')));
    await settle(view);

    expect(api.status).toBe('ready');
    expect(api.error).toBe(null);
    expect(idsOf(api)).toBe('vad-0.100-1.000');
    await view.unmount();
  });

  it('is dropped when it was stopped, leaving nothing behind', async () => {
    const view = await renderComponent(<Probe />);
    await view.step(() => {
      api.detect();
    });
    await view.step(() => api.cancel());
    await view.step(() => runs[0].finish({ probs: FIRST, lengthSamples: 10 }));
    await settle(view);

    expect(seq).toEqual(['idle:', 'running:', 'idle:']);
    expect(api.hasAnalysis).toBe(false);
    await view.unmount();
  });
});
