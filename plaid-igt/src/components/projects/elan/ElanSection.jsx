// One step of the ELAN review, in the order a person works: the files they
// chose, how the tiers map, what comes out. A numbered heading and no box: a
// box is kept for what needs attention (ImportPanels' Panel), so that on a
// screen with nothing wrong nothing is shouting.
export const ElanSection = ({ step, title, note = null, aside = null, children }) => (
  <section className="flex flex-col gap-3" aria-label={title}>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span
        aria-hidden="true"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
      >
        {step}
      </span>
      <h2 className="text-lg font-semibold">{title}</h2>
      {note && <p className="min-w-0 flex-1 text-sm text-muted-foreground">{note}</p>}
      {aside && <div className="ml-auto flex shrink-0 items-center gap-2">{aside}</div>}
    </div>
    {children}
  </section>
);
