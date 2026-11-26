import { Sparkles } from 'lucide-react';
import { ServiceSpotDialog } from '@ui/components/services/ServiceSpotDialog.jsx';
import { t } from '@ui/lib/i18n.js';

// Drafting: the button on the annotation toolbar and the dialog behind it.
export function DraftDialog({ draft, isDiscovering, writeLockHeld, disabled = false, size }) {
  return (
    <ServiceSpotDialog
      label={t('Draft')}
      icon={Sparkles}
      description={t('A first graph for each sentence, written into this document.')}
      spot={draft.spot}
      onRun={() => draft.start()}
      writeLock={writeLockHeld}
      searching={t('Looking for a drafting service.')}
      noneOnline={t('No drafting service is online for this project.')}
      isDiscovering={isDiscovering}
      disabled={disabled}
      size={size}
    />
  );
}
