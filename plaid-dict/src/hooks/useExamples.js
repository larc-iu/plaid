import { useEffect, useState } from 'react';
import { collectExampleRefs } from '@/domain/entryFields';

/**
 * The sentences behind every promoted example on a page, as a Map keyed by
 * `document/token`. Null while the first read is still out, so a caller can
 * tell "not yet" from "not there".
 *
 * The resolver is imported on demand: it reaches into plaid-igt's document
 * machinery, which is the biggest thing this app can load and which no screen
 * without promoted examples needs at all.
 */
export const useExamples = (client, headwords) => {
  const key = (headwords || [])
    .flatMap((node) => collectExampleRefs(node))
    .map((ref) => `${ref.document}/${ref.token}`)
    .join(',');
  const [sentences, setSentences] = useState(null);

  useEffect(() => {
    if (!client || !key) {
      setSentences(new Map());
      return undefined;
    }
    let alive = true;
    setSentences(null);
    const refs = key.split(',').map((pair) => {
      const [document, token] = pair.split('/');
      return { document, token };
    });
    import('@/domain/examples')
      .then(({ resolveExamples }) => resolveExamples(client, refs))
      .then((found) => {
        if (alive) setSentences(found);
      })
      .catch((err) => {
        console.error('Examples could not be read:', err);
        if (alive) setSentences(new Map());
      });
    return () => {
      alive = false;
    };
  }, [client, key]);

  return sentences;
};
