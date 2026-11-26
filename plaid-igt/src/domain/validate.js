// Load-time invariant checker for IGT documents.
//
// Runs when a document opens (IgtDocument.validateOnOpen, which writes nothing)
// and reports anything wrong. It is deliberately NARROW: plaid-core already
// enforces the structural invariants at write time — token extent bounds
// (begin<=end, within text), referential integrity (spans reference existing
// tokens in the right layer/doc), span non-emptiness, parent containment,
// overlap modes, vocab-link integrity — so re-checking them here would be pure
// noise. This only covers the APP-LEVEL contracts the server cannot know:
//
//   Genuinely un-healable contracts where the right repair needs a human
//   (we cannot pick it unambiguously), so we only warn. An orphan morpheme or
//   a doubled annotation cannot be stored any more: the server's layer rules
//   refuse or repair them in the write that would make one
//   (igtConstraints.js).
//
// Pure function. Returns findings [{severity, code, message, context}]; the
// caller logs the lot and surfaces one consolidated toast. Never throws.

import { conflictingPairs } from './alignmentTimes.js';
import { collectMweLinks } from './mwe.js';
import { t } from '@ui/lib/i18n.js';

const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

export function validateIgtDocument(
  layerInfo,
  alignmentTokens = [],
  { sentences = [], vocabularies = {} } = {},
) {
  const findings = [];
  const add = (severity, code, message, context = {}) =>
    findings.push({ severity, code, message, context });

  // --- Un-healable app contracts (warn, a repair needs a human) ---
  // Alignment timing must be non-inverted (timeEnd >= timeBegin). It lives in
  // opaque token metadata the server does not validate, and the repair (swap
  // the bounds vs. clear them) is ambiguous, so we only report it.
  // A multi-word expression is drawn in the sentence of its first word. One
  // whose words sit in several sentences, or on a word that no longer exists,
  // is drawn short (partial) or not at all; only a person can say what it
  // should cover now.
  try {
    const drawn = new Set();
    for (const s of sentences || []) {
      for (const m of s.mwes || []) {
        drawn.add(m.linkId);
        if (m.partial) {
          add(
            SEVERITY.WARNING,
            'mwe-partial',
            t(
              'The multi-word expression "{form}" has words outside sentence {n}, or on words that no longer exist. Only its words in that sentence are shown.',
              { form: m.item?.form ?? '', n: (sentences.indexOf(s) ?? 0) + 1 },
            ),
            { linkId: m.linkId, sentenceId: s.id, tokens: m.tokenIds },
          );
        }
      }
    }
    for (const m of collectMweLinks(vocabularies)) {
      if (drawn.has(m.linkId)) continue;
      add(
        SEVERITY.WARNING,
        'mwe-undrawn',
        t(
          'The multi-word expression "{form}" has fewer than two words in the sentence of its first word, so it is not shown. Merge the sentences back to show it.',
          { form: m.item?.form ?? '' },
        ),
        { linkId: m.linkId, tokens: m.tokenIds },
      );
    }
  } catch (err) {
    add(
      SEVERITY.ERROR,
      'mwe-check-failed',
      t('Multi-word expression check threw: {error}', { error: String(err?.message || err) }),
    );
  }

  conflictingPairs(alignmentTokens || []).forEach(([a, b]) => {
    add(
      SEVERITY.WARNING,
      'alignment-time-overlap',
      t(
        'Two segments overlap in time without different speakers ({aBegin}-{aEnd} and {bBegin}-{bEnd}). Only cross-talk between labelled speakers may overlap.',
        {
          aBegin: String(a.metadata?.timeBegin),
          aEnd: String(a.metadata?.timeEnd),
          bBegin: String(b.metadata?.timeBegin),
          bEnd: String(b.metadata?.timeEnd),
        },
      ),
      { ids: [a.id, b.id], speakers: [a.metadata?.speaker ?? null, b.metadata?.speaker ?? null] },
    );
  });

  (alignmentTokens || []).forEach((token) => {
    const tb = token.metadata?.timeBegin;
    const te = token.metadata?.timeEnd;
    if (typeof tb === 'number' && typeof te === 'number' && te < tb) {
      add(
        SEVERITY.WARNING,
        'alignment-time-inverted',
        t('An alignment has end time ({end}) before start time ({begin}).', {
          end: String(te),
          begin: String(tb),
        }),
        { id: token.id, begin: token.begin, end: token.end, timeBegin: tb, timeEnd: te },
      );
    }
  });

  return findings;
}
