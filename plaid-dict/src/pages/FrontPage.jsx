import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useDictionary } from '@/contexts/DictionaryContext';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { searchPages } from '@/domain/dictionaryView';
import { firstGloss } from '@/domain/entryFields';
import { dictTitle } from '@/domain/dictConfig';
import { Input } from '@/components/ui/input';
import { formPath } from '@/domain/paths';

const FormLink = ({ slug, form, lang }) => (
  <Link
    to={formPath(slug, form)}
    className="font-serif underline-offset-4 hover:underline"
    lang={lang}
  >
    {form}
  </Link>
);

export const FrontPage = () => {
  const {
    slug,
    vocab,
    record,
    pages,
    index,
    fields,
    searchIndex,
    objectLang,
    loading,
    missing,
    error,
  } = useDictionary();
  const [query, setQuery] = useState('');

  useDocumentTitle(vocab ? dictTitle(vocab) : null);

  const searching = query.trim() !== '';
  const found = useMemo(() => searchPages(pages, query, searchIndex), [pages, query, searchIndex]);

  if (missing) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-sm">No dictionary at this address.</p>
        <Link to="/" className="text-sm underline underline-offset-4">
          Dictionaries
        </Link>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }

  const language = record?.languages?.object?.name;

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-8">
        <h1 className="font-serif text-4xl font-semibold">{dictTitle(vocab)}</h1>
        {language && <p className="mt-1 text-muted-foreground">{language}</p>}
        {record?.about && (
          <p className="mt-4 max-w-prose font-serif text-lg leading-relaxed">{record.about}</p>
        )}
      </header>

      <div className="relative mb-6">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={query}
          placeholder="Search"
          aria-label="Search"
          className="pl-9"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {error && (
        <p role="alert" className="mb-6 text-sm text-destructive">
          {error}
        </p>
      )}

      <p className="mb-4 text-sm text-muted-foreground">
        {found.length.toLocaleString()} {found.length === 1 ? 'headword' : 'headwords'}
        {searching && ` of ${pages.length.toLocaleString()}`}
      </p>

      {/* A search ranks its hits, so it lists them in that order with what
          each one means. The A to Z index is for reading without a query. */}
      {searching ? (
        <ul className="divide-y">
          {found.map((page) => (
            <li key={page.form} className="flex items-baseline gap-4 py-2">
              <FormLink slug={slug} form={page.form} lang={objectLang} />
              <span className="min-w-0 flex-1 truncate font-serif text-sm text-muted-foreground">
                {firstGloss(page.headwords[0], fields, query)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <>
          {index.length > 1 && (
            <nav className="mb-6 flex flex-wrap gap-x-3 gap-y-1" aria-label="Letters">
              {index.map(({ letter }) => (
                <a
                  key={letter}
                  href={`#letter-${encodeURIComponent(letter)}`}
                  className="font-serif text-lg underline-offset-4 hover:underline"
                >
                  {letter}
                </a>
              ))}
            </nav>
          )}

          {index.map(({ letter, forms }) => (
            <section key={letter} className="mb-6">
              <h2
                id={`letter-${encodeURIComponent(letter)}`}
                className="mb-2 border-b pb-1 font-serif text-2xl font-semibold"
              >
                {letter}
              </h2>
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                {forms.map((form) => (
                  <li key={form}>
                    <FormLink slug={slug} form={form} lang={objectLang} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}

      {!found.length && (
        <p className="py-10 text-center text-sm text-muted-foreground">Nothing found.</p>
      )}

      {(record?.credits || record?.citation) && (
        <footer className="mt-12 border-t pt-6 text-sm text-muted-foreground">
          {record.credits && <p className="whitespace-pre-line">{record.credits}</p>}
          {record.citation && <p className="mt-2 whitespace-pre-line">{record.citation}</p>}
        </footer>
      )}
    </div>
  );
};
