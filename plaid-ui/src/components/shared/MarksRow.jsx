import { reviewsAnyone } from '@larc-iu/plaid-client';
import { LegendRow } from './LegendRow.jsx';

// An editor legend's Marks line, the provenance marks in the shared
// `plaid-prov--*` classes. The contributed mark is listed only in a project
// that reviews somebody's work: everywhere else there is no contributed
// annotation, and a row for it is about a feature nobody there has.
// `lowConfidence` lists the heavier mark of a doubtful machine value, for an
// app that draws it. `children` is the app's own rest of the line.
export const MarksRow = ({ project, lowConfidence = false, children }) => (
  <LegendRow title="Marks">
    <span className="plaid-prov--machine">machine-made</span>
    {' · '}
    {lowConfidence && (
      <>
        <span className="plaid-prov--machine plaid-prov--doubtful">low confidence</span>
        {' · '}
      </>
    )}
    {reviewsAnyone(project?.config) && (
      <>
        <span className="plaid-prov--contributed">contributed</span>
        {' · '}
      </>
    )}
    {children}
  </LegendRow>
);
