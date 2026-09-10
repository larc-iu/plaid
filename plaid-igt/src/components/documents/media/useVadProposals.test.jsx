import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { renderComponent } from '../../../test/renderComponent.jsx';
import { useVadProposals, VAD_METADATA_KEY } from './useVadProposals.js';

// Detection is expensive and its cuts are a real piece of work, so they are
// kept on the document instead of dying with the tab. They are still
// proposals: no segment exists until somebody types into one.

const BLOB = { size: 4096 };
const REGIONS = [
  { timeBegin: 0.42, timeEnd: 3.1 },
  { timeBegin: 3.8, timeEnd: 7.55 },
];

function Probe({ saved, onPersist, tokens = [], blob = BLOB, method = 'builtin', onReady }) {
  const vad = useVadProposals({
    mediaBlob: blob,
    mediaKey: blob ? `blob:${blob.size}` : null,
    alignmentTokens: tokens,
    params: {},
    methodKey: method,
    saved,
    onPersist,
  });
  onReady?.(vad);
  return <output>{vad.proposals.map((p) => p.id).join(' ')}</output>;
}

const shown = (r) => r.container.querySelector('output').textContent;
// The shape on the document: begin and end in turn, no objects (the server
// counts keys through every level, and 300 cuts as objects blew its cap).
const kept = (regions, dismissed = []) => ({
  mediaBytes: BLOB.size,
  method: 'builtin',
  regions: regions.flatMap((r) => [r.timeBegin, r.timeEnd]),
  dismissed,
});

// Keys the way the server counts them: every key of every map, at any depth.
const serverKeyCount = (v) =>
  Array.isArray(v)
    ? v.reduce((n, x) => n + serverKeyCount(x), 0)
    : v && typeof v === 'object'
      ? Object.keys(v).length + Object.values(v).reduce((n, x) => n + serverKeyCount(x), 0)
      : 0;

describe('useVadProposals persistence', () => {
  afterEach(() => vi.useRealTimers());

  it('restores the cuts the document kept for this recording', async () => {
    const r = await renderComponent(<Probe saved={kept(REGIONS)} />);
    expect(shown(r)).toBe('vad-0.420-3.100 vad-3.800-7.550');
    await r.unmount();
  });

  it('ignores cuts measured from a different recording or method', async () => {
    const other = await renderComponent(<Probe saved={{ ...kept(REGIONS), mediaBytes: 999 }} />);
    expect(shown(other)).toBe('');
    await other.unmount();
    const swapped = await renderComponent(<Probe saved={kept(REGIONS)} method="some-service" />);
    expect(shown(swapped)).toBe('');
    await swapped.unmount();
  });

  it('keeps a long recording within the server key cap', async () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ timeBegin: i * 2, timeEnd: i * 2 + 1 }));
    const onPersist = vi.fn();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let api;
    const r = await renderComponent(
      <Probe saved={kept(REGIONS)} onPersist={onPersist} onReady={(v) => (api = v)} />,
    );
    // Dismissing one changes the payload, so the whole thing is written.
    await r.step(() => api.dismiss('vad-0.420-3.100'));
    await r.step(() => vi.advanceTimersByTime(2000));
    expect(onPersist).toHaveBeenCalled();
    expect(serverKeyCount(kept(many))).toBeLessThan(500);
    expect(serverKeyCount(onPersist.mock.calls.at(-1)[0])).toBeLessThan(10);
    await r.unmount();
  });

  it('does not write back what it just restored', async () => {
    vi.useFakeTimers();
    const onPersist = vi.fn();
    const r = await renderComponent(<Probe saved={kept(REGIONS)} onPersist={onPersist} />);
    await r.step(() => vi.advanceTimersByTime(5000));
    expect(onPersist).not.toHaveBeenCalled();
    await r.unmount();
  });

  it('keeps a discard, and drops the key when everything is cleared', async () => {
    vi.useFakeTimers();
    const onPersist = vi.fn();
    let api = null;
    const r = await renderComponent(
      <Probe saved={kept(REGIONS)} onPersist={onPersist} onReady={(v) => (api = v)} />,
    );
    await r.step(() => api.dismiss('vad-0.420-3.100'));
    expect(shown(r)).toBe('vad-3.800-7.550');
    await r.step(() => vi.advanceTimersByTime(2000));
    expect(onPersist).toHaveBeenCalledWith(kept(REGIONS, ['vad-0.420-3.100']));

    onPersist.mockClear();
    await r.step(() => api.clear());
    await r.step(() => vi.advanceTimersByTime(2000));
    expect(onPersist).toHaveBeenCalledWith(null);
    await r.unmount();
  });

  it('leaves a proposal that became a segment out, without rewriting the cuts', async () => {
    vi.useFakeTimers();
    const onPersist = vi.fn();
    // A segment now covers the first cut's stretch of time.
    const tokens = [{ id: 't1', metadata: { timeBegin: 0.4, timeEnd: 3.2 } }];
    const r = await renderComponent(
      <Probe saved={kept(REGIONS)} onPersist={onPersist} tokens={tokens} />,
    );
    expect(shown(r)).toBe('vad-3.800-7.550');
    await r.step(() => vi.advanceTimersByTime(5000));
    expect(onPersist).not.toHaveBeenCalled();
    await r.unmount();
  });

  it('writes nothing at all for a reader, who cannot', async () => {
    vi.useFakeTimers();
    const r = await renderComponent(<Probe saved={kept(REGIONS)} onPersist={null} />);
    expect(shown(r)).toBe('vad-0.420-3.100 vad-3.800-7.550');
    await r.step(() => vi.advanceTimersByTime(5000));
    await r.unmount();
  });

  it('sends a write still inside its delay when the tab is left', async () => {
    vi.useFakeTimers();
    const onPersist = vi.fn();
    let api = null;
    const r = await renderComponent(
      <Probe saved={kept(REGIONS)} onPersist={onPersist} onReady={(v) => (api = v)} />,
    );
    await r.step(() => api.dismiss('vad-3.800-7.550'));
    // Navigating away well inside the 1.5s debounce used to cancel the write.
    await r.step(() => vi.advanceTimersByTime(100));
    expect(onPersist).not.toHaveBeenCalled();
    await r.unmount();
    expect(onPersist).toHaveBeenCalledWith(kept(REGIONS, ['vad-3.800-7.550']));
  });

  it('names the metadata key it keeps them under', () => {
    expect(VAD_METADATA_KEY).toBe('speechDetection');
  });
});

// A service run that returns nothing is not a run that found no speech. The
// difference is the whole of `abandonServiceRun`: it is what a stopped run
// takes, and taking the other one instead threw the kept cuts away.
describe('useVadProposals: a service run that produced nothing', () => {
  afterEach(() => vi.useRealTimers());

  const keptForService = (regions) => ({
    mediaBytes: BLOB.size,
    method: 'svc:detect',
    regions: regions.flatMap((r) => [r.timeBegin, r.timeEnd]),
    dismissed: [],
  });

  it('leaves the cuts alone and stops looking busy', async () => {
    let api = null;
    const r = await renderComponent(
      <Probe saved={keptForService(REGIONS)} method="svc:detect" onReady={(v) => (api = v)} />,
    );
    expect(shown(r)).toBe('vad-0.420-3.100 vad-3.800-7.550');
    await r.step(() => api.beginServiceRun());
    expect(api.status).toBe('running');
    await r.step(() => api.abandonServiceRun());
    expect(api.status).toBe('ready');
    expect(api.error).toBe(null);
    expect(shown(r)).toBe('vad-0.420-3.100 vad-3.800-7.550');
    await r.unmount();
  });

  it('writes nothing back, so a stop cannot erase what the document kept', async () => {
    vi.useFakeTimers();
    const onPersist = vi.fn();
    let api = null;
    const r = await renderComponent(
      <Probe
        saved={keptForService(REGIONS)}
        method="svc:detect"
        onPersist={onPersist}
        onReady={(v) => (api = v)}
      />,
    );
    await r.step(() => api.beginServiceRun());
    await r.step(() => api.abandonServiceRun());
    await r.step(() => vi.advanceTimersByTime(5000));
    expect(onPersist).not.toHaveBeenCalled();
    await r.unmount();
  });

  it('goes idle rather than ready when there was nothing there to keep', async () => {
    let api = null;
    const r = await renderComponent(<Probe method="svc:detect" onReady={(v) => (api = v)} />);
    await r.step(() => api.beginServiceRun());
    await r.step(() => api.abandonServiceRun());
    expect(api.status).toBe('idle');
    await r.unmount();
  });

  it('is not what an empty result does, which really does clear them', async () => {
    vi.useFakeTimers();
    const onPersist = vi.fn();
    let api = null;
    const r = await renderComponent(
      <Probe
        saved={keptForService(REGIONS)}
        method="svc:detect"
        onPersist={onPersist}
        onReady={(v) => (api = v)}
      />,
    );
    await r.step(() => api.acceptServiceRegions([]));
    expect(shown(r)).toBe('');
    await r.step(() => vi.advanceTimersByTime(5000));
    expect(onPersist).toHaveBeenCalledWith(null);
    await r.unmount();
  });
});
