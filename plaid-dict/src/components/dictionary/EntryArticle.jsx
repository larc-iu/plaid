import { Link } from 'react-router-dom';
import { displayForm, entryExamples, entryRefs, entryText } from '@/domain/entryFields';

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

// An example: the sentence, then the lines the dictionary chose to show under
// it. A line is named only when there is more than one, since a lone
// translation needs no label to say what it is.
const Examples = ({ examples, lang }) => (
  <ul className="mt-1.5 flex flex-col gap-1.5">
    {examples.map((example, i) => (
      <li key={i} className="border-l-2 pl-3">
        <p className="font-serif text-sm" lang={lang}>
          {example.text}
        </p>
        {example.lines.map((line, j) => (
          <p key={j} className="font-serif text-sm italic text-muted-foreground">
            {example.lines.length > 1 && line.name && (
              <span className="mr-1.5 align-baseline text-[0.8em] not-italic">{line.name}</span>
            )}
            {'\u2018'}
            {line.value}
            {'\u2019'}
          </p>
        ))}
      </li>
    ))}
  </ul>
);

// A reference field: its label, then a link per entry it points at, named the
// way the entry is named everywhere else.
const References = ({ refs }) => (
  <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
    {refs.map((ref) => (
      <div key={ref.name} className="contents">
        <dt className="text-muted-foreground">{ref.label}</dt>
        <dd className="font-serif">
          {ref.targets.map((target, i) => (
            <span key={target.id}>
              {i > 0 && ', '}
              <Link
                to={target.to}
                lang={target.lang}
                className="underline-offset-4 hover:underline"
              >
                {target.form}
                {target.number && (
                  <span className="ml-1 text-[0.85em] tabular-nums text-muted-foreground">
                    {target.number}
                  </span>
                )}
              </Link>
            </span>
          ))}
        </dd>
      </div>
    ))}
  </dl>
);

const Meanings = ({ item, fields, resolveRef, sentences, exampleLayers, lang }) => {
  const { pos, glosses, definitions, others } = entryText(item, fields);
  const refs = resolveRef ? entryRefs(item, fields, resolveRef) : [];
  const examples = entryExamples(item, sentences, exampleLayers);
  // A container headword carries no text of its own, only senses.
  if (
    !pos &&
    !glosses.length &&
    !definitions.length &&
    !others.length &&
    !refs.length &&
    !examples.length
  )
    return null;
  return (
    <div className="min-w-0">
      {pos && <p className="text-sm italic text-muted-foreground">{pos}</p>}
      {glosses.map((g) => (
        <TextLine key={g.name} entry={g} className="font-serif text-base" />
      ))}
      {definitions.map((d) => (
        <TextLine key={d.name} entry={d} className="font-serif text-sm text-muted-foreground" />
      ))}
      {examples.length > 0 && <Examples examples={examples} lang={lang} />}
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
      {refs.length > 0 && <References refs={refs} />}
    </div>
  );
};

// A sense: its number in the margin, its meanings beside it, its own senses
// indented under it.
const Sense = ({ node, fields, resolveRef, sentences, exampleLayers, lang }) => (
  <li>
    <div className="flex gap-3">
      <span className="w-10 shrink-0 pt-0.5 text-right text-sm tabular-nums text-muted-foreground">
        {node.number}
      </span>
      {node.shown ? (
        <Meanings
          item={node.item}
          fields={fields}
          resolveRef={resolveRef}
          sentences={sentences}
          exampleLayers={exampleLayers}
          lang={lang}
        />
      ) : (
        <span className="pt-0.5 font-serif">{displayForm(node.item)}</span>
      )}
    </div>
    {node.senses.length > 0 && (
      <ol className="ml-10 mt-1 flex flex-col gap-1.5">
        {node.senses.map((s) => (
          <Sense
            key={s.item.id}
            node={s}
            fields={fields}
            resolveRef={resolveRef}
            sentences={sentences}
            exampleLayers={exampleLayers}
            lang={lang}
          />
        ))}
      </ol>
    )}
  </li>
);

/**
 * One headword and everything under it. `to` makes the headword a link, which
 * is what the front page wants and the form page does not.
 */
export const EntryArticle = ({
  node,
  fields,
  to = null,
  lang,
  resolveRef,
  sentences,
  exampleLayers,
}) => {
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
          <Meanings
            item={node.item}
            fields={fields}
            resolveRef={resolveRef}
            sentences={sentences}
            exampleLayers={exampleLayers}
            lang={lang}
          />
        </div>
      )}
      {node.senses.length > 0 && (
        <ol className="mt-2 flex flex-col gap-2">
          {node.senses.map((s) => (
            <Sense
              key={s.item.id}
              node={s}
              fields={fields}
              resolveRef={resolveRef}
              sentences={sentences}
              exampleLayers={exampleLayers}
              lang={lang}
            />
          ))}
        </ol>
      )}
    </article>
  );
};
