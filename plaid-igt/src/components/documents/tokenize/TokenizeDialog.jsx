import { Scissors } from 'lucide-react';
import { ServiceSpotDialog } from '@ui/components/services/ServiceSpotDialog.jsx';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';

// Tokenization: the button in the Tokens header and the dialog behind it.
// Results are the words in the panel underneath, so the dialog carries nothing
// but the method and its options. The button is never disabled: what blocks a
// run is stated inside, where a disabled button could only have hidden it. The
// dialog closes before the run, since a destructive re-tokenize asks for
// confirmation in a dialog of its own.
export function TokenizeDialog({ ops, blockedHint = null }) {
  const { writeLock } = useDocumentCtx();
  const { spot, handleTokenize } = ops;
  return (
    <ServiceSpotDialog
      label="Tokenize"
      icon={Scissors}
      description={
        spot.service
          ? "Where the service splits a sentence differently, that sentence's words are made again."
          : 'Existing words are kept.'
      }
      spot={spot}
      onRun={handleTokenize}
      writeLock={writeLock}
      blockedHint={blockedHint}
    />
  );
}
