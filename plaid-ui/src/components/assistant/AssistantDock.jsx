import { useRef } from 'react';
import { cn } from '../../lib/utils.js';
import { ProjectAssistant } from './ProjectAssistant.jsx';
import { clampWidth } from './panelWidth.js';

// The assistant as part of the app's chrome: one panel on the right, mounted by
// the shell and not by any screen, holding its conversation across a navigation.
//
// It is FIXED rather than a flex sibling of the page. A flex row would make the
// content column the scrollport instead of the page, which changes what every
// `position: sticky` offset and every `100vh` in the app is measured from,
// whether or not the panel is open. Fixed leaves every screen's own layout
// alone and only takes a gutter on the right, which the shell pads for.
//
// That also retires the measured-height hack the per-screen panels needed. A
// fixed element bounded to the viewport is exactly as tall as the screen by
// construction, so nothing has to measure the chrome above it, move the page to
// the top to do so, or hand the discarded scroll offset to whatever now
// scrolls. Four bugs came out of that measurement and none of them can happen
// here.

// The grip along the panel's left edge. Dragging left widens it, so the delta
// is subtracted.
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
      className="group absolute inset-y-0 left-0 w-1.5 cursor-col-resize touch-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border group-hover:bg-primary/50" />
    </div>
  );
};

// `picker` stands in for the chat when there is no project for it to be about
// yet, which is the state a reader is in on the screen they land on after
// signing in.
export const AssistantDock = ({
  open,
  width,
  onResize,
  onClose,
  className,
  picker = null,
  ...assistant
}) => {
  if (!open) return null;
  return (
    <aside
      style={{ width }}
      className={cn('fixed inset-y-0 right-0 z-30 flex flex-col border-l bg-card', className)}
    >
      <Resizer width={width} onResize={onResize} />
      <div className="min-h-0 flex-1">
        {picker || <ProjectAssistant {...assistant} variant="panel" onCollapse={onClose} />}
      </div>
    </aside>
  );
};
