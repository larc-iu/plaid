import { useState } from 'react';
import { ServiceRunDialog } from './ServiceRunDialog.jsx';
import { ServiceMethodRow } from './ServiceMethodRow.jsx';
import { ServiceRunButton } from './ServiceRunButton.jsx';
import { heldBy, runHeldNotice } from './runHeld.js';

// A run of one service spot: the button and the dialog behind it, with one
// method row. The dialog closes when the run is started, and the run belongs
// to the caller: the banner over the document shows it, with Stop. While it
// holds the document (`writeLock` names it by `label`), the button turns and
// is disabled.
//
// What blocks a run is said in the dialog, beside the Run it disables:
// `blockedHint` (the app's own reason), else another run holding the document
// (`writeLock`). No service online is the method row's to say, once: with a
// `noun`, as "No parsing service is online for this project.", or "Looking
// for a parsing service." while `isDiscovering`. `blocked` disables Run with
// nothing said. `onOpen` runs each time the dialog opens. `size` is the
// button's (`sm` on an annotation tab's RunBar). `children` sit under the
// method row: what else the run takes (the channels of a recording, say).
export function ServiceSpotDialog({
  label,
  icon,
  description,
  spot,
  onRun,
  writeLock = null,
  blockedHint = null,
  noun = null,
  isDiscovering = false,
  onOpen = null,
  disabled = false,
  blocked = false,
  size,
  children = null,
}) {
  const [open, setOpen] = useState(false);
  const running = heldBy(writeLock, label);
  const notice = blockedHint ?? runHeldNotice(writeLock);
  const emptyHint = !noun
    ? undefined
    : isDiscovering
      ? `Looking for a ${noun} service.`
      : `No ${noun} service is online for this project.`;

  return (
    <>
      <ServiceRunButton
        label={label}
        icon={icon}
        onClick={() => {
          setOpen(true);
          onOpen?.();
        }}
        running={running}
        disabled={disabled || running}
        size={size}
      />

      <ServiceRunDialog
        open={open}
        onOpenChange={setOpen}
        title={label}
        icon={icon}
        description={description}
        notice={notice}
        runLabel={label}
        onRun={() => {
          setOpen(false);
          onRun();
        }}
        runDisabled={
          blocked || !!notice || !!spot.empty || Object.keys(spot.params.errors).length > 0
        }
      >
        <ServiceMethodRow spot={spot} emptyHint={emptyHint} />
        {children}
      </ServiceRunDialog>
    </>
  );
}
