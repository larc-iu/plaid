import { describe, it, expect, vi } from 'vitest';
import { renderComponent, byText } from '@ui/test/renderComponent.jsx';
import { DocumentProvider } from './contexts/DocumentContext.jsx';
import { TokenizeDialog } from './tokenize/TokenizeDialog.jsx';
import { TranscribeDialog } from './media/TranscribeDialog.jsx';
import { runHeldNotice } from './runHeld.js';

// A run dialog whose Run is disabled because another run holds the document
// says so, in the words ud's and umr's dialogs use (R2-DEBT-APPS-13).

vi.mock('@ui/components/services/ServiceMethodRow.jsx', () => ({
  ServiceMethodRow: () => null,
}));

const HELD = 'Auto-analyze is running. One run at a time on a document.';
const idle = { running: false, elapsedMs: 0, percent: null };
const spot = { service: { serviceId: 's' }, params: { errors: {} } };

const open = async (opener, ui) => {
  const view = await renderComponent(
    <DocumentProvider value={{ writeLock: { label: 'Auto-analyze' } }}>{ui}</DocumentProvider>,
  );
  await view.step(() => byText(document.body, 'button', opener).click());
  return view;
};

const runButton = (label) =>
  [...document.querySelectorAll('[role="dialog"] button')].find(
    (b) => b.textContent.trim() === label,
  );

describe('a run dialog while another run holds the document', () => {
  it('Tokenize says which run, and Run is disabled', async () => {
    const view = await open(
      'Tokenize',
      <TokenizeDialog
        ops={{ spot, tokenizeRun: idle, handleTokenize: vi.fn(), cancelRequest: vi.fn() }}
      />,
    );
    expect(document.body.textContent).toContain(HELD);
    expect(runButton('Tokenize').disabled).toBe(true);
    await view.unmount();
  });

  it('Transcribe says the same', async () => {
    const view = await open(
      'Transcribe',
      <TranscribeDialog
        mediaOps={{ transcribeSpot: spot, transcribeRun: idle, handleTranscribe: vi.fn() }}
      />,
    );
    expect(document.body.textContent).toContain(HELD);
    expect(runButton('Transcribe').disabled).toBe(true);
    await view.unmount();
  });

  it('says nothing for its own run, or with no run', () => {
    expect(runHeldNotice({ label: 'Tokenize' }, true)).toBeNull();
    expect(runHeldNotice(null, false)).toBeNull();
  });
});
