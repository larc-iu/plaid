import { Link } from 'react-router-dom';
import { displayForm, entryText } from '@/domain/entryFields';

// A gloss or definition in a language the dictionary names elsewhere gets no
// tag; where a field carries one, it is set small before the text, the way a
// print dictionary marks its languages.
const TextLine = ({ entry, className }) => (
  <p className={className}>
    {entry.lang && (
      <span className="mr-1.5 align-baseline text-[0.7em] uppercase tracking-wide text-muted-foreground">
        {entry.lang}
      </span>
    )}
    {entry.value}
  </p>
);

const Meanings = ({ item, fields }) => {
  const { pos, glosses, definitions, others } = entryText(item, fields);
  // A container headword carries no text of its own, only senses.
  if (!pos && !glosses.length && !definitions.length && !others.length) return null;
  return (
    <div className="min-w-0">
      {pos && <p className="text-sm italic text-muted-foreground">{pos}</p>}
      {glosses.map((g) => (
        <TextLine key={g.name} entry={g} className="font-serif text-base" />
      ))}
      {definitions.map((d) => (
        <TextLine key={d.name} entry={d} className="font-serif text-sm text-muted-foreground" />
      ))}
      {others.length > 0 && (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
          {others.map((o) => (
            <div key={o.name} className="contents">
              <dt className="text-muted-foreground">{o.label}</dt>
              <dd className="font-serif">{o.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
};

// A sense: its number in the margin, its meanings beside it, its own senses
// indented under it.
const Sense = ({ node, fields }) => (
  <li>
    <div className="flex gap-3">
      <span className="w-10 shrink-0 pt-0.5 text-right text-sm tabular-nums text-muted-foreground">
        {node.number}
      </span>
      {node.shown ? (
        <Meanings item={node.item} fields={fields} />
      ) : (
        <span className="pt-0.5 font-serif">{displayForm(node.item)}</span>
      )}
    </div>
    {node.senses.length > 0 && (
      <ol className="ml-10 mt-1 flex flex-col gap-1.5">
        {node.senses.map((s) => (
          <Sense key={s.item.id} node={s} fields={fields} />
        ))}
      </ol>
    )}
  </li>
);

/**
 * One headword and everything under it. `to` makes the headword a link, which
 * is what the front page wants and the form page does not.
 */
export const EntryArticle = ({ node, fields, to = null, lang }) => {
  const heading = (
    <>
      <span className="font-serif text-2xl font-semibold" lang={lang}>
        {displayForm(node.item)}
      </span>
      {node.number && (
        <span className="ml-2 align-baseline text-base tabular-nums text-muted-foreground">
          {node.number}
        </span>
      )}
    </>
  );
  return (
    <article className="py-5">
      <header className="mb-1.5">
        {to ? (
          <Link to={to} className="underline-offset-4 hover:underline">
            {heading}
          </Link>
        ) : (
          heading
        )}
      </header>
      {/* An unpublished headword is the heading over its published senses and
          nothing more: the tree's spine is structure, not content. */}
      {node.shown && (
        <div className="ml-10">
          <Meanings item={node.item} fields={fields} />
        </div>
      )}
      {node.senses.length > 0 && (
        <ol className="mt-2 flex flex-col gap-2">
          {node.senses.map((s) => (
            <Sense key={s.item.id} node={s} fields={fields} />
          ))}
        </ol>
      )}
    </article>
  );
};
