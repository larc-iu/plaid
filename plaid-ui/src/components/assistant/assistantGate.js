// Whether the assistant is offered on this screen, and in which shape.
//
// One expression, because it used to be three per app and two of them
// disagreed: the header chip and the edge rail asked for `available`, the dock
// asked for `available !== false`. A project whose discovery had not answered
// yet therefore had no way in and a dock that opened anyway.
//
// `available` is `null` until discovery answers, `false` once it says no
// assistant is online there.
//
//   - A way IN waits for a yes. Offering a handle and withdrawing it is the
//     flicker `useAssistantAvailable` caches to avoid, and a handle that opens
//     an empty panel is worse than no handle.
//   - A dock already OPEN stays open through the not-yet-known state, so
//     walking to the next document does not blink it out and back.
//   - A dock open on a project with no assistant is not shown, and the shell
//     pads by `showDock`, so the gutter goes with it. The open state itself is
//     left alone: it is the reader's, and walking past a project without an
//     assistant is no reason to forget it.

export const assistantGate = ({
  wide = false,
  open = false,
  projectId = null,
  available = null,
  routeHasProject = false,
} = {}) => {
  // Offer to pick a project only where none is in scope AND the route is not
  // itself under one. The route test keeps the picker off the new-project
  // wizard and the importers, which publish no subject and have no annotation
  // to ask about.
  const offerPicker = !projectId && !routeHasProject;
  const showDock = !!(open && wide && (projectId ? available !== false : offerPicker));
  const showHandle = !!(wide && !showDock && (projectId ? available === true : offerPicker));
  return { showHandle, showDock, showPicker: showDock && !projectId };
};
