import { ChevronRight } from 'lucide-react';

// Clickable row header (LEMMA/XPOS/UPOS/FEATS). Always shown so a collapsed row
// can be re-expanded; the leading chevron reflects state (rotated down = expanded,
// pointing right = collapsed).
// When no onToggle is provided (e.g. the read-only historical view) it renders as
// a plain, non-interactive label.
export const RowLabelHeader = ({ field, label, expanded, onToggle, style }) => {
  const interactive = Boolean(onToggle);
  return (
    <div
      className={`row-label${interactive ? ' row-label--toggle' : ''}`}
      style={style}
      onClick={interactive ? () => onToggle(field) : undefined}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? -1 : undefined}
      title={interactive ? `${expanded ? 'Hide' : 'Show'} ${label}` : undefined}
    >
      {interactive && (
        <ChevronRight
          width={12}
          height={12}
          className="row-label__chevron"
          style={{
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 150ms ease',
          }}
        />
      )}
      {label}
    </div>
  );
};
