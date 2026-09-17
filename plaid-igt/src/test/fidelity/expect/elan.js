// The ELAN round-trip expectation: what its loss list says an import gives back,
// as edits to the snapshots (see ./index.js).
//
// An .eaf holds no running text, no lexicon, no links and no comments, so most of
// what is lost goes by the shared strips. What this module adds is the shape
// the import rebuilds: a baseline made again from the sentence annotations,
// every offset re-derived against it, one annotation per token per field, one
// speaker per sentence, times in whole milliseconds, a derived morpheme stored
// for every unanalyzed word, and a project schema read back from what the files
// hold.
//
// Every step reads the documents the snapshot holds rather than assuming how
// many there are. The runner compares a whole-project import when the ELAN
// import accepts the project's export, and each document on its own when it
// refuses it, and both have to come out right.
//
// Where the list's prose leaves a choice open, the comment on the step says
// which reading is taken and why.

import {
  baselineOf,
  byBegin,
  cps,
  docs,
  igt,
  layer,
  newKey,
  removeSpans,
  removeTokens,
  spanLayers,
  surface,
  tokensIn,
} from './snap.js';
import { byOrder, coveredBy, isIgnored } from './strips.js';

// ---- reading a snapshot ------------------------------------------------------------

/** Wholly inside a sentence token, which covers its text and the line break after it. */
const inside = (t, sentence) => sentence.begin <= t.begin && t.end <= sentence.end;

const segmentsIn = (d, sentence) =>
  tokensIn(d, 'time-alignment').filter((a) => inside(a, sentence));

const hasTimes = (a) => {
  const { timeBegin, timeEnd } = a.metadata;
  return Number.isFinite(timeBegin) && Number.isFinite(timeEnd) && timeEnd >= timeBegin;
};

const toMs = (t) => Math.round(t * 1000);

/** A speaker as a tier PARTICIPANT names it: trimmed, and blank is none. */
const speakerOf = (a) => {
  const sp = a.metadata.speaker;
  return typeof sp === 'string' && sp.trim() !== '' ? sp.trim() : null;
};

/** The one speaker the segments name, or null when they name none or two. */
function sentenceSpeaker(segments) {
  const named = new Set(segments.map(speakerOf).filter((sp) => sp != null));
  return named.size === 1 ? [...named][0] : null;
}

/** A segment's times as the file writes them, which is how it is known on both sides. */
const timeKey = (a) => `${toMs(a.metadata.timeBegin)}|${toMs(a.metadata.timeEnd)}`;

const sourceDoc = (ctx, d) => docs(ctx.source).find((x) => x.key === d.key) ?? d;

// ---- strips the shared ones do not describe for ELAN ----------------------------------

// Each token is written with the first annotation of a field covering it, first
// in the order the server lists them (the snapshot's `order`), and what is
// written comes back as one single-token annotation per token. A multi-token
// annotation is kept on each token it is first on, as a new row, and goes from
// the rest.
function firstAnnotationPerToken(s) {
  for (const d of docs(s)) {
    const byLayer = new Map();
    for (const sp of d.spans) {
      if (!byLayer.has(sp.layer)) byLayer.set(sp.layer, []);
      byLayer.get(sp.layer).push(sp);
    }
    const gone = new Set();
    const split = [];
    for (const spans of byLayer.values()) {
      const first = new Map();
      for (const sp of [...spans].sort(byOrder)) {
        for (const t of sp.tokens) if (!first.has(t)) first.set(t, sp);
      }
      for (const sp of spans) {
        const mine = sp.tokens.filter((t) => first.get(t) === sp);
        if (sp.tokens.length === 1 && mine.length === 1) continue;
        gone.add(sp.key);
        for (const t of mine) {
          split.push({
            key: newKey('span'),
            order: sp.order,
            layer: sp.layer,
            tokens: [t],
            value: sp.value,
            metadata: structuredClone(sp.metadata),
          });
        }
      }
    }
    removeSpans(s, d, (sp) => gone.has(sp.key));
    d.spans.push(...split);
  }
}

const strips = {
  // The orphan morpheme goes, but an annotation reaching it from a real morpheme
  // stays on that morpheme (span.reachesOrphanToken), so the orphan is taken off
  // such an annotation first and span.multiToken decides what is written of the
  // rest. The shared strip would take the whole annotation with the orphan.
  'token.orphanMorpheme': (s) => {
    for (const d of docs(s)) {
      const words = new Set(tokensIn(d, 'word').map((w) => `${w.begin}-${w.end}`));
      const orphans = new Set(
        tokensIn(d, 'morpheme')
          .filter((m) => !words.has(`${m.begin}-${m.end}`))
          .map((m) => m.key),
      );
      for (const sp of d.spans) {
        if (sp.tokens.some((k) => orphans.has(k)) && sp.tokens.some((k) => !orphans.has(k))) {
          sp.tokens = sp.tokens.filter((k) => !orphans.has(k));
        }
      }
      removeTokens(s, d, (t) => orphans.has(t.key));
    }
  },
  'token.procliticBeforeMorpheme': coveredBy(
    'token.morphTypeOnMorpheme',
    'a proclitic is a morph type, and token.morphTypeOnMorpheme takes every morph type off both sides',
  ),

  // Undecided between the sentence's one speaker (alignment.speaker) and each
  // segment keeping its own, so the speaker of every segment in a sentence the
  // source had mixed is taken off both sides. The imported side's sentences are
  // not the source's, so those segments are found by their times, which the file
  // keeps to the millisecond. A segment with no times to find it by is not
  // written at all (alignment.times), but it still makes its sentence mixed. The
  // shared entry's cover, alignment.times, removes nothing in ELAN.
  'alignment.mixedSpeakersInSentence': (s, ctx) => {
    const mixed = new Set();
    for (const d of docs(ctx.source)) {
      for (const sentence of tokensIn(d, 'sentence')) {
        const segs = segmentsIn(d, sentence);
        if (segs.length < 2 || new Set(segs.map(speakerOf)).size < 2) continue;
        for (const a of segs.filter(hasTimes)) mixed.add(timeKey(a));
      }
    }
    for (const d of docs(s)) {
      for (const a of tokensIn(d, 'time-alignment')) {
        if (hasTimes(a) && mixed.has(timeKey(a))) delete a.metadata.speaker;
      }
    }
  },

  'span.multiToken': firstAnnotationPerToken,
  'span.overlapSameField': firstAnnotationPerToken,
  'span.reachesOrphanToken': coveredBy(
    'token.orphanMorpheme',
    'the orphan is taken off the annotation, and span.multiToken writes what is left',
  ),
  // The value stays as it is. What made it several tags is the tagset, which
  // project.tagsetDelimiters takes away.
  'span.delimitedValue': coveredBy(
    'project.tagsetDelimiters',
    'the value is kept, and the tagset that split it is not written',
  ),
};

// ---- steps ------------------------------------------------------------------------------

/** A value trimmed as the import trims it. Each caller drops one that is left empty. */
const trimmed = (v) => (typeof v === 'string' ? v.trim() : v);

// Only a closed tagset with no delimiters becomes a controlled vocabulary.
const isWritten = (t) => t?.mode === 'closed' && !t.delimiters;

const RESERVED_PROPERTIES = new Set(['documentName', 'lastUsedAnnotationId', 'URN']);

const tagsetSteps = [
  {
    keys: ['project.tagset'],
    // Every tagset left is closed with no delimiters (the mode and delimiter
    // strips took the others), and any other one is not written either. What
    // comes back is the name, closed mode, and each value as {value} or {value,
    // description}. "No delimiters" is read as `delimiters: ''`, the shape
    // src/domain/tagsets.js documents for a whole-cell tagset and the settings
    // screen stores. "No ordered flag" is read as the key being absent.
    apply(expected) {
      const tagsets = expected.config?.igt?.tagsets;
      if (!tagsets) return;
      for (const [name, t] of Object.entries(tagsets)) {
        if (!isWritten(t)) {
          delete tagsets[name];
          continue;
        }
        tagsets[name] = {
          delimiters: '',
          mode: 'closed',
          values: (t.values || []).map((v) =>
            v.description ? { value: v.value, description: v.description } : { value: v.value },
          ),
        };
      }
      if (!Object.keys(tagsets).length) delete expected.config.igt.tagsets;
    },
  },
  {
    keys: ['layers.fieldTagset', 'span.offTagset'],
    // A field keeps its tagset when the tagset is written, and loses it
    // otherwise. An off-tagset value comes back as it was in either case, so
    // span.offTagset changes no value here.
    apply(expected) {
      const tagsets = expected.config?.igt?.tagsets || {};
      for (const l of spanLayers(expected)) {
        const name = l.config?.igt?.tagset;
        if (name != null && !tagsets[name]) delete l.config.igt.tagset;
      }
    },
  },
  {
    keys: ['layers.ignoredTokensPunctuation'],
    // The setup wizard's default rule, whatever the project had. The letter-like
    // and blacklist strips have already taken out what the rule held.
    apply(expected) {
      const wl = layer(expected, 'token:word');
      if (!wl) return;
      wl.config ??= {};
      wl.config.igt ??= {};
      wl.config.igt.ignoredTokens = { type: 'unicodePunctuation', whitelist: [] };
    },
  },
];

const documentSteps = [
  {
    keys: ['document.metadataConfigured', 'document.metadataLang'],
    // A switched-on value, a writing-system-tagged name among them, comes back
    // trimmed under its own name, and one left empty does not come back. The
    // reserved EAF property names do not come back, and documentName renames the
    // document instead.
    apply(expected) {
      const on = (expected.config?.igt?.documentMetadata || []).map((f) => f.name);
      for (const d of docs(expected)) {
        for (const name of on) {
          if (!(name in d.metadata)) continue;
          const value = trimmed(d.metadata[name]);
          if (name === 'documentName' && typeof value === 'string' && value !== '') {
            d.name = value;
          }
          if (value === '' || RESERVED_PROPERTIES.has(name)) delete d.metadata[name];
          else d.metadata[name] = value;
        }
      }
    },
  },
  {
    keys: ['project.documentMetadataFields'],
    // The fields some document holds a value in, as {name} alone, plus `Media
    // file` when a document has a recording. The comparison treats this list as
    // a set, so the order here (documents in snapshot order, fields in the
    // project's order, `Media file` last) is not checked.
    apply(expected) {
      const on = (expected.config?.igt?.documentMetadata || []).map((f) => f.name);
      const names = [];
      for (const d of docs(expected)) {
        for (const name of on) {
          if (RESERVED_PROPERTIES.has(name) || names.includes(name)) continue;
          const v = d.metadata[name];
          if (v != null && v !== '') names.push(name);
        }
      }
      if (docs(expected).some((d) => d.media) && !names.includes('Media file')) {
        names.push('Media file');
      }
      igt(expected).documentMetadata = names.map((name) => ({ name }));
    },
  },
  {
    keys: ['document.duplicateName'],
    // `<name> (n)` for every document sharing its name. The list numbers them in
    // the order the .eaf files are read, which a snapshot does not hold, so they
    // are numbered in snapshot order, the order the server lists the documents.
    apply(expected) {
      const groups = new Map();
      for (const d of docs(expected)) {
        if (!groups.has(d.name)) groups.set(d.name, []);
        groups.get(d.name).push(d);
      }
      for (const [name, group] of groups) {
        if (group.length < 2) continue;
        group.forEach((d, i) => {
          d.name = `${name} (${i + 1})`;
        });
      }
    },
  },
];

const tokenSteps = [
  {
    keys: ['token.unanalyzedWord', 'token.morphemeFormAbsent', 'token.morphemeForm'],
    // A word with no stored morpheme is written with its derived one, and comes
    // back with it stored as {form}: the word's text with a leading - or = taken
    // off. Whether a word has a derived morpheme is the exported project's rule
    // to say, so an ignored word gets none. The enclitic morph type the prose
    // adds for = is not added, because token.morphTypeOnMorpheme is undecided
    // and has already taken morph types off both sides.
    //
    // A stored morpheme with no form comes back with its word's text as its
    // form. Then every stored form comes back trimmed, and the first morpheme of
    // a word loses a leading - or =. A form set here from the word's text goes
    // through that too, since by then it is a form like any other.
    apply(expected, actual, ctx) {
      const firstMarker = /^[-=]/;
      for (const d of docs(expected)) {
        const stored = new Map();
        for (const m of tokensIn(d, 'morpheme')) {
          const k = `${m.begin}-${m.end}`;
          if (!stored.has(k)) stored.set(k, []);
          stored.get(k).push(m);
        }
        for (const w of tokensIn(d, 'word')) {
          const text = surface(d, w);
          const morphemes = stored.get(`${w.begin}-${w.end}`);
          if (!morphemes) {
            if (isIgnored(ctx.source, text)) continue;
            d.tokens.push({
              key: newKey('morpheme'),
              layer: 'token:morpheme',
              begin: w.begin,
              end: w.end,
              precedence: 1,
              metadata: { form: text.trim().replace(firstMarker, '') },
            });
            continue;
          }
          morphemes.sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0));
          morphemes.forEach((m, i) => {
            if (!('form' in m.metadata)) m.metadata.form = text;
            if (typeof m.metadata.form !== 'string') return;
            m.metadata.form = m.metadata.form.trim();
            if (i === 0) m.metadata.form = m.metadata.form.replace(firstMarker, '');
          });
        }
      }
    },
  },
  {
    keys: ['token.orthographyValue'],
    // Trimmed, and gone when nothing is left: the list's header note says an
    // orthography value goes through the same normalization as an annotation.
    apply(expected) {
      for (const d of docs(expected)) {
        for (const w of tokensIn(d, 'word')) {
          for (const k of Object.keys(w.metadata)) {
            if (!k.startsWith('orthog:')) continue;
            const v = trimmed(w.metadata[k]);
            if (v === '') delete w.metadata[k];
            else w.metadata[k] = v;
          }
        }
      }
    },
  },
];

const spanSteps = [
  {
    keys: ['span.sentenceValue', 'span.wordValue', 'span.morphemeValue', 'span.valueWhitespace'],
    // Every annotation value comes back trimmed, and one left empty does not
    // come back. Which annotation on a token is written at all was settled by
    // span.multiToken and span.overlapSameField among the strips.
    apply(expected) {
      for (const d of docs(expected)) {
        for (const sp of d.spans) sp.value = trimmed(sp.value);
        removeSpans(expected, d, (sp) => sp.value === '');
      }
    },
  },
];

const alignmentSteps = [
  {
    keys: ['alignment.speaker'],
    // Every segment in a sentence comes back with the one speaker the segments
    // inside it name, trimmed, or with none when they name none or two. It runs
    // before alignment.times drops the segments that are not written, since
    // those still name a speaker for their sentence.
    apply(expected) {
      for (const d of docs(expected)) {
        for (const sentence of tokensIn(d, 'sentence')) {
          const segs = segmentsIn(d, sentence);
          const speaker = sentenceSpeaker(segs);
          for (const a of segs) {
            if (speaker == null) delete a.metadata.speaker;
            else a.metadata.speaker = speaker;
          }
        }
      }
    },
  },
  {
    keys: ['alignment.times'],
    // A segment is written when it lies wholly inside one sentence with a
    // finite end no earlier than its beginning, its times rounded to the
    // millisecond. A sentence's time is the span of the segments written inside
    // it, and a sentence whose time overlaps an earlier timed sentence filed
    // under the same speaker loses its time and its segments. The speaker a
    // sentence is filed under is read from the source, since the mixed-speaker
    // strip has taken some speakers off this side, and having no speaker is a
    // filing of its own. Segments crossing a sentence boundary are already gone
    // (alignment.straddlesSentences).
    apply(expected, actual, ctx) {
      for (const d of docs(expected)) {
        const src = sourceDoc(ctx, d);
        const drop = new Set(tokensIn(d, 'time-alignment').map((a) => a.key));
        const timed = new Map();
        for (const sentence of tokensIn(d, 'sentence').sort(byBegin)) {
          const segs = segmentsIn(d, sentence).filter(hasTimes);
          if (!segs.length) continue;
          const filing = sentenceSpeaker(segmentsIn(src, sentence)) ?? '';
          const begin = toMs(Math.min(...segs.map((a) => a.metadata.timeBegin)));
          const end = toMs(Math.max(...segs.map((a) => a.metadata.timeEnd)));
          const earlier = timed.get(filing) ?? [];
          if (earlier.some(([b, e]) => begin < e && b < end)) continue;
          earlier.push([begin, end]);
          timed.set(filing, earlier);
          for (const a of segs) {
            drop.delete(a.key);
            a.metadata.timeBegin = toMs(a.metadata.timeBegin) / 1000;
            a.metadata.timeEnd = toMs(a.metadata.timeEnd) / 1000;
          }
        }
        removeTokens(expected, d, (t) => drop.has(t.key));
      }
    },
  },
];

// The baseline rebuilt from the sentences, last, so that everything above works
// in the source's offsets and every token, the ones added above included, is
// moved once.
const rebuildStep = {
  keys: [
    'token.sentence',
    'token.word',
    'token.untokenizedText',
    'text.multiline',
    'text.markupChars',
    'alignment.notSentenceExtent',
    'alignment.textAcrossLineBreak',
  ],
  // Each sentence's text is trimmed and every run of whitespace in it becomes
  // one space, the texts are joined by one newline, and each sentence token runs
  // from its text to the next one's, the last to the end. A sentence with no text
  // left goes with everything inside it. Every other token keeps the same
  // characters: it runs from the first to the last character of its own that is
  // not whitespace, wherever the rebuilt text put them, so a segment that took
  // in its sentence's line break no longer does, and one over a line break spans
  // the space that took its place. A token with no such character in any
  // sentence has nothing written, and goes. A document with no sentences is left
  // as it is, since the prose says nothing of one.
  apply(expected) {
    for (const d of docs(expected)) {
      const text = baselineOf(d);
      const sentences = tokensIn(d, 'sentence').sort(byBegin);
      if (!text || !sentences.length) continue;
      const chars = cps(text.body);
      const at = new Map();
      const parts = [];
      const kept = [];
      const empty = [];
      let start = 0;
      for (const sentence of sentences) {
        const out = [];
        const local = [];
        let space = false;
        for (let i = sentence.begin; i < sentence.end && i < chars.length; i++) {
          if (/\s/u.test(chars[i])) {
            space = out.length > 0;
            continue;
          }
          if (space) out.push(' ');
          space = false;
          local.push([i, out.length]);
          out.push(chars[i]);
        }
        if (!out.length) {
          empty.push(sentence);
          continue;
        }
        for (const [i, j] of local) at.set(i, start + j);
        kept.push([sentence, start]);
        parts.push(out.join(''));
        start += out.length + 1;
      }
      for (const sentence of empty) {
        removeTokens(
          expected,
          d,
          (t) => t === sentence || (t.layer !== 'token:sentence' && inside(t, sentence)),
        );
      }
      const body = parts.join('\n');
      const length = cps(body).length;
      const gone = new Set();
      const sentenceTokens = new Set(kept.map(([sentence]) => sentence));
      for (const t of d.tokens) {
        if (sentenceTokens.has(t)) continue;
        let first = null;
        let last = null;
        for (let i = t.begin; i < t.end; i++) {
          if (!at.has(i)) continue;
          if (first == null) first = at.get(i);
          last = at.get(i);
        }
        if (first == null) {
          gone.add(t.key);
          continue;
        }
        t.begin = first;
        t.end = last + 1;
      }
      kept.forEach(([sentence, begin], i) => {
        sentence.begin = begin;
        sentence.end = i + 1 < kept.length ? kept[i + 1][1] : length;
      });
      text.body = body;
      removeTokens(expected, d, (t) => gone.has(t.key));
    }
  },
};

export default {
  id: 'elan',
  strips,
  steps: [
    ...tagsetSteps,
    ...documentSteps,
    ...tokenSteps,
    ...spanSteps,
    ...alignmentSteps,
    rebuildStep,
  ],
};
