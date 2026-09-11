import { useState } from 'react';
import { Zap } from 'lucide-react';
import { ServiceRunDialog } from '@ui/components/services/ServiceRunDialog.jsx';
import { ServiceMethodRow } from '@ui/components/services/ServiceMethodRow.jsx';
import { ServiceRunButton } from '@ui/components/services/ServiceRunButton.jsx';

// Parsing: the button in the editor toolbars and the dialog behind it.
//
// Both toolbars render this, and both read the same `parse` from the shell, so
// the run a linguist starts in the Text Editor is the run the Annotate tab
// shows. Closing the dialog never cancels, and the button carries the clock.
export function ParseDialog({ parse, isDiscovering, writeLockHeld, blockedHint = null }) {
  const [open, setOpen] = useState(false);
  const { spot, run, start } = parse;
  const running = run.running;
  // Another run holds the document. Say so rather than letting the button do
  // nothing, which is all acquireWriteLock could manage.
  const busyElsewhere = !!writeLockHeld && !running;

  const notice = running
    ? null
    : blockedHint
      ? blockedHint
      : busyElsewhere
        ? `${writeLockHeld.label} is running. One run at a time on a document.`
        : spot.empty
          ? isDiscovering
            ? 'Looking for a parsing service.'
            : 'No parsing service is online for this project.'
          : null;

  return (
    <>
      <ServiceRunButton label="Parse" icon={Zap} onClick={() => setOpen(true)} progress={run} />

      <ServiceRunDialog
        open={open}
        onOpenChange={setOpen}
        title="Parse"
        icon={Zap}
        description="Lemmas, parts of speech, features and dependency relations, written into this document."
        progress={run}
        notice={notice}
        runLabel="Parse"
        onRun={() => {
          setOpen(false);
          start();
        }}
        onCancel={parse.cancel}
        runDisabled={
          !!notice || running || spot.empty || Object.keys(spot.params.errors).length > 0
        }
      >
        <ServiceMethodRow
          spot={spot}
          disabled={running}
          emptyHint={
            isDiscovering
              ? 'Looking for a parsing service.'
              : 'No parsing service is online for this project.'
          }
        />
      </ServiceRunDialog>
    </>
  );
}
