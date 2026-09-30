import { conflictNoteParts } from '../../lib/cellConflict.js';

/**
 * The note under a grid cell whose edit lost to another user's: "Yours: X ·
 * Enter to keep yours". The cell names it in its aria-describedby, so
 * arriving there reads it. It has no `dir` of its own, so it hangs from the
 * cell's start in the sentence's direction. Its words are chrome and read
 * left to right, the value its own way.
 */
export const ConflictNote = ({ id, className, typed }) => {
  const { before, value, after } = conflictNoteParts(typed);
  return (
    <span id={id} className={className} role="status">
      <span dir="ltr">
        {before}
        <bdi>{value}</bdi>
        {after}
      </span>
    </span>
  );
};
