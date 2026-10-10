import { Sparkles } from 'lucide-react';
import { ServiceSpotDialog } from '@ui/components/services/ServiceSpotDialog.jsx';

// Drafting: the button on the annotation toolbar and the dialog behind it.
export function DraftDialog({ draft, isDiscovering, writeLockHeld, disabled = false }) {
  return (
    <ServiceSpotDialog
      label="Draft"
      icon={Sparkles}
      description="A first graph for each sentence, written into this document for correction on the canvas."
      run={draft.run}
      spot={draft.spot}
      onRun={() => draft.start()}
      onCancel={draft.cancel}
      writeLock={writeLockHeld}
      noun="drafting"
      isDiscovering={isDiscovering}
      disabled={disabled}
    />
  );
}
