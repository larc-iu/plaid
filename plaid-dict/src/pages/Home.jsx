import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Settings } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useCatalog } from '@/contexts/CatalogContext';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { classifyVocabularies, canManage } from '@/domain/dictionaries';
import { readDictRecord, dictTitle } from '@/domain/dictConfig';
import { Button } from '@/components/ui/button';

// Several vocabularies routinely share a name, so every row carries its entry
// count: often the only thing that tells two of them apart.
const entryCount = (counts, id) => {
  const n = counts?.[id];
  return typeof n === 'number' ? `${n.toLocaleString()} ${n === 1 ? 'entry' : 'entries'}` : '';
};

const DictionaryCard = ({ vocab, user, counts }) => {
  const record = readDictRecord(vocab.config);
  const language = record?.languages?.object?.name || '';
  return (
    <li className="flex items-center justify-between gap-4 rounded-lg border bg-card p-4">
      <div className="min-w-0">
        <Link
          to={`/${record.slug}`}
          className="font-serif text-lg font-semibold underline-offset-4 hover:underline"
        >
          {dictTitle(vocab)}
        </Link>
        <p className="truncate text-sm text-muted-foreground">
          {[language, entryCount(counts, vocab.id), `/${record.slug}`].filter(Boolean).join(' · ')}
        </p>
      </div>
      {canManage(vocab, user) && (
        <Button asChild variant="ghost" size="sm">
          <Link to={`/setup/${vocab.id}`}>
            <Settings className="mr-1.5 h-4 w-4" />
            Edit
          </Link>
        </Button>
      )}
    </li>
  );
};

export const Home = () => {
  useDocumentTitle();
  const { user } = useAuth();
  const { vocabularies, itemCounts, loading, error } = useCatalog();
  const { dictionaries, unpublished } = useMemo(
    () => classifyVocabularies(vocabularies, user),
    [vocabularies, user],
  );

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      {error && (
        <div
          role="alert"
          className="mb-6 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {dictionaries.length > 0 && (
        <section className="mb-10">
          <h1 className="mb-3 font-serif text-2xl font-semibold">Dictionaries</h1>
          <ul className="flex flex-col gap-2">
            {dictionaries.map((v) => (
              <DictionaryCard key={v.id} vocab={v} user={user} counts={itemCounts} />
            ))}
          </ul>
        </section>
      )}

      {unpublished.length > 0 && (
        <section>
          <h2 className="mb-3 font-serif text-xl font-semibold">Set up a dictionary</h2>
          <ul className="flex flex-col gap-2">
            {unpublished.map((v) => (
              <li
                key={v.id}
                className="flex items-center justify-between gap-4 rounded-lg border bg-card p-4"
              >
                <div className="min-w-0">
                  <p className="truncate">{v.name}</p>
                  {entryCount(itemCounts, v.id) && (
                    <p className="text-sm text-muted-foreground">{entryCount(itemCounts, v.id)}</p>
                  )}
                </div>
                <Button asChild size="sm">
                  <Link to={`/setup/${v.id}`}>Set up</Link>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!dictionaries.length && !unpublished.length && !error && (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <BookOpen className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">No dictionaries.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Publish a vocabulary from Plaid IGT to make one.
          </p>
        </div>
      )}
    </div>
  );
};
