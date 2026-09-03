"""Read a raw document into the shape an analysis service works on, and
classify words under the provenance write contract.

``derive`` mirrors the IGT app's ``derive.js`` for the pieces a service
needs (sentences > words > morphemes, with every span and link attached),
``word_state`` mirrors its ``isUnanalyzedWord`` + provenance voting, and
``is_token_ignored`` mirrors ``igtConfig.js``'s ignored-token rule.
"""

import unicodedata
from typing import Dict, List, Tuple

from plaid_client.provenance import prov_state, MACHINE


# --- ignored tokens (mirrors plaid-igt domain/igtConfig.js) -----------------

def _is_punct_char(c):
    cat = unicodedata.category(c)
    return cat[0] in 'PS' and not _is_pictograph(c)


def _is_pictograph(c):
    # Rough stand-in for \p{Extended_Pictographic}: emoji blocks.
    o = ord(c)
    return 0x1F000 <= o <= 0x1FAFF or 0x2600 <= o <= 0x27BF


def is_token_ignored(content, cfg):
    """Is this word excluded from annotation by the word layer's
    ``config.igt.ignoredTokens`` rule (punctuation, or an explicit list)?"""
    if not cfg:
        return False
    if cfg.get('type') == 'unicodePunctuation':
        if content and all(_is_punct_char(c) for c in content):
            return content not in (cfg.get('whitelist') or [])
        return False
    if cfg.get('type') == 'blacklist':
        return content in (cfg.get('blacklist') or [])
    return False


# --- document walking ----------------------------------------------------------

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
           gloss_field, translation_field=None, orthography=''):
    """-> (sentences, gloss_layer_id). Each sentence: {id, translation,
    words:[{token, surface, text, morphs:[token], spans:[...], links:[...],
    morph_spans:{mid:[...]}, morph_links:{mid:[...]}}]}.

    ``text`` is the word as the proposer should see it: the baseline surface,
    or the named word orthography when ``orthography`` is given. Ignored
    tokens (punctuation) are left out. Raises ValueError with a user-facing
    message when a layer or the gloss field is missing; ``gloss_field=None``
    asks for no gloss layer (the second item is then None)."""
    tl, word_layer = _find_layer(doc['text_layers'], word_layer_id)
    if not word_layer:
        raise ValueError(f'Word token layer {word_layer_id} not found in document')
    _, morph_layer = _find_layer(doc['text_layers'], morpheme_layer_id)
    if not morph_layer:
        raise ValueError(f'Morpheme token layer {morpheme_layer_id} not found in document')
    _, sent_layer = _find_layer(doc['text_layers'], sentence_layer_id)
    if not sent_layer:
        raise ValueError(f'Sentence token layer {sentence_layer_id} not found in document')
    gloss_layer = _span_layer(morph_layer, gloss_field, 'Morpheme') if gloss_field else None
    if gloss_field and not gloss_layer:
        raise ValueError(f'No morpheme-scope field named "{gloss_field}" — set the Gloss field parameter '
                         f'to one of: {", ".join(sl["name"] for sl in morph_layer.get("span_layers", [])) or "(none)"}')
    trans_layer = _span_layer(sent_layer, translation_field) if translation_field else None
    translations = {}
    if trans_layer:
        for sp in trans_layer.get('spans', []):
            for tid in sp.get('tokens') or []:
                translations[tid] = sp.get('value') or ''

    body = (tl.get('text') or {}).get('body') or ''
    text_id = (tl.get('text') or {}).get('id')
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
                'token': w, 'text_id': text_id, 'surface': surface, 'text': text, 'morphs': ms,
                'spans': word_spans.get(w['id'], []), 'links': word_links.get(w['id'], []),
                'morph_spans': {m['id']: morph_spans.get(m['id'], []) for m in ms},
                'morph_links': {m['id']: morph_links.get(m['id'], []) for m in ms},
            })
        sentences.append({'id': s['id'], 'translation': translations.get(s['id'], ''), 'words': ws})
    return sentences, (gloss_layer['id'] if gloss_layer else None)


# --- the write contract, per word ----------------------------------------------

def word_state(w):
    """'unanalyzed' | 'machine' | 'protected' | 'nomorph' (no morpheme token to
    write into — healed by the editor on open; skipped here).

    Every span, link and non-default morpheme on the word votes with its
    provenance state; a word is 'machine' only when every vote is
    machine-unverified, 'protected' as soon as one piece is human-made or
    human-verified."""
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


def select_targets(sentences, overwrite=False):
    """Which words may be written: unanalyzed and entirely machine-unverified
    ones always, protected ones only with ``overwrite``. Stamps each word's
    ``state`` and returns ``(targets, skipped)`` where targets is
    ``[(sentence, [word indices])]`` over sentences with at least one target
    and skipped counts ``{'protected', 'no_morpheme'}``."""
    skipped = {'protected': 0, 'no_morpheme': 0}
    targets = []
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
    return targets, skipped
