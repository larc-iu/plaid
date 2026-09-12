import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../ui/button.jsx';
import { cn } from '../../lib/utils.js';
import { ProjectAssistant } from './ProjectAssistant.jsx';
import { clampWidth, readWidth, saveWidth } from './panelWidth.js';
import { AssistantMark } from './PlaidMarks.jsx';

// The assistant docked beside what the user is working on: the same
// conversation the Assistant tab holds, with the tab's chrome left out. A
// document in both apps, and in IGT a vocabulary on the Entries screen.
//
// The panel never covers the annotation. It takes width from the editor, which
// both apps' editors absorb by scrolling sideways, and it collapses to a button
// when it is in the way. Its width is remembered per browser.
//
// While it is open the editor area is bounded to the viewport and scrolls
// inside itself, so the panel can be exactly as tall as the screen and its
// composer is always reachable. Closing it gives the page its own scrolling
// back, which is how both editors behave when the assistant is not in use.

// The grip between the editor and the panel. The panel is on the right, so
// dragging left widens it and the delta is subtracted.
const Resizer = ({ width, onResize }) => {
  const drag = useRef(null);
  const onPointerDown = (e) => {
    drag.current = { x: e.clientX, width };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    onResize(clampWidth(drag.current.width + (drag.current.x - e.clientX)));
  };
  const onPointerUp = (e) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the assistant"
      className="group relative w-1.5 shrink-0 cursor-col-resize touch-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border group-hover:bg-primary/50" />
    </div>
  );
};

export const DocumentAssistant = ({
  open,
  onOpenChange,
  documentId,
  documentName,
  lexiconId,
  lexiconName,
  focus,
  onClearFocus,
  onApplied,
  onFocusHere,
  ...assistant
}) => {
  const [width, setWidth] = useState(readWidth);

  const resize = useCallback((w) => {
    setWidth(w);
    saveWidth(w);
  }, []);

  // A gesture in the editor points at something and opens the panel with it.
  const openRef = useRef(onOpenChange);
  openRef.current = onOpenChange;
  useEffect(() => {
    if (focus) openRef.current?.(true);
  }, [focus]);

  if (!open) return null;

  return (
    <>
      <Resizer width={width} onResize={resize} />
      <aside
        style={{ width, maxWidth: '100%' }}
        className="flex h-full min-h-0 shrink-0 flex-col border-l bg-card"
      >
        {/* No header of its own. It used to carry a bar naming the document or
            the vocabulary, which is what the page's own heading says a few
            pixels to the left, and the panel then had TWO stacked bars: one
            repeating the title and one for the assistant and its controls.
            The hide button moved into the second, which is the only one now. */}
        <div className="min-h-0 flex-1">
          <ProjectAssistant
            {...assistant}
            variant="panel"
            documentId={documentId}
            documentName={documentName}
            lexiconId={lexiconId}
            lexiconName={lexiconName}
            focus={focus}
            onClearFocus={onClearFocus}
            onApplied={onApplied}
            onFocusHere={onFocusHere}
            onCollapse={() => onOpenChange?.(false)}
          />
        </div>
      </aside>
    </>
  );
};

// The control that opens it, for a toolbar. Hidden while the panel is open,
// and hidden entirely when no assistant is online: a button that opens an
// empty panel is worse than no button. `available` being null means not known
// yet, which is also not offered.
export const DocumentAssistantButton = ({
  open,
  onOpenChange,
  available,
  className,
  title = 'Ask the assistant about this document',
}) =>
  open || !available ? null : (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn('gap-1.5', className)}
      onClick={() => onOpenChange?.(true)}
      title={title}
    >
      <AssistantMark className="h-4 w-4" />
      Assistant
    </Button>
  );
