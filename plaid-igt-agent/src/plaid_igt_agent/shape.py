"""Plan tools that change the segmentation of the text itself: splitting,
merging, and deleting words, and splitting and merging sentences. They mirror
the editor's mutations (``mutations/tokens.js``, ``mutations/sentences.js``)
including their side effects, which the plan labels spell out: a word split
or merge deletes the affected words' morpheme analyses (a boundary change
invalidates them, and the server would otherwise cascade-split them into
nonsense), a merge combines the words' or sentences' field values losslessly
(distinct values joined with " | ") and keeps one lexicon link, and a deleted
word takes its analysis, values, and links with it while the text stays."""

from typing import Any, Dict, List, Optional

from .project import Sentence, Word, resolve, word_ref
from .tools import Workspace, ToolError, _refs, _need

SHAPE_KINDS = ('split_word', 'merge_words', 'delete_word', 'split_sentence', 'merge_sentences')


def _shaped_ids(ws: Workspace, merges_only: bool) -> set:
    """Word and sentence ids a shape op in the plan already changes."""
    out = set()
    for op in ws.ops:
        k = op.get('kind')
        if k in ('split_word', 'delete_word') and not merges_only:
            out.add(op['word_id'])
        elif k == 'merge_words':
            out.add(op['word_id'])
            out.update(op.get('other_ids') or [])
        elif k == 'split_sentence' and not merges_only:
            out.add(op['sentence_id'])
        elif k == 'merge_sentences':
            out.add(op['sentence_id'])
            out.add(op['other_id'])
    return out


def _guard(ws: Workspace, obj, ref: str, merging: bool = False) -> None:
    """A word or sentence takes part in at most one merge per plan, and a
    merge takes no word or sentence another shape op changes. A repeated
    split or delete of one item simply replaces the earlier op (last wins)."""
    if obj.id in _shaped_ids(ws, merges_only=not merging):
        raise ToolError(f'{ref} is already split, merged, or deleted in this plan; discard_plan to start over')


def _dedup_spans(units) -> List[Dict[str, Any]]:
    """After a server-side merge every unit's spans sit on the survivor, one
    per unit per layer; keep the first unit's span (else the first that has
    one), give it the distinct non-empty values joined with " | ", and delete
    the rest. The lossless heal the editor applies after its own merges."""
    layers: Dict[str, List] = {}
    for u in units:
        for sp in u.fields.values():
            layers.setdefault(sp.layer_id, []).append(sp)
    out = []
    for layer_id, spans in layers.items():
        if len(spans) < 2:
            continue
        values: List[str] = []
        for sp in spans:
            if sp.value != '' and sp.value not in values:
                values.append(sp.value)
        merged = ' | '.join(values)
        out.append({'layer_id': layer_id, 'keep_id': spans[0].id,
                    'value': merged if merged != spans[0].value else None,
                    'delete_ids': [sp.id for sp in spans[1:]]})
    return out


def _combined_values(spans: List[Dict[str, Any]], project) -> str:
    bits = []
    for sp in spans:
        if sp['value'] is not None:
            f = project.field_by_layer(sp['layer_id'])
            bits.append(f'{f.name if f else sp["layer_id"]} "{sp["value"]}"')
    return ', '.join(bits)


def _dedup_links(words: List[Word]) -> Dict[str, Any]:
    """Keep the survivor's own link, else the earliest merged word's; delete the rest."""
    links = [w.link for w in words if w.link]
    if len(links) < 2:
        return {'keep_id': links[0].id if links else None, 'delete_ids': []}
    return {'keep_id': links[0].id, 'delete_ids': [l.id for l in links[1:]]}


def t_split_word(ws: Workspace, document: str, ref: str, at) -> str:
    """PLAN: split one word into two at a character position."""
    doc = ws.doc(document)
    w = _need(resolve(doc, ref), Word, ref)
    _guard(ws, w, ref)
    if isinstance(at, str) and not at.strip().isdigit():
        left = at.strip()
        if not w.surface.startswith(left):
            raise ToolError(f'"{left}" is not the start of "{w.surface}"; give the left part, or the number of characters in it')
        n = len(left)
    else:
        try:
            n = int(at)
        except (TypeError, ValueError):
            raise ToolError('at must be the number of characters in the left part, or the left part itself')
    if not 0 < n < len(w.surface):
        raise ToolError(f'at must be between 1 and {len(w.surface) - 1} for "{w.surface}"')
    left, right = w.surface[:n], w.surface[n:]
    morphs = [m.id for m in w.morphemes]
    note = ''
    if w.morphemes and (len(w.morphemes) > 1 or w.morphemes[0].fields or w.morphemes[0].link
                        or (w.morphemes[0].metadata or {}).get('form')):
        note = f' (its {len(w.morphemes)}-morpheme analysis is deleted; re-analyse both parts afterwards)'
    if w.fields or w.link:
        note += ' (word values and link stay on the left part)'
    ws.add_op({'kind': 'split_word', 'word_id': w.id, 'position': w.begin + n, 'morpheme_ids': morphs,
               'label': f'{doc.name} {ref} "{w.surface}": split into "{left}" + "{right}"{note}'})
    return ws.planned_note(1)


def t_merge_words(ws: Workspace, document: str, refs) -> str:
    """PLAN: merge consecutive words of one sentence into one."""
    doc = ws.doc(document)
    refs = _refs(refs)
    if len(refs) < 2:
        raise ToolError('Give at least two word references in one sentence, e.g. ["s3.w2", "s3.w3"]')
    words = [_need(resolve(doc, r), Word, r) for r in refs]
    sents = {resolve(doc, r.split('.')[0]).id for r in refs}
    if len(sents) != 1:
        raise ToolError('Words to merge must be in the same sentence')
    words.sort(key=lambda w: w.begin)
    for a, b in zip(words, words[1:]):
        if b.index != a.index + 1:
            raise ToolError(f'w{a.index} and w{b.index} are not consecutive; merge only adjacent words')
        gap = doc.body[a.end:b.begin]
        if gap.strip():
            raise ToolError(f'"{gap.strip()}" lies between "{a.surface}" and "{b.surface}"; a merge would swallow it. '
                            'Respell or delete the punctuation first if the merge is really wanted.')
    for w in words:
        _guard(ws, w, word_ref(next(s for s in doc.sentences if s.id in sents), w), merging=True)
    first, last = words[0], words[-1]
    merged = doc.body[first.begin:last.end]
    spans = _dedup_spans(words)
    links = _dedup_links(words)
    morphs = [m.id for w in words for m in w.morphemes]
    analysed = sum(1 for w in words if len(w.morphemes) > 1 or any(m.fields or m.link for m in w.morphemes))
    note = ''
    if analysed:
        note += f' ({analysed} morpheme analys{"es" if analysed != 1 else "is"} deleted)'
    comb = _combined_values(spans, ws.project)
    if comb:
        note += f' (values combined: {comb})'
    if links['delete_ids']:
        note += f' (keeps the link "{[w.link.form for w in words if w.link][0]}", drops {len(links["delete_ids"])})'
    s = next(s for s in doc.sentences if s.id in sents)
    ws.add_op({'kind': 'merge_words', 'word_id': first.id, 'other_ids': [w.id for w in words[1:]],
               'morpheme_ids': morphs, 'spans': spans, 'links': links,
               'label': f'{doc.name} s{s.index}: merge ' + ' + '.join(f'w{w.index} "{w.surface}"' for w in words)
                        + f' → "{merged}"{note}'})
    return ws.planned_note(1)


def t_delete_word(ws: Workspace, document: str, refs) -> str:
    """PLAN: delete word tokens (the text stays; analysis, values, and links go)."""
    doc = ws.doc(document)
    staged: List[Dict[str, Any]] = []
    for ref in _refs(refs):
        w = _need(resolve(doc, ref), Word, ref)
        _guard(ws, w, ref)
        had = bool(w.fields or w.link or len(w.morphemes) > 1 or any(m.fields or m.link for m in w.morphemes))
        staged.append({'kind': 'delete_word', 'word_id': w.id, 'morpheme_ids': [m.id for m in w.morphemes],
                       'label': f'{doc.name} {ref} "{w.surface}": delete the word token'
                                + (' (its analysis, values, and link go; the text stays)' if had else ' (the text stays)')})
    ws.add_ops(staged)
    return ws.planned_note(len(staged))


def t_split_sentence(ws: Workspace, document: str, ref: str, before_word: int) -> str:
    """PLAN: start a new sentence at a word of an existing one."""
    doc = ws.doc(document)
    s = _need(resolve(doc, ref), Sentence, ref)
    _guard(ws, s, ref)
    try:
        n = int(before_word)
    except (TypeError, ValueError):
        raise ToolError('before_word must be a word number (the first word of the new sentence)')
    if not 2 <= n <= len(s.words):
        raise ToolError(f'before_word must be between 2 and {len(s.words)} for {ref} (a split before w1 changes nothing)')
    w = s.words[n - 1]
    left = doc.body[s.begin:w.begin].strip()
    right = doc.body[w.begin:s.end].strip()
    note = ' (sentence values such as the translation stay with the first part)' if s.fields else ''
    ws.add_op({'kind': 'split_sentence', 'sentence_id': s.id, 'position': w.begin,
               'label': f'{doc.name} {ref}: split before w{n} "{w.surface}" → "{left[:40]}" | "{right[:40]}"{note}'})
    return ws.planned_note(1)


def t_merge_sentences(ws: Workspace, document: str, ref: str) -> str:
    """PLAN: merge a sentence into the one before it."""
    doc = ws.doc(document)
    s = _need(resolve(doc, ref), Sentence, ref)
    if s.index < 2:
        raise ToolError(f'{ref} is the first sentence; name the sentence to merge into the one before it')
    prev = doc.sentences[s.index - 2]
    _guard(ws, s, ref, merging=True)
    _guard(ws, prev, f's{prev.index}', merging=True)
    spans = _dedup_spans([prev, s])
    comb = _combined_values(spans, ws.project)
    ws.add_op({'kind': 'merge_sentences', 'sentence_id': prev.id, 'other_id': s.id, 'spans': spans,
               'label': f'{doc.name}: merge s{s.index} "{s.text[:30]}" into s{prev.index} "{prev.text[:30]}"'
                        + (f' (values combined: {comb})' if comb else '')})
    return ws.planned_note(1)
