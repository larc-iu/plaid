// An entry's name: its form and the dotted number that tells it apart ("1.2",
// see buildItemNumbers), drawn as text after the form: never a subscript, and
// never a superscript, which marks tone. Empty or null means the form stands
// alone.
export const FormLabel = ({ form, index, className = '' }) => (
  <span className={className}>
    {form}
    {index ? (
      <span className="ml-1 text-[0.85em] font-normal tabular-nums text-muted-foreground">
        {index}
      </span>
    ) : null}
  </span>
);
