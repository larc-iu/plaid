import { Fragment } from 'react';
import { IsolatedLabel } from '@ui/components/shared/IsolatedLabel.jsx';
import { labelText } from '@ui/lib/bidi.js';

/**
 * A hit's notes (searchRunner.js, each one parts), each text once, joined by
 * " · ", each value in a <bdi>: it reads in its own direction, and what a
 * person copies of it is the value itself (H2-8-1, REV-G4-R2-1).
 */
export const NoteLine = ({ notes }) => {
  const seen = new Set();
  const shown = (notes || []).filter((n) => {
    const t = labelText(n);
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  return shown.map((n, i) => (
    <Fragment key={i}>
      {i > 0 && ' · '}
      <IsolatedLabel parts={n} />
    </Fragment>
  ));
};
