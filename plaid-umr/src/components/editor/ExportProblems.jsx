import { problemPlace } from '../../domain/format/umrFile.js';

// The most listed at once: a corpus with a bad value on every sentence would
// otherwise push the page far below the button.
const SHOWN = 50;

/** Why an export was refused: each stored value a .umr file cannot hold. */
export const ExportProblems = ({ problems }) => (
  <div
    role="alert"
    className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
  >
    <p className="font-medium">Failed to export. These cannot be written to a .umr file:</p>
    <ul className="mt-1 list-disc ps-5">
      {problems.slice(0, SHOWN).map((p, i) => (
        <li key={i}>
          <span className="font-medium">{problemPlace(p)}</span>: {p.message}
        </li>
      ))}
    </ul>
    {problems.length > SHOWN && <p className="mt-1">{problems.length - SHOWN} more.</p>}
  </div>
);
