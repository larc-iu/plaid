// The ELAN round-trip expectation: what its loss list says an import gives back,
// as edits to the snapshots (see ./index.js).
//
// An .eaf holds no running text, no lexicon, no links and no comments, so most of
// what is lost goes by the shared strips. What this module adds is the shape
// the import rebuilds: a baseline made again from the sentence annotations,
// every offset re-derived against it, one annotation per token per field, one
// speaker per sentence, times in whole milliseconds, and a project schema read
// back from what the files hold.
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
  wordsWithMorphemes,
  surface,
  tokensIn,
} from './snap.js';
import { MEDIA_FILE_FIELD } from '../../../domain/igtConfig.js';
import { coveredBy, isIgnored } from './strips.js';

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

// An annotation over several tokens is written on each of them, and comes back as
// one single-token annotation per token, each a new row. Two annotations of one
// field never share a token (the field's single-span rule), so no token has a
// second annotation to choose between.
function splitPerToken(s) {
  for (const d of docs(s)) {
    const split = [];
    for (const sp of d.spans) {
      if (sp.tokens.length < 2) continue;
      for (const t of sp.tokens) {
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
    removeSpans(s, d, (sp) => sp.tokens.length > 1);
    d.spans.push(...split);
  }
}

const strips = {
  // A morpheme with no form has no annotation written for it, so its word comes
  // back with one morpheme fewer. A word whose morphemes are ALL empty is a
  // word with nothing written at all, which token.unanalyzedWord settles, so
  // only a morpheme with a filled sibling goes here.
  'token.morphemeFormEmpty': (s) => {
    for (const d of docs(s)) {
      const gone = new Set();
      for (const { morphemes } of wordsWithMorphemes(d)) {
        if (!morphemes.some((m) => trimmed(m.metadata.form) !== '')) continue;
        for (const m of morphemes) if (trimmed(m.metadata.form) === '') gone.add(m);
      }
      removeTokens(s, d, (t) => gone.has(t));
      // The word comes back with the morphemes it still has, numbered from the
      // start: the import knows nothing of the one that was not written.
      for (const { morphemes } of wordsWithMorphemes(d)) {
        morphemes.forEach((m, i) => {
          m.precedence = i + 1;
        });
      }
    }
  },
  'span.offTagset': coveredBy(
    'layers.fieldTagset',
    'a value is only off-tagset while a tagset governs its field',
  ),
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

  'span.multiToken': splitPerToken,
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

const RESERVED_PROPERTIES = new Set(['documentName', 'lastUsedAnnotationId', 'URN']);

const schemaSteps = [
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
  {
    keys: ['layers.orthography', 'token.orthographyValue'],
    // An orthography goes out as a tier over the words and comes back as a
    // word field: nothing in an .eaf says a tier is another spelling rather
    // than an annotation. The expected side is moved to that shape, so the
    // values themselves are still compared. The orthography tiers are written
    // before the word field tiers, so those fields come first, in order.
    apply(expected) {
      const wl = layer(expected, 'token:word');
      if (!wl) return;
      const names = (igt(wl).orthographies || []).map((o) => o.name);
      igt(wl).orthographies = [];
      for (const d of docs(expected)) {
        for (const w of tokensIn(d, 'word')) {
          for (const name of names) {
            const key = `orthog:${name}`;
            const value = trimmed(w.metadata[key]);
            delete w.metadata[key];
            if (value == null || value === '') continue;
            d.spans.push({
              key: newKey('span'),
              order: Infinity,
              layer: `span:word/${name}`,
              tokens: [w.key],
              value,
              metadata: {},
            });
          }
        }
      }
      for (const l of spanLayers(expected)) {
        if (l.key.startsWith('span:word/')) l.position += names.length;
      }
      names.forEach((name, position) => {
        if (layer(expected, `span:word/${name}`)) return;
        expected.layers.push({
          key: `span:word/${name}`,
          name,
          position,
          config: { igt: { scope: 'Word' } },
        });
      });
    },
  },
];

const documentSteps = [
  {
    keys: ['document.duplicateName'],
    // A batch is imported in the order the files are listed in, and two
    // documents of one name go out as "<name>.eaf" and "<name> (2).eaf", which
    // sort the other way round: the documents come back in that order, so which
    // of the two holds what can swap.
    apply(expected) {
      const list = docs(expected);
      const used = new Set();
      const fileOf = new Map();
      for (const d of list) {
        let candidate = `${d.name}.eaf`;
        for (let n = 2; used.has(candidate); n++) candidate = `${d.name} (${n}).eaf`;
        used.add(candidate);
        fileOf.set(d, candidate);
      }
      list.sort((a, b) => (fileOf.get(a) < fileOf.get(b) ? -1 : 1));
      expected.documents = list;
    },
  },
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
    // The fields some document holds a value in, as {name} alone, met document
    // by document in snapshot order and each document's in the project's order,
    // plus `Media file` last when a document has a recording.
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
      if (docs(expected).some((d) => d.media) && !names.includes(MEDIA_FILE_FIELD)) {
        names.push(MEDIA_FILE_FIELD);
      }
      igt(expected).documentMetadata = names.map((name) => ({ name }));
    },
  },
];

const tokenSteps = [
  {
    keys: [
      'token.unanalyzedWord',
      'token.singleStoredMorpheme',
      'token.morphemeFormAbsent',
      'token.morphemeForm',
    ],
    // A word with no stored morpheme is written with its derived one, and comes
    // back with it stored as {form}: the word's text with a leading - or = taken
    // off. Whether a word has a derived morpheme is the exported project's rule
    // to say, so an ignored word gets none. The enclitic morph type the prose
    // adds for = is not added, because token.morphTypeOnMorpheme is undecided
    // and has already taken morph types off both sides.
    //
    // Last, a word's only morpheme whose form is then the word's text, and on
    // which no field holds a value once trimmed, is no analysis: the import
    // leaves that word unanalyzed. So a word with no stored morpheme comes back
    // with one only when its text begins with - or =.
    //
    // A stored morpheme with no form comes back with its word's text as its
    // form. Then EVERY stored form comes back trimmed and with one leading -
    // or = taken off it. A form set here from the word's text goes through that
    // too, since by then it is a form like any other.
    //
    // Why every form and not only the first. The export writes the joint the
    // chain calls for in front of a non-initial morpheme, and the import takes
    // one leading joint off what it reads. Those cancel while the stored form
    // does not itself begin with a joint. When it does, the export writes no
    // joint in front of it (joinerBetween, so that a form a person typed with
    // its marker is not doubled on screen), and the import takes that very
    // character off: an .eaf morph tier cannot tell a form spelling its own
    // joint from a plain form joined to the one before it. Either way the
    // answer is the stored form less one leading joint, whatever its place in
    // the word. This read as "the first morpheme only" until `bb fidelity` ran
    // the round trip against a real core.
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
          morphemes.forEach((m) => {
            if (!('form' in m.metadata)) m.metadata.form = text;
            if (typeof m.metadata.form !== 'string') return;
            m.metadata.form = m.metadata.form.trim().replace(firstMarker, '');
          });
        }
        const valued = new Set(
          d.spans.filter((sp) => trimmed(sp.value) !== '').flatMap((sp) => sp.tokens),
        );
        const bare = new Set();
        for (const { word, morphemes } of wordsWithMorphemes(d)) {
          const [only] = morphemes;
          if (morphemes.length !== 1 || valued.has(only.key)) continue;
          if (only.metadata.form === surface(d, word)) bare.add(only);
        }
        removeTokens(expected, d, (t) => bare.has(t));
      }
    },
  },
];

const spanSteps = [
  {
    keys: ['span.sentenceValue', 'span.wordValue', 'span.morphemeValue', 'span.valueWhitespace'],
    // Every annotation value comes back trimmed, and one left empty does not
    // come back. span.multiToken among the strips split an annotation over
    // several tokens into one per token.
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
    ...schemaSteps,
    ...documentSteps,
    ...tokenSteps,
    ...spanSteps,
    ...alignmentSteps,
    rebuildStep,
  ],
};
