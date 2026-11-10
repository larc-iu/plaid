import { Notice } from '@ui/components/shared/Notice.jsx';
import { problemPlace } from '../../domain/format/umrFile.js';
import { countOf } from '@ui/lib/plural.js';

// The most listed at once: a corpus with a bad value on every sentence would
// otherwise push the page far below the button.
const SHOWN = 50;

/** Why an export was refused: each stored value a .umr file cannot hold. */
export const ExportProblems = ({ problems }) => (
  <Notice tone="error" role="alert">
    <p className="font-medium">Failed to export. These cannot be written to a .umr file:</p>
    <ul className="mt-1 list-disc ps-5">
      {problems.slice(0, SHOWN).map((p, i) => (
        <li key={i}>
          <span className="font-medium">{problemPlace(p)}</span>: {p.message}
        </li>
      ))}
    </ul>
    {problems.length > SHOWN && <p className="mt-1">{problems.length - SHOWN} more.</p>}
  </Notice>
);

/** What the file leaves out: each part of a sentence no root reaches. */
export const LeftOutOfExport = ({ parts }) => {
  const nodes = parts.reduce((sum, p) => sum + p.nodes, 0);
  return (
    <Notice tone="warning">
      <p className="font-medium">{countOf(nodes, 'node')} left out of the file:</p>
      <ul className="mt-1 list-disc ps-5">
        {parts.slice(0, SHOWN).map((p, i) => (
          <li key={i}>
            <span className="font-medium">Sentence {p.sentence}</span>: {p.message}
          </li>
        ))}
      </ul>
      {parts.length > SHOWN && <p className="mt-1">{parts.length - SHOWN} more.</p>}
    </Notice>
  );
};
