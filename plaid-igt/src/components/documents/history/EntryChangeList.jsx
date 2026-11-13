import { Link } from 'react-router-dom';
import { historyHref } from '@ui/hooks/useHistoryParam.js';
import { ChangeValue } from './ChangeValue.jsx';

const STATE_WORDS = { added: 'Added', changed: 'Changed', deleted: 'Deleted', merged: 'Merged' };

// A value of an entry, which carries no provenance of its own here.
const plain = (f) => ({
  before: f.before,
  after: f.after,
  beforeProv: null,
  afterProv: null,
  changed: true,
  replaced: false,
});

/**
 * The lexicon entries an entry changed (`entries`, from entryChanges): each
 * by its name, a link to it, or for one that is gone to its vocabulary's
 * History at this entry (`entryId`), what happened to it, and each field it
 * changed, the new value over the old one.
 */
export const EntryChangeList = ({ entries, entryId }) => (
  <ul className="flex flex-col gap-2">
    {entries.map((e) => {
      const gone = e.state === 'deleted' || e.state === 'merged';
      const to = gone
        ? historyHref(`/vocabularies/${e.vocabId}`, entryId)
        : `/vocabularies/${e.vocabId}?item=${encodeURIComponent(e.id)}`;
      return (
        <li key={e.id} data-entry={e.id} className="rounded-lg border bg-card px-3 py-2 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <Link to={to} className="font-text font-medium hover:underline" dir="auto">
              {e.name || 'Entry'}
            </Link>
            <span className="text-xs text-muted-foreground">
              {STATE_WORDS[e.state]}
              {e.into && (
                <>
                  {' into '}
                  <Link
                    to={`/vocabularies/${e.vocabId}?item=${encodeURIComponent(e.into.id)}`}
                    className="font-text hover:underline"
                    dir="auto"
                  >
                    {e.into.name}
                  </Link>
                </>
              )}
            </span>
            {e.changedSince && (
              <span className="text-xs text-muted-foreground">Changed again later</span>
            )}
          </div>
          {e.fields.length > 0 && (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {e.fields.map((f) => (
                <div key={f.label} className="contents">
                  <dt className="text-xs text-muted-foreground">{f.label}</dt>
                  <dd className="font-text" dir="auto">
                    <ChangeValue c={plain(f)} />
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </li>
      );
    })}
  </ul>
);
