import { cn } from '@/lib/utils';

// An entry's name: its form and the number that tells it apart. A NUMBER is
// a homonym subscript (form₂), what a vocabulary without Lexicography Mode
// uses. A STRING is a dotted number ("1.2", see buildItemNumbers), drawn as
// text after the form: never a subscript, and never a superscript, which
// marks tone. Empty or null means the form stands alone.
export const FormLabel = ({ form, index, className = '' }) => (
  <span className={className}>
    {form}
    {typeof index === 'string' && index !== '' && (
      <span className="ml-1 text-[0.85em] font-normal tabular-nums text-muted-foreground">
        {index}
      </span>
    )}
    {typeof index === 'number' && (
      <sub className="ml-0.5 text-[0.7em] text-muted-foreground">{index}</sub>
    )}
  </span>
);

/** The name as one string, for titles and plain text. */
export const formLabelText = (form, index) =>
  index == null || index === '' ? String(form ?? '') : `${form ?? ''} ${index}`;

export const formLabelClass = cn;
