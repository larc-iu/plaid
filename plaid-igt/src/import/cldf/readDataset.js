// Read a CLDF dataset from a .zip: bytes in, resolved tables out. Pure.
//
// The one rule that matters: CLDF binds meaning to columns through
// `propertyUrl`, NOT through column names. A dataset may call its gloss column
// anything at all as long as it points at
// http://cldf.clld.org/v1.0/terms.rdf#gloss, and a column NAMED "Gloss" with
// no propertyUrl is a custom column that means nothing to the format. So every
// lookup here goes through `byTerm`, and anything left over is reported as a
// custom column for the user to map by hand.
//
// Tables are likewise identified by their `dc:conformsTo` component URL, not
// by filename. Metadata-free datasets (a bare examples.csv with the spec's
// default column names and no descriptor) are also accepted, since the spec
// allows them.

import { unzipSync } from 'fflate';

const TERMS = 'http://cldf.clld.org/v1.0/terms.rdf#';

export class CldfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CldfError';
  }
}

/** "http://…#gloss" → "gloss"; anything else → null. */
const termOf = (url) =>
  typeof url === 'string' && url.startsWith(TERMS) ? url.slice(TERMS.length) : null;

// ---- CSV (RFC 4180, the CSVW default dialect) -------------------------------

/**
 * Parse delimited text into rows of cells. Handles quoted fields, doubled
 * quotes, embedded newlines, CRLF or LF, and a leading BOM.
 */
export function parseCsv(text, delimiter = ',') {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let seenCell = false;
  const endCell = () => {
    row.push(cell);
    cell = '';
    seenCell = false;
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && !seenCell) {
      quoted = true;
      seenCell = true;
    } else if (c === delimiter) endCell();
    else if (c === '\r' && s[i + 1] === '\n') {
      endRow();
      i++;
    } else if (c === '\n' || c === '\r') endRow();
    else {
      cell += c;
      seenCell = true;
    }
  }
  // A trailing newline ends the last row; anything else is a final partial row.
  if (cell !== '' || row.length) endRow();
  return rows;
}

/** Rows of cells → row objects keyed by the header, ragged rows tolerated. */
function toObjects(rows) {
  if (!rows.length) return { header: [], objects: [] };
  const header = rows[0];
  const objects = rows
    .slice(1)
    // A blank final line is not a row.
    .filter((r) => r.length > 1 || (r[0] ?? '') !== '')
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
  return { header, objects };
}

// ---- component access -------------------------------------------------------

/** A column's declared null values (CSVW default: the empty string). */
const nullsOf = (col) => {
  if (col.null === undefined) return [''];
  return Array.isArray(col.null) ? col.null : [col.null];
};

const normalize = (value, nulls) => (nulls.includes(value) ? '' : value);

/** The scalar value of `term` in `row`, or '' when the term is not present. */
export function cell(component, row, term) {
  const col = component?.byTerm?.[term];
  if (!col) return '';
  return normalize(row[col.name] ?? '', col.nulls);
}

/**
 * The list value of `term` in `row`. A column with no declared separator is
 * still readable as a one-item list, which is what a metadata-free dataset's
 * Analyzed_Word would be.
 */
export function list(component, row, term) {
  const col = component?.byTerm?.[term];
  if (!col) return [];
  const raw = row[col.name] ?? '';
  if (raw === '' && col.nulls.includes('')) return [];
  if (!col.separator) return [normalize(raw, col.nulls)];
  return raw.split(col.separator).map((v) => normalize(v, col.nulls));
}

/** Column names on this table that carry no CLDF term. */
export const customColumnsOf = (component) =>
  (component?.columns || []).filter((c) => !c.term).map((c) => c.name);

// ---- metadata-free fallback -------------------------------------------------
//
// The spec allows a dataset to be a bare CSV with the module's default column
// names and no descriptor. Only the columns the default modules declare are
// recognized, which is exactly what "metadata-free conformance" means.

const METADATA_FREE = {
  'examples.csv': {
    component: 'ExampleTable',
    columns: {
      ID: 'id',
      Language_ID: 'languageReference',
      Primary_Text: 'primaryText',
      Analyzed_Word: 'analyzedWord',
      Gloss: 'gloss',
      Translated_Text: 'translatedText',
      Meta_Language_ID: 'metaLanguageReference',
      LGR_Conformance: 'lgrConformance',
      Comment: 'comment',
    },
    separators: { Analyzed_Word: '\t', Gloss: '\t' },
  },
  'languages.csv': {
    component: 'LanguageTable',
    columns: {
      ID: 'id',
      Name: 'name',
      Glottocode: 'glottocode',
      ISO639P3code: 'iso639P3code',
      Latitude: 'latitude',
      Longitude: 'longitude',
    },
    separators: {},
  },
  'entries.csv': {
    component: 'EntryTable',
    columns: {
      ID: 'id',
      Language_ID: 'languageReference',
      Headword: 'headword',
      Part_Of_Speech: 'partOfSpeech',
    },
    separators: {},
  },
  'senses.csv': {
    component: 'SenseTable',
    columns: { ID: 'id', Description: 'description', Entry_ID: 'entryReference' },
    separators: {},
  },
  'contributions.csv': {
    component: 'ContributionTable',
    columns: {
      ID: 'id',
      Name: 'name',
      Description: 'description',
      Contributor: 'contributor',
      Citation: 'citation',
    },
    separators: {},
  },
};

// ---- the reader -------------------------------------------------------------

const decode = (bytes) => new TextDecoder('utf-8').decode(bytes);
const basename = (path) => path.split('/').at(-1);
const dirname = (path) => {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
};

/**
 * Find the dataset descriptor: any *-metadata.json whose dc:conformsTo names a
 * CLDF module. Shallowest wins, since a release commonly nests the dataset
 * under a versioned directory (`mydata-1.0/cldf/cldf-metadata.json`).
 */
function findDescriptor(entries) {
  const candidates = Object.keys(entries)
    .filter((p) => !p.endsWith('/') && basename(p).endsWith('-metadata.json'))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const path of candidates) {
    try {
      const json = JSON.parse(decode(entries[path]));
      const module = termOf(json['dc:conformsTo']);
      if (module) return { path, json, module };
    } catch {
      // Not JSON, or not a descriptor: keep looking.
    }
  }
  return null;
}

function buildComponent({ url, conformsTo, columnSpecs, rows, delimiter }) {
  const text = decode(rows);
  const { header, objects } = toObjects(parseCsv(text, delimiter));
  // Columns the descriptor declares, restricted to those the CSV actually has,
  // plus any extra CSV columns the descriptor never mentioned.
  const declared = new Map(columnSpecs.map((c) => [c.name, c]));
  const columns = header.map((name) => {
    const spec = declared.get(name);
    return {
      name,
      term: spec ? termOf(spec.propertyUrl) : null,
      separator: spec?.separator ?? null,
      nulls: spec ? nullsOf(spec) : [''],
    };
  });
  const byTerm = {};
  for (const c of columns) if (c.term && !byTerm[c.term]) byTerm[c.term] = c;
  return { url, component: conformsTo, columns, byTerm, rows: objects };
}

/**
 * @param {Uint8Array} bytes - a .zip holding a CLDF dataset
 * @returns {{module, title, baseDir, components, entries, warnings}}
 *   components: { [componentName]: {url, columns, byTerm, rows} }
 */
export function readCldfDataset(bytes) {
  let entries;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new CldfError('Not a zip archive');
  }

  const warnings = [];
  const components = {};
  const found = findDescriptor(entries);

  if (found) {
    const baseDir = dirname(found.path);
    const delimiter = found.json.dialect?.delimiter ?? ',';
    for (const table of found.json.tables || []) {
      const conformsTo = termOf(table['dc:conformsTo']);
      const path = `${baseDir}${table.url}`;
      if (!entries[path]) {
        warnings.push(`Table file missing from the archive: ${table.url}`);
        continue;
      }
      if (!conformsTo) continue; // A table bound to no component carries nothing we can read.
      if (components[conformsTo]) {
        warnings.push(`More than one ${conformsTo}; using ${components[conformsTo].url}`);
        continue;
      }
      components[conformsTo] = buildComponent({
        url: table.url,
        conformsTo,
        columnSpecs: table.tableSchema?.columns || [],
        rows: entries[path],
        delimiter: table.dialect?.delimiter ?? delimiter,
      });
    }
    if (!Object.keys(components).length) {
      throw new CldfError(
        `The dataset descriptor (${basename(found.path)}) declares no readable tables.`,
      );
    }
    return {
      module: found.module,
      title: found.json['dc:title'] || '',
      baseDir,
      components,
      entries,
      warnings,
    };
  }

  // No descriptor: metadata-free conformance, by the spec's default filenames.
  for (const [path, data] of Object.entries(entries)) {
    if (path.endsWith('/')) continue;
    const spec = METADATA_FREE[basename(path).toLowerCase()];
    if (!spec || components[spec.component]) continue;
    components[spec.component] = buildComponent({
      url: basename(path),
      conformsTo: spec.component,
      columnSpecs: Object.entries(spec.columns).map(([name, term]) => ({
        name,
        propertyUrl: `${TERMS}${term}`,
        ...(spec.separators[name] ? { separator: spec.separators[name] } : {}),
      })),
      rows: data,
      delimiter: ',',
    });
  }
  if (!components.ExampleTable && !components.EntryTable) {
    throw new CldfError(
      'No CLDF dataset found in this archive. Expected a cldf-metadata.json descriptor, ' +
        'or an examples.csv / entries.csv using the standard CLDF column names.',
    );
  }
  warnings.push(
    'This archive has no cldf-metadata.json, so it was read as a metadata-free dataset using ' +
      'the standard CLDF column names. Custom columns cannot be recognized this way.',
  );
  return { module: 'Generic', title: '', baseDir: '', components, entries, warnings };
}
