import { Zap } from 'lucide-react';
import { ServiceSpotDialog } from '@ui/components/services/ServiceSpotDialog.jsx';
import { t } from '@ui/lib/i18n.js';

// Parsing: the button in the editor toolbars and the dialog behind it.
//
// Both toolbars render this, and both read the same `parse` from the shell, so
// the run a linguist starts in the Text Editor is the run the Annotate tab
// shows. `onOpen` looks for services again each time the dialog opens, so one
// that came online after the page loaded is offered without a reload.
export function ParseDialog({
  parse,
  isDiscovering,
  writeLockHeld,
  blockedHint = null,
  onOpen = null,
  size,
}) {
  return (
    <ServiceSpotDialog
      label={t('Parse')}
      icon={Zap}
      description={t(
        'Lemmas, parts of speech, features and dependency relations, written into this document.',
      )}
      spot={parse.spot}
      onRun={() => parse.start()}
      writeLock={writeLockHeld}
      blockedHint={blockedHint}
      searching={t('Looking for a parsing service.')}
      noneOnline={t('No parsing service is online for this project.')}
      isDiscovering={isDiscovering}
      onOpen={onOpen}
      size={size}
    />
  );
}
