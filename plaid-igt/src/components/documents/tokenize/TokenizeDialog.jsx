import { useState } from 'react';
import { Scissors } from 'lucide-react';
import { ServiceRunDialog } from '../services/ServiceRunDialog.jsx';
import { ServiceMethodRow } from '../services/ServiceMethodRow.jsx';
import { ServiceRunButton } from '../services/ServiceRunButton.jsx';

// Tokenization: the button in the Tokens header and the dialog behind it.
// Results are the words in the panel underneath, so the dialog carries nothing
// but the method and its options.
export function TokenizeDialog({ ops, blockedHint = null }) {
  const [open, setOpen] = useState(false);
  const { spot, tokenizeRun, handleTokenize, isTokenizing, isProcessing } = ops;
  const running = tokenizeRun.running || isTokenizing || isProcessing;

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
        description="Words are written to this document."
        progress={tokenizeRun}
        notice={blockedHint}
        runLabel="Tokenize"
        onRun={run}
        runDisabled={!!blockedHint || running || Object.keys(spot.params.errors).length > 0}
      >
        <ServiceMethodRow spot={spot} disabled={running} />
      </ServiceRunDialog>
    </>
  );
}
