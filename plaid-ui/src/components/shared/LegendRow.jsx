// One line of an editor's legend: what it is about, then its gestures.
export const LegendRow = ({ title, children }) => (
  <div className="flex gap-3 py-1">
    <strong className="w-24 shrink-0 font-medium text-foreground">{title}</strong>
    <span className="min-w-0">{children}</span>
  </div>
);
