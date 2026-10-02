// Opening a flagged value on the Validation tab: where a span field's value
// fails its tagset, judged cell by cell as the Analyze grid judges it, an open
// list as closing it would (asClosed), as the scan counted it.

import { asClosed, readingTagset, validateValue } from '@/domain/tagsets';
import { morphemeCellReading, runHitsSearch } from '../search/searchRunner.js';

// A span field's value where it sits fails the tagset as the Analyze grid
// reads that cell: a morpheme's gloss by its morph type and form, beside the
// glosses of its word's other morphemes.
export const failsInCell =
  (g) =>
  ({ token, morpheme, span }) =>
    validateValue(
      span?.value ?? '',
      readingTagset(
        asClosed(g.tagset),
        morpheme ? morphemeCellReading(token, morpheme, g.domain.field) : undefined,
      ),
    ).length > 0;

// Where a span field's flagged value fails, and how many of the occurrences
// looked at pass (`passed`). Every group lists only failing occurrences, and
// its count is theirs.
export const locateFailing = async (client, project, layerInfo, g, value) => {
  const fails = failsInCell(g);
  let passed = 0;
  const keep = (site) => {
    if (fails(site)) return true;
    passed++;
    return false;
  };
  const res = await runHitsSearch(client, project, layerInfo, g.domain, value, 'exact', { keep });
  return { ...res, passed };
};

// How many failing occurrences an opened row lists, when it lists them all:
// every document holding the value was loaded and none was cut short. Null
// otherwise, and for a row whose occurrences are not judged cell by cell.
export const listedCount = (res) => {
  if (!res || res.failed || res.passed === undefined) return null;
  if (res.remainingDocs > 0 || res.groups.some((grp) => grp.capped)) return null;
  return res.groups.reduce((a, grp) => a + grp.docHits, 0);
};
