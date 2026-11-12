import { describe, it, expect, vi } from 'vitest';
import { renderComponent, byText } from '@ui/test/renderComponent.jsx';
import { DocumentProvider } from './contexts/DocumentContext.jsx';
import { TokenizeDialog } from './tokenize/TokenizeDialog.jsx';
import { TranscribeDialog } from './media/TranscribeDialog.jsx';
import { runHeldNotice } from '@ui/components/services/runHeld.js';

// A run dialog whose Run is disabled because another run holds the document
// says so, in the words ud's and umr's dialogs use (R2-DEBT-APPS-13).

vi.mock('@ui/components/services/ServiceMethodRow.jsx', () => ({
  ServiceMethodRow: () => null,
}));

const HELD = 'Auto-analyze is running. One run at a time on a document.';
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
    const view = await open('Tokenize', <TokenizeDialog ops={{ spot, handleTokenize: vi.fn() }} />);
    expect(document.body.textContent).toContain(HELD);
    expect(runButton('Tokenize').disabled).toBe(true);
    await view.unmount();
  });

  it('Transcribe says the same', async () => {
    const view = await open(
      'Transcribe',
      <TranscribeDialog mediaOps={{ transcribeSpot: spot, handleTranscribe: vi.fn() }} />,
    );
    expect(document.body.textContent).toContain(HELD);
    expect(runButton('Transcribe').disabled).toBe(true);
    await view.unmount();
  });

  it('says nothing with no run', () => {
    expect(runHeldNotice(null)).toBeNull();
  });
});

describe("a run dialog's opener while its own run holds the document", () => {
  it.each([
    ['Tokenize', <TokenizeDialog key="t" ops={{ spot, handleTokenize: vi.fn() }} />],
    [
      'Transcribe',
      <TranscribeDialog key="tr" mediaOps={{ transcribeSpot: spot, handleTranscribe: vi.fn() }} />,
    ],
  ])('%s turns and is disabled', async (label, ui) => {
    const view = await renderComponent(
      <DocumentProvider value={{ writeLock: { label } }}>{ui}</DocumentProvider>,
    );
    const opener = byText(document.body, 'button', label);
    expect(opener.disabled).toBe(true);
    expect(opener.querySelector('svg.animate-spin')).not.toBe(null);
    await view.unmount();
  });
});
