// The Speech detection dialog's footer: Discard is offered only when a run
// left proposals or discards to throw away.
import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { VadDetection } from './VadDetection.jsx';

const mediaOps = (vad) => ({
  vad: { proposals: [], status: 'ready', error: null, cancel: vi.fn(), clear: vi.fn(), ...vad },
  detectSpot: { options: [], service: null },
  detectRun: { running: false },
  handleDetectSpeech: vi.fn(),
  cancelRequest: vi.fn(),
  channelSpeakers: null,
  channelCount: null,
});

const footer = async (vad) => {
  const r = await renderComponent(<VadDetection mediaOps={mediaOps(vad)} />);
  await r.step(() => document.querySelector('button[aria-label="Detect speech"]').click());
  const dialog = document.querySelector('[role="dialog"]');
  const text = dialog.textContent;
  const buttons = [...dialog.querySelectorAll('button')].map((b) => b.textContent.trim());
  await r.unmount();
  return { text, buttons };
};

describe('the Speech detection dialog', () => {
  it('offers no Discard when the run found no speech', async () => {
    const { text, buttons } = await footer({ foundCount: 0, hasAnalysis: true });
    expect(text).toContain('No speech found');
    expect(buttons).not.toContain('Discard');
  });

  it('offers Discard when the run found speech, proposed or all used up', async () => {
    const proposed = await footer({
      proposals: [{ id: 'vad-1', timeBegin: 1, timeEnd: 2 }],
      foundCount: 1,
      hasAnalysis: true,
    });
    expect(proposed.text).toContain('1 proposed segment');
    expect(proposed.buttons).toContain('Discard');
    const left = await footer({ foundCount: 2, hasAnalysis: true });
    expect(left.text).toContain('No proposals left');
    expect(left.buttons).toContain('Discard');
  });
});
