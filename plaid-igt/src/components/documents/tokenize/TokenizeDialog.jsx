import { useState } from 'react';
import { Scissors } from 'lucide-react';
import { ServiceRunDialog } from '@ui/components/services/ServiceRunDialog.jsx';
import { ServiceMethodRow } from '@ui/components/services/ServiceMethodRow.jsx';
import { ServiceRunButton } from '@ui/components/services/ServiceRunButton.jsx';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { runHeldNotice } from '../runHeld.js';

// Tokenization: the button in the Tokens header and the dialog behind it.
// Results are the words in the panel underneath, so the dialog carries nothing
// but the method and its options.
export function TokenizeDialog({ ops, blockedHint = null }) {
  const [open, setOpen] = useState(false);
  const { writeLock } = useDocumentCtx();
  const { spot, tokenizeRun, handleTokenize, isTokenizing, isProcessing, cancelRequest } = ops;
  const running = tokenizeRun.running || isTokenizing || isProcessing;
  // Another spot's run holds the document: said in the dialog, beside the
  // Run it disables (acquireWriteLock would just refuse).
  const held = runHeldNotice(writeLock, running);

  // Closed before the run: a destructive re-tokenize asks for confirmation in
  // a dialog of its own, and two stacked modals is one too many.
  const run = async () => {
    setOpen(false);
    await handleTokenize();
  };

  return (
    <>
      {/* Never disabled: what blocks a run is stated inside, where a disabled
          button could only have hidden it. */}
      <ServiceRunButton
        label="Tokenize"
        icon={Scissors}
        onClick={() => setOpen(true)}
        progress={tokenizeRun}
      />

      <ServiceRunDialog
        open={open}
        onOpenChange={setOpen}
        title="Tokenize"
        icon={Scissors}
        description="Existing tokens are not overwritten."
        progress={tokenizeRun}
        notice={blockedHint ?? held}
        runLabel="Tokenize"
        onRun={run}
        // Only a service run can be stopped; the built-in is local and quick.
        onCancel={spot.service ? cancelRequest : undefined}
        runDisabled={
          !!blockedHint || running || !!held || Object.keys(spot.params.errors).length > 0
        }
      >
        <ServiceMethodRow spot={spot} disabled={running} />
      </ServiceRunDialog>
    </>
  );
}
