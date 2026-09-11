import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, PanelRightClose } from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { cn } from '../../lib/utils.js';
import { ProjectAssistant } from './ProjectAssistant.jsx';
import { clampWidth, readWidth, saveWidth } from './panelWidth.js';

// The assistant docked beside a document: the same conversation the Assistant
// tab holds, with the tab's chrome left out.
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
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={documentName}>
            {documentName || 'Assistant'}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange?.(false)}
            title="Hide the assistant"
          >
            <PanelRightClose className="h-4 w-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <ProjectAssistant
            {...assistant}
            variant="panel"
            documentId={documentId}
            documentName={documentName}
            focus={focus}
            onClearFocus={onClearFocus}
            onApplied={onApplied}
            onFocusHere={onFocusHere}
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
export const DocumentAssistantButton = ({ open, onOpenChange, available, className }) =>
  open || !available ? null : (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn('gap-1.5', className)}
      onClick={() => onOpenChange?.(true)}
      title="Ask the assistant about this document"
    >
      <Bot className="h-4 w-4" />
      Assistant
    </Button>
  );
