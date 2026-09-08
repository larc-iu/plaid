import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Outlet, useParams } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useCatalog } from '@/contexts/CatalogContext';
import { findBySlug } from '@/domain/dictionaries';
import { dictCollator, readDictRecord } from '@/domain/dictConfig';
import { statusKeyOf } from '@/domain/publication';
import {
  buildFormPages,
  buildIndex,
  buildSearchIndex,
  readDictionary,
} from '@/domain/dictionaryView';
import { displayForm } from '@/domain/entryFields';
import { formPath } from '@/domain/paths';
import { normalizeVocabFields } from '@igt/domain/vocabFields.js';
import { readVocabFields } from '@igt/domain/igtConfig.js';

// One dictionary, loaded once and shared by its front page and its form pages.
// A whole vocabulary is one request; the pages, the index and the search index
// are derived from it and never fetched again while the reader moves around.
const DictionaryContext = createContext(null);

export const useDictionary = () => {
  const context = useContext(DictionaryContext);
  if (!context) throw new Error('useDictionary must be used within a DictionaryProvider');
  return context;
};

export const DictionaryProvider = () => {
  const { slug } = useParams();
  const { client } = useAuth();
  const { vocabularies, loading: catalogLoading } = useCatalog();

  const vocab = useMemo(() => findBySlug(vocabularies, slug), [vocabularies, slug]);
  const record = useMemo(() => readDictRecord(vocab?.config), [vocab?.config]);

  const [items, setItems] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!client || !vocab) return undefined;
    let alive = true;
    setItems(null);
    (async () => {
      try {
        const { items: fetched = [] } = await client.vocabLayers.get(vocab.id, true);
        if (alive) setItems(fetched);
      } catch (err) {
        console.error('Failed to load the dictionary:', err);
        if (alive) {
          setItems([]);
          setError('The entries could not be loaded.');
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, vocab]);

  const value = useMemo(() => {
    const fields = normalizeVocabFields(readVocabFields(vocab?.config));
    const collator = dictCollator(record);
    const dictionary = readDictionary(items || [], statusKeyOf(fields));
    const pages = items ? buildFormPages(items, collator, dictionary) : [];
    const objectLang = record?.languages?.object?.iso639P3 || undefined;
    // A reference to an entry the dictionary does not show is not a link to
    // nowhere: it is dropped.
    const resolveRef = (id) => {
      const target = dictionary.visible.has(id) ? dictionary.tree.byId.get(id) : null;
      if (!target) return null;
      return {
        id,
        form: displayForm(target),
        number: dictionary.numbers.get(id) ?? '',
        to: formPath(slug, dictionary.tree.byId.get(dictionary.tree.rootOf.get(id)).form),
        lang: objectLang,
      };
    };
    return {
      slug,
      vocab,
      record,
      fields,
      collator,
      // The object language's tag, put on every piece of object-language text
      // so a browser knows what it is rendering.
      objectLang,
      // The sentence layers shown under an example, in the order the dictionary
      // asked for them. Null until it has chosen, which shows every one.
      exampleLayers: record?.exampleLayers ?? null,
      resolveRef,
      items,
      pages,
      index: buildIndex(pages, collator),
      searchIndex: items ? buildSearchIndex(items, fields) : new Map(),
      loading: catalogLoading || (!!vocab && items === null),
      missing: !catalogLoading && !vocab,
      error,
    };
  }, [slug, vocab, record, items, catalogLoading, error]);

  return <DictionaryContext.Provider value={value}>{<Outlet />}</DictionaryContext.Provider>;
};
