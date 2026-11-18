import { Fragment } from 'react';
import { labelParts } from '../../lib/bidi.js';

const draw = (parts) =>
  parts.map((p, i) =>
    typeof p === 'string' ? <Fragment key={i}>{p}</Fragment> : <bdi key={i}>{draw(p.isolate)}</bdi>,
  );

/**
 * A stored label (History, Activity, the Restore and Undo dialogs) with each
 * value in it in a `<bdi>`, by the rule of `labelParts` (lib/bidi.js), so a
 * right-to-left value reads in its own order. Its text is the label exactly.
 * A line already built in that shape passes `parts` instead.
 */
export const IsolatedLabel = ({ label, parts }) => <>{draw(parts ?? labelParts(label))}</>;
