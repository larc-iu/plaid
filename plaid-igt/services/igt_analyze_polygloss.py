"""
PolyGloss analysis service

Proposes a morpheme segmentation and morpheme glosses for the words of a
document with PolyGloss (Ginn et al. 2026, https://github.com/lecs-lab/polygloss),
a ByT5 seq2seq model that jointly segments and glosses a sentence given its
transcription and free translation. Serves the `analyze` task.

What it writes, per word it is allowed to touch: the morpheme chain (the
word's existing default morpheme becomes the first slot, further slots are
created; `metadata.form` carries the segment, `metadata.morphType` the clitic
side of a `=` boundary) and one span per morpheme in the morpheme-scope gloss
field. Everything is stamped machine-made (`prov`/`provSource`/`provDetail`)
and renders as unverified in the editor until a person confirms it. The
prediction itself is kept in `provDetail` (`form` on each morpheme, `value` on
each gloss span, plus the model and the `boundaries` string on the first
morpheme) so that, after a person verifies or corrects it, what the model
originally said is still on the row. PolyGloss decodes with a small beam and
exposes no probabilities, so no `provProb` / `valueProbs` are written.

Write contract (the provenance convention):
  * unanalyzed words are always written;
  * words whose analysis is entirely machine-made and unverified are REPLACED;
  * words with any human-made or human-verified piece are skipped unless the
    `overwrite` parameter is set.

The model's output is whitespace-aligned to the input words only when it
behaves. This service does the bookkeeping and mends: it parses the
interleaved output, aligns output words to input words (fast 1:1 check, else a
monotonic edit-distance alignment allowing dropped/inserted/merged words),
degrades unparsable words to a single morpheme carrying the joined gloss, and
re-runs the untranscribed tail of a truncated generation. The unit of writing
is the word: unaligned words are simply left alone and reported.

Requirements (on top of plaid-client): torch, transformers (>=4.51), and
peft only when launching with --adapter. A GPU is assumed for whole-document
runs; CPU works but is many times slower.
"""

import argparse
import difflib
import re
import unicodedata
from typing import Any, Dict, List, Optional, Tuple

from plaid_client import BaseService, TASKS, Param, service_source
from plaid_client.provenance import stamp_inferred, prov_state, MACHINE

DEFAULT_MODEL = 'lecslab/polygloss-byt5-interleaved-2025-12-28'

# The prompt PolyGloss was trained with (src/dataset/polygloss.interleaved.t2sg.prompt).
PROMPT = (
    'Predict the glosses and morphological segmentation (in parentheses) for the following text in {lang}.\n'
    '\n'
    'Text in {lang}: {transcription}\n'
    'Translation in {metalang}: {translation}\n'
    '\n'
    'Output: '
)
BOUNDARY_RE = re.compile(r'[-=]')
MORPH_RE = re.compile(r'^(.*)\((.*)\)$')
MAX_NEW_TOKENS = 1024  # ByT5 tokens are bytes
MAX_CONTINUATIONS = 2  # extra passes over the tail of a truncated sentence
ALIGN_THRESHOLD = 0.5  # min surface similarity for an output word to count
BATCH_OP_BUDGET = 800  # server caps one atomic batch at 1000 ops

SUMMARY = """\
**PolyGloss** (Ginn et al. 2026) proposes a morpheme **segmentation** and
**glosses** for every word of the document in one pass, from the words and each
sentence's free translation. It is a single multilingual model trained on IGT
from ~2,000 languages; results are best for languages it has seen.

- **Language** / **Metalanguage**: the object language's name as the model
  would know it (e.g. `Lezgian`) and the translation's language.
- **Orthography**: leave blank to send the baseline text; name a word
  orthography (e.g. `Translit`) to send that instead.
- **Gloss field**: the morpheme-scope field that receives the glosses.
- **Overwrite human-edited annotations**: by default the service only writes
  words that have no analysis yet or whose analysis is entirely machine-made
  and unverified. Enable this to replace human-made or human-verified analyses
  too (their morphemes, morpheme glosses, and links are discarded).

Everything it writes is stamped machine-made and shows as unverified until a
person confirms it (edit, ✓, or Ctrl+Enter on the word).
"""


# --- ignored tokens (mirrors plaid-igt domain/igtConfig.js) -----------------

def _is_punct_char(c):
    cat = unicodedata.category(c)
    return cat[0] in 'PS' and not _is_pictograph(c)


def _is_pictograph(c):
    # Rough stand-in for \p{Extended_Pictographic}: emoji blocks.
    o = ord(c)
    return 0x1F000 <= o <= 0x1FAFF or 0x2600 <= o <= 0x27BF


def is_token_ignored(content, cfg):
    if not cfg:
        return False
    if cfg.get('type') == 'unicodePunctuation':
        if content and all(_is_punct_char(c) for c in content):
            return content not in (cfg.get('whitelist') or [])
        return False
    if cfg.get('type') == 'blacklist':
        return content in (cfg.get('blacklist') or [])
    return False


# --- clitic side of a "=" boundary (mirrors affixMarkers.cliticSideOfBoundary) ---

def _is_caps_gloss(g):
    return isinstance(g, str) and g != '' and g == g.upper() and g != g.lower()


def clitic_side_of_boundary(left_idx, count, left_gloss=None, right_gloss=None):
    """'left' | 'right' | None: which side of the "=" after morpheme `left_idx`
    (0-based, in a word of `count` morphemes) is the clitic. Positional rule
    first (clitics sit outside the affixes), gloss case as the tiebreak (the
    ALL-CAPS side is grammatical), enclitic as the default for a two-morpheme
    word, untyped for an undecidable interior boundary."""
    left_is_first = left_idx == 0
    right_is_last = left_idx + 1 == count - 1
    if left_is_first != right_is_last:
        return 'left' if left_is_first else 'right'
    lc, rc = _is_caps_gloss(left_gloss), _is_caps_gloss(right_gloss)
    if lc != rc:
        return 'left' if lc else 'right'
    return 'right' if (left_is_first and right_is_last) else None


CLITIC_TYPE_BY_SIDE = {'left': 'proclitic', 'right': 'enclitic'}


def clitic_types(joiners, glosses):
    """morphType per piece of a chain (None = untyped) from its '=' boundaries."""
    n = len(glosses)
    types: List[Optional[str]] = [None] * n
    for i, j in enumerate(joiners):
        if j != '=':
            continue
        side = clitic_side_of_boundary(i, n, glosses[i], glosses[i + 1])
        if side is None:
            continue
        k = i if side == 'left' else i + 1
        if types[k] is None:
            types[k] = CLITIC_TYPE_BY_SIDE[side]
    return types


# --- output parsing + alignment ----------------------------------------------

class ParsedWord:
    """One whitespace-delimited word of the model output."""

    def __init__(self, raw: str):
        self.raw = raw
        parts = BOUNDARY_RE.split(raw)
        self.joiners = BOUNDARY_RE.findall(raw)
        self.glosses: List[str] = []
        self.segments: List[str] = []
        self.malformed = False
        for p in parts:
            m = MORPH_RE.match(p)
            if m:
                self.glosses.append(m.group(1))
                self.segments.append(m.group(2))
            else:
                self.glosses.append(p)
                self.segments.append('')
                self.malformed = True
        if not any(self.segments):
            self.malformed = True

    @property
    def surface(self):
        return ''.join(self.segments)

    def merged_with(self, other: 'ParsedWord') -> 'ParsedWord':
        """The model split one input word in two: rejoin with a '-' boundary."""
        return ParsedWord(self.raw + '-' + other.raw)


def _norm(s):
    return ''.join(c for c in (s or '').casefold() if unicodedata.category(c)[0] not in 'PSZ')


def similarity(a, b):
    a, b = _norm(a), _norm(b)
    if not a and not b:
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def align_words(surfaces: List[str], outputs: List[ParsedWord]) -> List[Optional[ParsedWord]]:
    """Map each input word to an output word (or None). Fast path: same count
    and every pair similar. Otherwise a monotonic alignment (dynamic
    programming over word pairs, cost = 1 - surface similarity) that allows
    dropping an input word, dropping an output word, and merging two output
    words into one input word. Pairs below ALIGN_THRESHOLD are left unaligned."""
    n, m = len(surfaces), len(outputs)
    if n == m and all(similarity(s, o.surface) >= ALIGN_THRESHOLD for s, o in zip(surfaces, outputs)):
        return list(outputs)
    GAP_IN = 0.6  # an input word the model dropped
    GAP_OUT = 0.5  # an output word with no input (hallucinated, or punctuation)
    MERGE_PENALTY = 0.1
    MERGE_MARGIN = 0.15  # merging must beat the better single match by this much
    INF = float('inf')
    cost = [[INF] * (m + 1) for _ in range(n + 1)]
    back: List[List[Optional[Tuple[int, int, str]]]] = [[None] * (m + 1) for _ in range(n + 1)]
    cost[0][0] = 0.0
    for i in range(n + 1):
        for j in range(m + 1):
            c = cost[i][j]
            if c == INF:
                continue
            if i < n and j < m:
                v = c + (1 - similarity(surfaces[i], outputs[j].surface))
                if v < cost[i + 1][j + 1]:
                    cost[i + 1][j + 1] = v
                    back[i + 1][j + 1] = (i, j, 'match')
            if i < n and j + 1 < m:
                merged = outputs[j].surface + outputs[j + 1].surface
                sm = similarity(surfaces[i], merged)
                single = max(similarity(surfaces[i], outputs[j].surface),
                             similarity(surfaces[i], outputs[j + 1].surface))
                if sm > single + MERGE_MARGIN:
                    v = c + (1 - sm) + MERGE_PENALTY
                    if v < cost[i + 1][j + 2]:
                        cost[i + 1][j + 2] = v
                        back[i + 1][j + 2] = (i, j, 'merge')
            if i < n and c + GAP_IN < cost[i + 1][j]:
                cost[i + 1][j] = c + GAP_IN
                back[i + 1][j] = (i, j, 'skip_in')
            if j < m and c + GAP_OUT < cost[i][j + 1]:
                cost[i][j + 1] = c + GAP_OUT
                back[i][j + 1] = (i, j, 'skip_out')
    result: List[Optional[ParsedWord]] = [None] * n
    i, j = n, m
    while (i, j) != (0, 0):
        pi, pj, kind = back[i][j]
        if kind == 'match':
            o = outputs[pj]
            result[pi] = o if similarity(surfaces[pi], o.surface) >= ALIGN_THRESHOLD else None
        elif kind == 'merge':
            o = outputs[pj].merged_with(outputs[pj + 1])
            result[pi] = o if similarity(surfaces[pi], o.surface) >= ALIGN_THRESHOLD else None
        i, j = pi, pj
    return result


def analysis_for(surface: str, out: ParsedWord) -> Dict[str, Any]:
    """The analysis to write for one word. A malformed word degrades to a
    single morpheme carrying the joined gloss, so the model's gloss is still
    reviewable and a person can split by hand."""
    if out.malformed or len(out.glosses) != len(out.segments):
        gloss = ''.join(g + (out.joiners[k] if k < len(out.joiners) else '') for k, g in enumerate(out.glosses))
        return {'segments': [surface], 'glosses': [gloss], 'types': [None], 'joiners': [],
                'degraded': True, 'surface_mismatch': False}
    return {
        'segments': list(out.segments),
        'glosses': list(out.glosses),
        'types': clitic_types(out.joiners, out.glosses),
        'joiners': list(out.joiners),
        'degraded': False,
        'surface_mismatch': _norm(out.surface) != _norm(surface),
    }


# --- model -----------------------------------------------------------------

class PolyGlossModel:
    def __init__(self, model_id, adapter=None, dtype='bf16', device=None, batch_size=16, num_beams=2):
        self.model_id = model_id
        self.adapter = adapter
        self.dtype_name = dtype
        self.device = device
        self.batch_size = batch_size
        self.num_beams = num_beams
        self._model = None
        self._tok = None

    def load(self):
        if self._model is not None:
            return
        import torch
        import transformers
        dtype = {'bf16': torch.bfloat16, 'fp16': torch.float16, 'fp32': torch.float32}[self.dtype_name]
        device = self.device or ('cuda' if torch.cuda.is_available() else 'cpu')
        if device == 'cpu' and dtype is not torch.float32:
            print('CPU inference: using fp32')
            dtype = torch.float32
        print(f'Loading {self.model_id} ({self.dtype_name}) on {device}...')
        self._tok = transformers.AutoTokenizer.from_pretrained(self.model_id, use_fast=False)
        model = transformers.AutoModelForSeq2SeqLM.from_pretrained(
            self.model_id, trust_remote_code=True, dtype=dtype)
        if self.adapter:
            from peft import PeftModel
            print(f'Loading adapter {self.adapter}...')
            model = PeftModel.from_pretrained(model, self.adapter)
        self._model = model.to(device).eval()
        print('Model ready.')

    def describe(self):
        d = {'model': self.model_id}
        if self.adapter:
            d['adapter'] = self.adapter
        return d

    def predict(self, prompts: List[str], on_batch=None) -> List[Tuple[str, bool]]:
        """-> [(text, truncated)] in input order.

        Prompts are batched by length (longest first) rather than in document
        order: a batch decodes until its longest output finishes, so mixing one
        long sentence with short ones wastes most of the batch. Results are
        restored to input order."""
        import torch
        self.load()
        order = sorted(range(len(prompts)), key=lambda i: -len(prompts[i]))
        out: List[Optional[Tuple[str, bool]]] = [None] * len(prompts)
        total = (len(prompts) + self.batch_size - 1) // self.batch_size
        for b in range(0, len(order), self.batch_size):
            idxs = order[b:b + self.batch_size]
            enc = self._tok([prompts[i] for i in idxs], return_tensors='pt', padding=True).to(self._model.device)
            with torch.no_grad():
                gen = self._model.generate(**enc, max_new_tokens=MAX_NEW_TOKENS,
                                           num_beams=self.num_beams, do_sample=False)
            texts = self._tok.batch_decode(gen, skip_special_tokens=True)
            for i, row, text in zip(idxs, gen, texts):
                truncated = (row == self._tok.eos_token_id).sum().item() == 0
                out[i] = (text, truncated)
            if on_batch:
                on_batch(b // self.batch_size + 1, total)
        return out  # type: ignore[return-value]


# --- document derivation -----------------------------------------------------

def _find_layer(text_layers, token_layer_id):
    for tl in text_layers:
        for tk in tl.get('token_layers', []):
            if tk['id'] == token_layer_id:
                return tl, tk
    return None, None


def _span_layer(token_layer, name, scope=None):
    for sl in token_layer.get('span_layers', []):
        if sl['name'] != name:
            continue
        s = ((sl.get('config') or {}).get('igt') or {}).get('scope')
        if scope is None or s is None or s == scope:
            return sl
    return None


def _links_by_token(token_layer):
    out = {}
    for v in token_layer.get('vocabs') or []:
        for link in v.get('vocab_links') or []:
            for tid in link.get('tokens') or []:
                out.setdefault(tid, []).append(link)
    return out


def _spans_by_token(token_layer):
    """token id -> [(span layer id, span)] over EVERY span layer of the token layer."""
    out = {}
    for sl in token_layer.get('span_layers', []):
        for sp in sl.get('spans', []):
            for tid in sp.get('tokens') or []:
                out.setdefault(tid, []).append((sl['id'], sp))
    return out


def derive(doc, word_layer_id, morpheme_layer_id, sentence_layer_id, *,
           gloss_field, translation_field, orthography):
    """-> (sentences, gloss_layer_id). Each sentence: {id, translation,
    words:[{token, surface, text, morphs:[token], spans:[...], links:[...],
    morph_spans:{mid:[...]}, morph_links:{mid:[...]}}]}."""
    tl, word_layer = _find_layer(doc['text_layers'], word_layer_id)
    if not word_layer:
        raise ValueError(f'Word token layer {word_layer_id} not found in document')
    _, morph_layer = _find_layer(doc['text_layers'], morpheme_layer_id)
    if not morph_layer:
        raise ValueError(f'Morpheme token layer {morpheme_layer_id} not found in document')
    _, sent_layer = _find_layer(doc['text_layers'], sentence_layer_id)
    if not sent_layer:
        raise ValueError(f'Sentence token layer {sentence_layer_id} not found in document')
    gloss_layer = _span_layer(morph_layer, gloss_field, 'Morpheme')
    if not gloss_layer:
        raise ValueError(f'No morpheme-scope field named "{gloss_field}" — set the Gloss field parameter '
                         f'to one of: {", ".join(sl["name"] for sl in morph_layer.get("span_layers", [])) or "(none)"}')
    trans_layer = _span_layer(sent_layer, translation_field)
    translations = {}
    if trans_layer:
        for sp in trans_layer.get('spans', []):
            for tid in sp.get('tokens') or []:
                translations[tid] = sp.get('value') or ''

    body = (tl.get('text') or {}).get('body') or ''
    chars = list(body)
    ignored_cfg = ((word_layer.get('config') or {}).get('igt') or {}).get('ignoredTokens')
    orth_key = f'orthog:{orthography}' if orthography else None

    word_spans = _spans_by_token(word_layer)
    word_links = _links_by_token(word_layer)
    morph_spans = _spans_by_token(morph_layer)
    morph_links = _links_by_token(morph_layer)
    morphs_by_extent: Dict[Tuple[int, int], List[dict]] = {}
    for m in morph_layer.get('tokens', []):
        morphs_by_extent.setdefault((m['begin'], m['end']), []).append(m)
    for ms in morphs_by_extent.values():
        ms.sort(key=lambda m: m.get('precedence') or 1)

    words = sorted(word_layer.get('tokens', []), key=lambda t: t['begin'])
    sentences = []
    wi = 0
    for s in sorted(sent_layer.get('tokens', []), key=lambda t: t['begin']):
        while wi < len(words) and words[wi]['begin'] < s['begin']:
            wi += 1
        ws = []
        k = wi
        while k < len(words) and words[k]['begin'] < s['end']:
            w = words[k]
            k += 1
            if w['end'] > s['end']:
                continue
            surface = ''.join(chars[w['begin']:w['end']])
            if is_token_ignored(surface, ignored_cfg):
                continue
            text = surface
            if orth_key:
                text = (w.get('metadata') or {}).get(orth_key) or surface
            ms = morphs_by_extent.get((w['begin'], w['end']), [])
            ws.append({
                'token': w, 'surface': surface, 'text': text, 'morphs': ms,
                'spans': word_spans.get(w['id'], []), 'links': word_links.get(w['id'], []),
                'morph_spans': {m['id']: morph_spans.get(m['id'], []) for m in ms},
                'morph_links': {m['id']: morph_links.get(m['id'], []) for m in ms},
            })
        sentences.append({'id': s['id'], 'translation': translations.get(s['id'], ''), 'words': ws})
    return sentences, gloss_layer['id']


def word_state(w):
    """'unanalyzed' | 'machine' | 'protected' | 'nomorph' (no morpheme token to
    write into — healed by the editor on open; skipped here)."""
    ms = w['morphs']
    if not ms:
        return 'nomorph'
    votes = []
    for sp_layer, sp in w['spans']:
        votes.append(prov_state(sp.get('metadata')))
    for link in w['links']:
        votes.append(prov_state(link.get('metadata')))
    for m in ms:
        meta = m.get('metadata') or {}
        form = meta.get('form')
        nondefault = (len(ms) > 1 or meta.get('morphType') is not None
                      or (form not in (None, '') and form != w['surface']))
        if nondefault:
            votes.append(prov_state(meta))
        for _, sp in w['morph_spans'].get(m['id'], []):
            votes.append(prov_state(sp.get('metadata')))
        for link in w['morph_links'].get(m['id'], []):
            votes.append(prov_state(link.get('metadata')))
    if not votes:
        return 'unanalyzed'
    return 'machine' if all(v == MACHINE for v in votes) else 'protected'


# --- the service ---------------------------------------------------------------

class PolyGlossService(BaseService):
    def __init__(self):
        super().__init__(
            service_id='polygloss-analyzer',
            service_name='PolyGloss',
            description='Proposes morpheme segmentation and glosses for every word with the PolyGloss model',
            tasks=[TASKS.ANALYZE],
            summary=SUMMARY,
            parameters=[
                Param.string('language', 'Language', required=True, placeholder='e.g. Lezgian',
                             description="The object language's name as the model would know it."),
                Param.string('metalanguage', 'Metalanguage', default='English',
                             description="The language of the free translations."),
                Param.string('orthography', 'Orthography', default='', placeholder='baseline',
                             description='Name of a word orthography to send instead of the baseline text.'),
                Param.string('gloss_field', 'Gloss field', default='Gloss',
                             description='The morpheme-scope field that receives the glosses.'),
                Param.string('translation_field', 'Translation field', default='Translation',
                             description='The sentence-scope field holding the free translation.'),
                Param.boolean('overwrite', 'Overwrite human-edited annotations', default=False,
                              description='Also replace analyses a human made or verified.'),
            ],
        )
        self.model: Optional[PolyGlossModel] = None

    # -- CLI --
    def add_arguments(self, parser: argparse.ArgumentParser) -> None:
        parser.add_argument('--model', default=DEFAULT_MODEL, help='HF model id or local path')
        parser.add_argument('--adapter', default=None, help='PEFT/LoRA adapter directory (fine-tuned)')
        parser.add_argument('--dtype', default='bf16', choices=['bf16', 'fp16', 'fp32'])
        parser.add_argument('--device', default=None, help='cuda | cpu (default: auto)')
        parser.add_argument('--batch-size', type=int, default=16)
        parser.add_argument('--num-beams', type=int, default=2)
        parser.add_argument('--lazy', action='store_true', help='Load the model on first request, not at startup')

    def setup(self, args) -> None:
        self.model = PolyGlossModel(args.model, adapter=args.adapter, dtype=args.dtype,
                                    device=args.device, batch_size=args.batch_size,
                                    num_beams=args.num_beams)
        if not args.lazy:
            self.model.load()

    # -- request --
    def process_request(self, request_data: dict, response_helper) -> None:
        document_id = request_data.get('document_id')
        word_layer_id = request_data.get('word_token_layer_id')
        morph_layer_id = request_data.get('morpheme_token_layer_id')
        sent_layer_id = request_data.get('sentence_token_layer_id')
        for key, val in (('documentId', document_id), ('wordTokenLayerId', word_layer_id),
                         ('morphemeTokenLayerId', morph_layer_id), ('sentenceTokenLayerId', sent_layer_id)):
            if not val:
                response_helper.error(f'Missing required parameter: {key}')
                return
        language = (request_data.get('language') or '').strip()
        if not language:
            response_helper.error('Missing required option: Language')
            return
        metalanguage = (request_data.get('metalanguage') or '').strip() or 'English'
        orthography = (request_data.get('orthography') or '').strip()
        gloss_field = (request_data.get('gloss_field') or '').strip() or 'Gloss'
        translation_field = (request_data.get('translation_field') or '').strip() or 'Translation'
        overwrite = bool(request_data.get('overwrite', False))

        response_helper.progress(3, 'Fetching document...')
        doc = self.client.documents.get(document_id, include_body=True)
        try:
            sentences, gloss_layer_id = derive(
                doc, word_layer_id, morph_layer_id, sent_layer_id,
                gloss_field=gloss_field, translation_field=translation_field, orthography=orthography)
        except ValueError as e:
            response_helper.error(str(e))
            return

        # Eligible sentences: any word we may write.
        skipped = {'protected': 0, 'unaligned': 0, 'no_morpheme': 0}
        targets = []  # (sentence, [word indices we may write])
        for s in sentences:
            idxs = []
            for i, w in enumerate(s['words']):
                st = word_state(w)
                w['state'] = st
                if st == 'nomorph':
                    skipped['no_morpheme'] += 1
                elif st == 'protected' and not overwrite:
                    skipped['protected'] += 1
                else:
                    idxs.append(i)
            if idxs:
                targets.append((s, idxs))
        if not targets:
            response_helper.complete({
                'document_id': document_id, 'status': 'success', 'sentences': len(sentences),
                'sentences_sent': 0, 'words_written': 0, 'words_replaced': 0, 'skipped': skipped,
                'message': 'Nothing to analyze: every word is already analyzed by a person.' if skipped['protected']
                else 'Nothing to analyze.',
            })
            return

        # Generate, with continuation passes for truncated tails.
        stamp_detail = {**self.model.describe(), 'language': language, 'metalanguage': metalanguage}
        aligned: Dict[str, List[Optional[ParsedWord]]] = {}  # sentence id -> per input word
        pending = [(s, 0) for s, _ in targets]  # (sentence, first word index still to transcribe)
        for s, _ in targets:
            aligned[s['id']] = [None] * len(s['words'])
        passes = 0
        failed = []
        while pending and passes <= MAX_CONTINUATIONS:
            prompts = []
            for s, start in pending:
                transcription = ' '.join(w['text'] for w in s['words'][start:])
                translation = (s['translation'] or '').strip() or 'None'
                prompts.append(PROMPT.format(lang=language, metalang=metalanguage,
                                             transcription=transcription, translation=translation))
            lo, hi = (15, 80) if passes == 0 else (80, 88)

            def on_batch(done, total):
                response_helper.progress(lo + int((hi - lo) * done / total),
                                         f'Analyzing sentences ({done}/{total} batches)...')
            results = self.model.predict(prompts, on_batch=on_batch)
            next_pending = []
            for (s, start), (text, truncated) in zip(pending, results):
                outputs = [ParsedWord(w) for w in text.split()]
                surfaces = [w['text'] for w in s['words'][start:]]
                if not outputs:
                    failed.append({'sentence_id': s['id'], 'reason': 'empty output'})
                    continue
                mapping = align_words(surfaces, outputs)
                for k, out in enumerate(mapping):
                    aligned[s['id']][start + k] = out
                if truncated:
                    last = max((k for k, o in enumerate(mapping) if o is not None), default=-1)
                    tail_start = start + last + 1
                    if tail_start < len(s['words']):
                        next_pending.append((s, tail_start))
            pending = next_pending
            passes += 1

        # Plan writes.
        response_helper.progress(88, 'Writing analyses...')
        source = service_source(self.service_id)
        plans = []
        replaced = 0
        for s, idxs in targets:
            for i in idxs:
                w = s['words'][i]
                out = aligned[s['id']][i]
                if out is None:
                    skipped['unaligned'] += 1
                    continue
                plans.append({'word': w, 'analysis': analysis_for(w['text'], out), 'sentence_id': s['id']})
                if w['state'] != 'unanalyzed':
                    replaced += 1

        with self.client.operation(f'PolyGloss analysis ({len(plans)} words)'):
            with self.client.documents.locked(document_id):
                written = self._write(plans, gloss_layer_id, morph_layer_id, source, stamp_detail)

        response_helper.progress(100, 'Done')
        response_helper.complete({
            'document_id': document_id, 'status': 'success',
            'sentences': len(sentences), 'sentences_sent': len(targets),
            'words_written': written, 'words_replaced': replaced,
            'skipped': skipped, 'sentences_failed': failed,
        })

    # -- writing --
    def _write(self, plans, gloss_layer_id, morph_layer_id, source, detail):
        if not plans:
            return 0
        text_id = plans[0]['word']['token']['text']

        def ops_for(p):
            a = p['analysis']
            n = len(a['segments'])
            w = p['word']
            return (len(w['morphs']) - 1) + len(w['morph_spans'].get(w['morphs'][0]['id'], [])) \
                + 1 + (n - 1) + n

        chunks, cur, cur_ops = [], [], 0
        for p in plans:
            k = ops_for(p)
            if cur and cur_ops + k > BATCH_OP_BUDGET:
                chunks.append(cur)
                cur, cur_ops = [], 0
            cur.append(p)
            cur_ops += k
        if cur:
            chunks.append(cur)

        written = 0
        for chunk in chunks:
            # batch 1: clear replaced material, patch the first morpheme, create
            # the rest, gloss the first morpheme.
            created = []  # (op index, gloss, plan)
            idx = 0
            with self.client.batched() as b:
                for p in chunk:
                    w, a = p['word'], p['analysis']
                    m0 = w['morphs'][0]
                    base = stamp_inferred(source, detail=detail)
                    for m in w['morphs'][1:]:
                        self.client.tokens.delete(m['id'])  # cascades its spans + links
                        idx += 1
                    for sl_id, sp in w['morph_spans'].get(m0['id'], []):
                        if sl_id == gloss_layer_id:
                            self.client.spans.delete(sp['id'])
                            idx += 1
                    m0_stamp = dict(base)
                    m0_stamp['provDetail'] = {**detail, 'form': a['segments'][0],
                                              'boundaries': ''.join(a['joiners']),
                                              **({'surfaceMismatch': True} if a['surface_mismatch'] else {}),
                                              **({'degraded': True} if a['degraded'] else {})}
                    self.client.tokens.patch_metadata(m0['id'], {
                        'form': a['segments'][0], 'morphType': a['types'][0], **m0_stamp})
                    idx += 1
                    for j in range(1, len(a['segments'])):
                        meta = {'form': a['segments'][j],
                                **stamp_inferred(source, detail={**detail, 'form': a['segments'][j]})}
                        if a['types'][j]:
                            meta['morphType'] = a['types'][j]
                        self.client.tokens.create(morph_layer_id, text_id,
                                                  w['token']['begin'], w['token']['end'],
                                                  precedence=j + 1, metadata=meta)
                        created.append((idx, a['glosses'][j]))
                        idx += 1
                    if a['glosses'][0]:
                        self.client.spans.create(gloss_layer_id, [m0['id']], a['glosses'][0],
                                                 stamp_inferred(source, detail={**detail, 'value': a['glosses'][0]}))
                        idx += 1
            results = b.results
            # batch 2: glosses for the created morphemes (ids known now).
            todo = []
            for op_idx, gloss in created:
                if not gloss:
                    continue
                r = results[op_idx] if op_idx < len(results) else None
                mid = (r or {}).get('body', {}).get('id') if isinstance(r, dict) else None
                if mid:
                    todo.append((mid, gloss))
            if todo:
                with self.client.batched():
                    for mid, gloss in todo:
                        self.client.spans.create(gloss_layer_id, [mid], gloss,
                                                 stamp_inferred(source, detail={**detail, 'value': gloss}))
            written += len(chunk)
        return written


def main():
    PolyGlossService().run()


if __name__ == '__main__':
    main()
