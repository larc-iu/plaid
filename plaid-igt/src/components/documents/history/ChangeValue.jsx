import { glossSmallCaps } from '@ui/domain/glossCase.js';
import { cn } from '@ui/lib/utils';
import { PROV_WORDS } from '@/domain/historyChanges.js';
import { provClass, provTitle } from './changeMarks.js';

// A gloss as the grid and the export set it: each tag in small caps.
const Gloss = ({ value }) =>
  glossSmallCaps(value).map((p, k) =>
    p.smallCaps ? (
      <span key={k} className="plaid-sc">
        {p.text}
      </span>
    ) : (
      p.text
    ),
  );

const Shown = ({ value, prov, gloss }) => (
  <span className={provClass(prov)} title={provTitle(prov)}>
    {gloss ? <Gloss value={value} /> : value}
  </span>
);

/**
 * One value before and after an entry (`c`, a cellDiff): the value alone
 * when the entry left it, else the new value over the old one struck through,
 * each in its own marks, the old one in red when it was a person's the entry
 * replaced. A value the entry only restamped says whose it was, in red when
 * it was a person's and is now machine-made. `gloss` sets tags in small
 * caps.
 */
export const ChangeValue = ({ c, gloss = false }) => {
  if (!c.changed) return <Shown value={c.after} prov={c.afterProv} gloss={gloss} />;
  const kind = c.replaced
    ? 'replaced'
    : c.before === ''
      ? 'added'
      : c.after === ''
        ? 'deleted'
        : 'changed';
  return (
    <span
      data-change={kind}
      className="inline-block max-w-full rounded-sm bg-highlight/60 px-1 align-top"
    >
      {c.after !== '' && (
        <span className="block">
          <Shown value={c.after} prov={c.afterProv} gloss={gloss} />
        </span>
      )}
      {c.before !== '' && c.before !== c.after && (
        <del
          className={cn(
            'block text-muted-foreground decoration-1',
            c.replaced && 'text-destructive-strong decoration-destructive',
          )}
        >
          <Shown value={c.before} prov={c.beforeProv} gloss={gloss} />
        </del>
      )}
      {c.before !== '' && c.before === c.after && (
        <span
          className={cn(
            'block font-sans text-[11px] not-italic text-muted-foreground',
            c.replaced && 'text-destructive-strong',
          )}
        >
          was {PROV_WORDS[c.beforeProv] ?? 'a person’s'}
        </span>
      )}
    </span>
  );
};
