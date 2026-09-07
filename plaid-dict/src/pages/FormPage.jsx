import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useDictionary } from '@/contexts/DictionaryContext';
import { useExamples } from '@/hooks/useExamples';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { dictTitle } from '@/domain/dictConfig';
import { dictionaryPath, formPath } from '@/domain/paths';
import { EntryArticle } from '@/components/dictionary/EntryArticle';

// One page per surface form, with every published headword spelled that way on
// it, in homograph order.
export const FormPage = () => {
  const { form } = useParams();
  const { client } = useAuth();
  const { slug, vocab, pages, fields, objectLang, resolveRef, exampleLayers, loading, missing } =
    useDictionary();

  const page = useMemo(() => (pages || []).find((p) => p.form === form) || null, [pages, form]);
  // The forms either side, so a reader can page through the dictionary.
  const neighbours = useMemo(() => {
    const at = (pages || []).findIndex((p) => p.form === form);
    if (at < 0) return { previous: null, next: null };
    return {
      previous: at > 0 ? pages[at - 1].form : null,
      next: at < pages.length - 1 ? pages[at + 1].form : null,
    };
  }, [pages, form]);

  const sentences = useExamples(client, page?.headwords);

  useDocumentTitle(form, vocab ? dictTitle(vocab) : null);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }

  if (missing || !page) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-sm">{missing ? 'No dictionary at this address.' : 'No such entry.'}</p>
        <Link
          to={missing ? '/' : dictionaryPath(slug)}
          className="text-sm underline underline-offset-4"
        >
          {missing ? 'Dictionaries' : dictTitle(vocab)}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link
        to={dictionaryPath(slug)}
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        <ArrowLeft className="h-4 w-4" />
        {dictTitle(vocab)}
      </Link>

      <div className="divide-y">
        {page.headwords.map((node) => (
          <EntryArticle
            key={node.item.id}
            node={node}
            fields={fields}
            lang={objectLang}
            resolveRef={resolveRef}
            sentences={sentences}
            exampleLayers={exampleLayers}
          />
        ))}
      </div>

      <nav className="mt-8 flex items-center justify-between border-t pt-4 text-sm">
        {neighbours.previous ? (
          <Link
            to={formPath(slug, neighbours.previous)}
            className="inline-flex items-center gap-1.5 underline-offset-4 hover:underline"
          >
            <ChevronLeft className="h-4 w-4 text-muted-foreground" />
            <span className="font-serif" lang={objectLang}>
              {neighbours.previous}
            </span>
          </Link>
        ) : (
          <span />
        )}
        {neighbours.next ? (
          <Link
            to={formPath(slug, neighbours.next)}
            className="inline-flex items-center gap-1.5 underline-offset-4 hover:underline"
          >
            <span className="font-serif" lang={objectLang}>
              {neighbours.next}
            </span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </div>
  );
};
