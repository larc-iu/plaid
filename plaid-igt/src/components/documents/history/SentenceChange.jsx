import { Link } from 'react-router-dom';
import { cn } from '@ui/lib/utils';
import { countOf } from '@ui/lib/plural.js';
import { APP_ROUTES } from '@/appRoutes.js';
import { ChangeValue } from './ChangeValue.jsx';

// Rows whose values are glosses, set in small caps as the grid sets them.
const GLOSS_KINDS = new Set(['word', 'morph']);

const STATE_WORDS = { added: 'Added', deleted: 'Deleted' };

/**
 * One sentence an entry changed (`s`, from sentenceChanges), as an
 * interlinear block: a column per word, a row per tier the sentence has a
 * value in on either side, each cell the value after the entry over the one
 * it replaced. A morpheme row holds each morpheme's value apart, so a gloss
 * written beside another keeps its own marks. A word the entry made or
 * deleted is a column of its own. The
 * columns lay out in the document's direction (`dir`), each value in its own.
 * Under the block, the sentence's text where the entry changed it, its
 * sentence fields and the expressions the entry linked or unlinked.
 */
export const SentenceChange = ({ s, dir, projectId, documentId }) => (
  <section
    data-sentence={s.id}
    data-replaced={s.replaced || undefined}
    className="rounded-lg border bg-card px-3 py-2 text-sm"
  >
    <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 text-xs">
      {s.state === 'deleted' ? (
        <span className="font-medium">Sentence {s.number}</span>
      ) : (
        <Link
          className="font-medium hover:underline"
          to={APP_ROUTES.sentence(projectId, documentId, s.id)}
        >
          Sentence {s.number}
        </Link>
      )}
      {STATE_WORDS[s.state] && (
        <span className="rounded border px-1.5 text-[11px] font-medium text-muted-foreground">
          {STATE_WORDS[s.state]}
        </span>
      )}
      <span className="text-muted-foreground">{countOf(s.changes, 'change')}</span>
      {s.changedSince && <span className="text-muted-foreground">Changed again later</span>}
    </div>
    <div className="overflow-x-auto">
      <table
        dir={dir}
        className={cn(
          'border-separate border-spacing-0 whitespace-nowrap',
          dir === 'rtl' && 'ml-auto',
        )}
      >
        <tbody>
          {s.lines.map((line) => (
            <tr key={line.key} data-row={line.key}>
              <th
                scope="row"
                className="sticky start-0 z-10 bg-card pe-3 text-start align-top text-[11px] font-normal leading-5 text-muted-foreground"
              >
                <span className="block max-w-[7rem] truncate" title={line.label || undefined}>
                  {line.label}
                </span>
              </th>
              {line.cells.map((c, j) => (
                <td
                  key={s.columns[j].id}
                  data-column={s.columns[j].state}
                  dir="auto"
                  className={cn(
                    'px-1 align-top font-text leading-5',
                    line.kind === 'surface' ? 'font-medium' : 'text-xs',
                  )}
                >
                  {c.pieces ? (
                    <Pieces pieces={c.pieces} gloss={GLOSS_KINDS.has(line.kind)} />
                  ) : (
                    <ChangeValue c={c} gloss={GLOSS_KINDS.has(line.kind)} />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {s.text.changed && (
      <Field label="Text">
        <ChangeValue c={{ ...s.text, beforeProv: null, afterProv: null }} />
      </Field>
    )}
    {s.fields.map((f) => (
      <Field key={f.label} label={f.label}>
        <ChangeValue c={f} />
      </Field>
    ))}
    {s.mwes.map((m) => (
      <Field key={m.id} label={`Expression (${m.words})`}>
        <ChangeValue c={m} />
      </Field>
    ))}
  </section>
);

// A word's morpheme values side by side, each before and after on its own,
// with the joiners the grid writes between them.
const Pieces = ({ pieces, gloss }) => (
  <span className="inline-flex items-start">
    {pieces.map((p) => (
      <span key={p.id} className="inline-flex items-start" data-piece={p.id}>
        {p.joiner && <span className="text-muted-foreground">{p.joiner}</span>}
        <ChangeValue c={p} gloss={gloss} />
      </span>
    ))}
  </span>
);

const Field = ({ label, children }) => (
  <div className="mt-2 flex items-baseline gap-2">
    <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
    <span className="min-w-0 font-text" dir="auto">
      {children}
    </span>
  </div>
);
