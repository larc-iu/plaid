// What a drawn turn needs to know about the turns around it. The chat and the
// admin area's read-only transcript both draw a conversation with `Turn`, and
// both take these from here, so a stored conversation reads the same in each.

import { planProjectAt, projectNamesAt, reachChanged } from './projectReach.js';

// The model that wrote the reply before this one. A conversation keeps the
// assistant it started with, but that one can go offline and another answer
// in its place, and then the transcript should say where each reply came from.
const previousModel = (display, i) => {
  for (let k = i - 1; k >= 0; k--) {
    if (display[k].kind === 'assistant') return display[k].model || null;
  }
  return null;
};

// Whether the question at `i` was asked from somewhere new. Marking every
// message with where it was asked from says the same thing over and over in a
// thread that never moved; marking the CHANGES says the one thing a reader of
// an old thread cannot otherwise recover. The service's stamp on the model's
// own copy follows the same rule, for the same reason.
export const movedHere = (display, i) => {
  const here = display[i]?.where;
  if (!here) return false;
  for (let k = i - 1; k >= 0; k--) {
    const was = display[k].kind === 'user' ? display[k].where : null;
    if (was) return was.kind !== here.kind || was.id !== here.id;
  }
  return true;
};

// A step's output, looked up by the tool call it belongs to. The transcript
// is where it is stored, so the trace does not carry a second copy.
export const toolResults = (messages) =>
  new Map(
    (messages || [])
      .filter((m) => m.role === 'tool' && m.toolCallId)
      .map((m) => [m.toolCallId, String(m.content ?? '')]),
  );

// The props of item `i` that depend on the items before it: the line naming
// another model, the place and the projects where they changed, the other
// projects' names for its citations, and the project its plan writes in.
export const turnContext = (display, i) => {
  const d = display[i];
  const before = previousModel(display, i);
  return {
    fromAnotherModel: !!d.model && !!before && d.model !== before,
    movedHere: movedHere(display, i),
    reachChanged: reachChanged(display, i),
    citeNames: d.citations?.length ? projectNamesAt(display, i) : null,
    planProject: planProjectAt(display, i),
  };
};
