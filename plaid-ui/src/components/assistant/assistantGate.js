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
//   - A screen that is not a project's own offers the project picker, and
//     keeps it, saying so, when the project picked there has no assistant.
//     Only a project picked there since the panel opened is named: one the
//     reader only walked through on the way to the list was not asked about.
//   - Nothing is offered on the app's own Assistant screen. The full tab is
//     already showing the conversation, and a dock beside it drew the same
//     live turn a second time, each copy with its own step list, Stop button
//     and composer, and nothing saying which one was the live one.

export const assistantGate = ({
  wide = false,
  open = false,
  projectId = null,
  available = null,
  projectScreen = false,
  picked = false,
  assistantRoute = false,
} = {}) => {
  // Offer to pick a project only on a screen that is not a project's own (the
  // project list, a vocabulary list, the profile). `projectScreen` covers a
  // screen that published a project and a route under one, which keeps the
  // picker off the new-project wizard and the importers, with no annotation to
  // ask about.
  //
  // There the picker stands until the project the panel holds is known to have
  // an assistant. Which projects have one is known only per project, so the
  // way in is offered whatever the answer, and a project picked with none
  // leaves the panel open on the picker, saying so, rather than closing it with
  // nothing said.
  const offerPicker = !projectScreen && available !== true;
  const showDock = !!(
    open &&
    wide &&
    !assistantRoute &&
    (offerPicker || (projectId && available !== false))
  );
  const showHandle = !!(
    wide &&
    !assistantRoute &&
    !showDock &&
    (offerPicker || (projectId && available === true))
  );
  const showPicker = showDock && offerPicker;
  return {
    showHandle,
    showDock,
    showPicker,
    noAssistant: showPicker && picked && !!projectId && available === false,
  };
};
