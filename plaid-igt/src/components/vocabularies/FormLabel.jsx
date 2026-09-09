// An entry's name: its form and the dotted number that tells it apart ("1.2",
// see buildItemNumbers), drawn as a SUBSCRIPT after the form — kai₁, the way
// FieldWorks writes a homograph number, which is what these users read
// elsewhere. Never a superscript, which marks tone.
//
// Subscripts were how a homonym number was drawn until 39f7319e (2026-09-07)
// removed Lexicography Mode; the branch that survived was the dotted number's,
// which had been plain text, so the presentation changed for everyone as a side
// effect of deleting a flag. This puts it back.
//
// `<sub>` rather than a styled span: it is what the element is for, so a
// screen reader and a copy-paste both keep the distinction.
//
// Empty or null means the form stands alone. `vocab-num` on the number is the
// hook the e2e specs select it by, the React counterpart of the island's
// `igt-vocab__num`.
export const FormLabel = ({ form, index, className = '' }) => (
  <span className={className}>
    {form}
    {index ? (
      <sub className="vocab-num ml-0.5 font-normal tabular-nums text-muted-foreground">{index}</sub>
    ) : null}
  </span>
);
