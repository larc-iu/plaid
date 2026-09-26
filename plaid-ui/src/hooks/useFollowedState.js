// `useState` for screen state that can hold a pending id: a selection, a
// focused or hovered row, an open editor, a drag. A row made a moment ago is
// on screen under a pending id until the server answers with its own
// (domain/pendingIds.js), and state that still names the pending id then
// points at nothing, so an open editor closes and focus is lost.
//
// The value is followed to the server's ids during render (`followIds`, deep
// through plain objects and arrays), so the swap is seen in the same render
// that shows the settled document. The setter is React's own.

import { useState } from 'react';
import { followIds } from '../domain/pendingIds.js';

export function useFollowedState(initial) {
  const [value, setValue] = useState(initial);
  const followed = followIds(value);
  if (followed !== value) setValue(followed);
  return [followed, setValue];
}
