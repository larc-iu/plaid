"""Plan tools that change the segmentation of the text itself: splitting,
merging, and deleting words, and splitting and merging sentences. They mirror
the editor's mutations (``mutations/tokens.js``, ``mutations/sentences.js``)
including their side effects, which the plan labels spell out: a word split
or merge deletes the affected words' morpheme analyses (a boundary change
invalidates them, and the server would otherwise cascade-split them into
nonsense), a merge combines the words' or sentences' field values losslessly
(distinct values joined with " | ") and keeps one lexicon link, and a deleted
word takes its analysis, values, and links with it while the text stays. The
merge's combining is the server's: the layer rules igt declares (one span per
token per field, one link per word) make it join the values and drop the
extra links in the merge's own transaction, so the plan writes only the merge
and the card says what it will combine."""

from typing import Any, Dict, List, Optional

from plaid_client.constraints import value_set_allows

from ..core.bidi import qv
from ..core.args import whole
from ..core.loss import count_delete_loss, loss_note, other_layers_crossing
from ..core.tools import ToolError
from .plan import reshaped_subjects
from .project import Sentence, Word, project_new_words, resolve, split_sentences, word_ref
from .tools import (reshape_guards, refuse_comment_and_text_edit, refuse_shape_and_analysis)
from .workspace import Workspace, _need, _refs


def refuse_rule_on_merged(ws: Workspace, op) -> None:
    """A merge of what a planned rule changes a value on (`bulk`)."""
    from .bulk import refuse_rule_on_merged as refuse
    refuse(ws, op)


def _guard(ws: Workspace, obj, ref: str, merging: bool = False, word_ids=None) -> None:
    """A word or sentence takes part in at most one merge per plan, and a
    merge takes no word or sentence another shape op changes. A repeated
    split or delete of one item simply replaces the earlier op (last wins).

    A word whose analysis this plan rewrites is not reshaped either, whichever
    came first: see :func:`refuse_shape_and_analysis`.
    """
    if obj.id in reshaped_subjects(ws.ops, merges_only=not merging):
        raise ToolError(f'{ref} is already split, merged, or deleted in this plan; discard_plan to start over')
    refuse_shape_and_analysis(ws, word_ids if word_ids is not None else obj.id, ref, analysing=False)


def _joined_spans(units, project) -> List[Dict[str, Any]]:
    """What the server's merge does to the units' field values, for the card:
    every unit's spans sit on the survivor after a merge, and the layer rule
    each field declares (one span per token) makes the server keep the
    survivor's own span (else the one with the smallest id), give it the
    distinct values that are not blank (JavaScript's trim, as the server
    reads it) joined with " | " in text order, and delete the rest, in the
    merge's own transaction. A value-set rule stored on the layer that refuses
    the joined value leaves the kept value as it is (core's
    ``remedy-single-span!``, plaid-igt's ``applyMergeRules``).

    Nothing here is written by the plan: it is what the card says the merge
    combines and what the plan's guards count as gone."""
    layers: Dict[str, List] = {}
    for u in units:
        for sp in u.fields.values():
            layers.setdefault(sp.layer_id, []).append(sp)
    own = {sp.id for sp in units[0].fields.values()} if units else set()
    out = []
    for layer_id, spans in layers.items():
        if len(spans) < 2:
            continue
        keep = next((sp for sp in spans if sp.id in own), None) or min(spans, key=lambda sp: sp.id)
        joined = keep.value
        if keep.value is None or isinstance(keep.value, str):
            values: List[str] = []
            for sp in [keep] + [sp for sp in spans if sp is not keep]:
                if isinstance(sp.value, str) and not _blank(sp.value) and sp.value not in values:
                    values.append(sp.value)
            if values:
                joined = ' | '.join(values)
        f = project.field_by_layer(layer_id) if project is not None else None
        refused = any(not value_set_allows(c, joined) for c in (f.value_sets if f else ()))
        out.append({'layer_id': layer_id, 'keep_id': keep.id,
                    'value': joined if joined != keep.value and not refused else None,
                    'delete_ids': [sp.id for sp in spans if sp is not keep]})
    return out


def _other_layers(ws: Workspace, doc) -> Dict[str, Any]:
    """The whole document, every app's layers, for what a reshape takes from
    the layers this assistant does not read (``core/loss.py``)."""
    return ws.client.documents.get(doc.id, include_body=True)


def _own_layers(ws: Workspace) -> tuple:
    """The layers this assistant counts on a card itself."""
    p = ws.project
    return tuple(i for i in (p.sentence_layer_id, p.word_layer_id, p.morpheme_layer_id) if i)


def _blank(value: str) -> bool:
    """Blank as the server reads a value: nothing a value-set would check is
    left (JavaScript's trim, which is what the server and the apps use)."""
    return value_set_allows({'values': []}, value)


def _combined_values(spans: List[Dict[str, Any]], project) -> str:
    bits = []
    for sp in spans:
        if sp['value'] is not None:
            f = project.field_by_layer(sp['layer_id'])
            bits.append(f'{f.name if f else sp["layer_id"]} "{sp["value"]}"')
    return ', '.join(bits)


def _kept_link(words: List[Word]) -> Dict[str, Any]:
    """Which lexicon link the server's merge keeps, for the card: the
    survivor's own, else the one with the smallest id. The others are deleted
    by the layer rule the word layer declares (one link per word), in the
    merge's own transaction."""
    links = [w.link for w in words if w.link]
    if len(links) < 2:
        return {'keep_id': links[0].id if links else None, 'delete_ids': []}
    keep = words[0].link or min(links, key=lambda l: l.id)
    return {'keep_id': keep.id, 'delete_ids': [l.id for l in links if l is not keep]}


def _collapsed_mwes(words: List[Word]) -> list:
    """Multi-word expressions made of nothing but the merged words: after the
    merge they would sit on one token, which is no expression; the server
    would keep a phrase link on a single word, so the plan removes them. One
    reaching outside the merged words keeps its other members and stays."""
    ids = {w.id for w in words}
    out, seen = [], set()
    for w in words:
        for l in w.mwes:
            if l.id not in seen and set(l.tokens) <= ids:
                seen.add(l.id)
                out.append(l)
    return out


def t_split_word(ws: Workspace, document: str, ref: str, at) -> str:
    """PLAN: split one word into two at a character position."""
    doc = ws.doc(document)
    reshape_guards(ws, doc)
    w = _need(resolve(doc, ref), Word, ref)
    _guard(ws, w, ref)
    # `at` is either a count or the left part itself, so the number is read
    # first and the text is what is left when it is not one. `whole` and not
    # `int`: `isdigit` is true of "²", and `int(2.7)` used to cut a word
    # after two characters for an argument that named no position at all.
    try:
        n = whole(at, 'at')
    except ValueError:
        left = at.strip() if isinstance(at, str) else ''
        if not left:
            raise ToolError('at must be the number of characters in the left part (a whole number), '
                            'or the left part itself') from None
        if not w.surface.startswith(left):
            raise ToolError(f'"{left}" is not the start of "{w.surface}"; give the left part, or the number of characters in it') from None
        n = len(left)
    if not 0 < n < len(w.surface):
        raise ToolError(f'at must be between 1 and {len(w.surface) - 1} for "{w.surface}"')
    left, right = w.surface[:n], w.surface[n:]
    morphs = [m.id for m in w.morphemes]
    note = ''
    if w.morphemes and (len(w.morphemes) > 1 or w.morphemes[0].fields or w.morphemes[0].link
                        or (w.morphemes[0].metadata or {}).get('form')):
        note = f' (its {len(w.morphemes)}-morpheme analysis is deleted)'
    if w.fields or w.link:
        note += ' (word values and link go to the left part)'
    # The word's extent as read: the cut moves with the word when an edit
    # before its sentence has moved it (core.fingerprint, `token_at`).
    ws.add_op({'kind': 'split_word', 'word_id': w.id, 'position': w.begin + n,
               'token_at': {'begin': w.begin, 'end': w.end}, 'morpheme_ids': morphs,
               'label': f'{ws.doc_label(doc.id)} {ref} {qv(w.surface)}: split into {qv(left)} + {qv(right)}{note}'})
    return ws.planned_note(1)


def t_merge_words(ws: Workspace, document: str, refs) -> str:
    """PLAN: merge consecutive words of one sentence into one."""
    doc = ws.doc(document)
    reshape_guards(ws, doc)
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
    spans = _joined_spans(words, ws.project)
    links = _kept_link(words)
    morphs = [m.id for w in words for m in w.morphemes]
    analysed = sum(1 for w in words if len(w.morphemes) > 1 or any(m.fields or m.link for m in w.morphemes))
    note = ''
    if analysed:
        note += f' ({analysed} morpheme analys{"es" if analysed != 1 else "is"} deleted)'
    comb = _combined_values(spans, ws.project)
    if comb:
        note += f' (values combined: {comb})'
    if links['delete_ids']:
        kept = next(w.link.form for w in words if w.link and w.link.id == links['keep_id'])
        note += f' (keeps the link "{kept}", drops {len(links["delete_ids"])})'
    collapsed = _collapsed_mwes(words)
    if collapsed:
        note += ' (the multi-word expression ' + ', '.join(f'"{l.form}"' for l in collapsed) \
            + ' is dropped: its words become one)'
    # A layer that keeps its tokens coextensive with the words loses the
    # merged words' tokens, and what is on them, in the merge's own
    # transaction.
    note += loss_note(**count_delete_loss(_other_layers(ws, doc), [w.id for w in words], under=True,
                                          skip=_own_layers(ws)))
    s = next(s for s in doc.sentences if s.id in sents)
    op = {'kind': 'merge_words', 'word_id': first.id, 'other_ids': [w.id for w in words[1:]],
          'morpheme_ids': morphs, 'spans': spans, 'links': links,
          'mwe_ids': [l.id for l in collapsed],
          'label': f'{ws.doc_label(doc.id)} s{s.index}: merge ' + ' + '.join(f'w{w.index} {qv(w.surface)}' for w in words)
                   + f' → {qv(merged)}{note}'}
    refuse_rule_on_merged(ws, op)
    ws.add_op(op)
    return ws.planned_note(1)


def t_delete_word(ws: Workspace, document: str, refs) -> str:
    """PLAN: delete word tokens (the text stays. Analysis, values, and links go)."""
    doc = ws.doc(document)
    reshape_guards(ws, doc)
    staged: List[Dict[str, Any]] = []
    words = [(ref, _need(resolve(doc, ref), Word, ref)) for ref in _refs(refs)]
    going = {w.id for _, w in words}
    gone_mwes = set()
    full = _other_layers(ws, doc) if words else None
    deleted: List[Word] = []
    before = {'annotations': 0, 'links': 0}
    for ref, w in words:
        _guard(ws, w, ref)
        had = bool(w.fields or w.link or len(w.morphemes) > 1 or any(m.fields or m.link for m in w.morphemes))
        # The server trims a multi-word expression to its remaining members;
        # one member left is no expression, so the plan removes it outright.
        dropped = []
        for l in w.mwes:
            if l.id in gone_mwes:
                continue
            if len([t for t in l.tokens if t not in going]) < 2:
                gone_mwes.add(l.id)
                dropped.append(l)
        note = ' (its analysis, values, and link are deleted, the text is unchanged)' if had else ' (the text is unchanged)'
        if dropped:
            note += ' (the multi-word expression ' + ', '.join(f'"{l.form}"' for l in dropped) + ' goes with it)'
        elif w.mwes:
            note += ' (the multi-word expression ' + ', '.join(f'"{l.form}"' for l in w.mwes) + ' is left with its other words)'
        # Everything nested under the word on the layers this assistant does
        # not read goes with it, as core cascades the delete. Each row counts
        # what this word adds to the rows before it, so a relation between
        # two deleted words is counted once.
        upto = count_delete_loss(full, [x.id for x in deleted + [w]], skip=_own_layers(ws))
        note += loss_note(upto['annotations'] - before['annotations'], upto['links'] - before['links'])
        deleted.append(w)
        before = upto
        staged.append({'kind': 'delete_word', 'word_id': w.id, 'morpheme_ids': [m.id for m in w.morphemes],
                       'link_ids': [l.id for l in dropped],
                       'label': f'{ws.doc_label(doc.id)} {ref} {qv(w.surface)}: delete the word token{note}'})
    ws.add_ops(staged)
    return ws.planned_note(len(staged))


def t_split_sentence(ws: Workspace, document: str, ref: str, before_word: int) -> str:
    """PLAN: start a new sentence at a word of an existing one."""
    doc = ws.doc(document)
    reshape_guards(ws, doc)
    s = _need(resolve(doc, ref), Sentence, ref)
    _guard(ws, s, ref)
    try:
        n = whole(before_word, 'before_word')
    except ValueError:
        raise ToolError('before_word must be a word number (the first word of the new sentence)') from None
    if not 2 <= n <= len(s.words):
        raise ToolError(f'before_word must be between 2 and {len(s.words)} for {ref} (a split before w1 changes nothing)')
    w = s.words[n - 1]
    left = doc.body[s.begin:w.begin].strip()
    right = doc.body[w.begin:s.end].strip()
    note = ' (sentence values such as the translation stay with the first part)' if s.fields else ''
    # A relation a layer keeps inside one sentence goes when the cut leaves
    # its ends on two sides, in the split's own transaction.
    note += loss_note(len(other_layers_crossing(_other_layers(ws, doc), ws.project.sentence_layer_id,
                                                s.id, w.begin)))
    ws.add_op({'kind': 'split_sentence', 'sentence_id': s.id, 'position': w.begin,
               'token_at': {'begin': s.begin, 'end': s.end},
               'label': f'{ws.doc_label(doc.id)} {ref}: split before w{n} {qv(w.surface)} → {qv(left[:40])} | {qv(right[:40])}{note}'})
    return ws.planned_note(1)


def t_merge_sentences(ws: Workspace, document: str, ref: str) -> str:
    """PLAN: merge a sentence into the one before it."""
    doc = ws.doc(document)
    reshape_guards(ws, doc)
    s = _need(resolve(doc, ref), Sentence, ref)
    if s.index < 2:
        raise ToolError(f'{ref} is the first sentence; name the sentence to merge into the one before it')
    prev = doc.sentences[s.index - 2]
    _guard(ws, s, ref, merging=True)
    _guard(ws, prev, f's{prev.index}', merging=True)
    spans = _joined_spans([prev, s], ws.project)
    comb = _combined_values(spans, ws.project)
    op = {'kind': 'merge_sentences', 'sentence_id': prev.id, 'other_id': s.id, 'spans': spans,
          'label': f'{ws.doc_label(doc.id)}: merge s{s.index} {qv(s.text[:30])} into s{prev.index} {qv(prev.text[:30])}'
                   + (f' (values combined: {comb})' if comb else '')}
    refuse_rule_on_merged(ws, op)
    ws.add_op(op)
    return ws.planned_note(1)


# --- text edits ----------------------------------------------------------------

def _guard_text_edit(ws: Workspace, text_id: Optional[str], begin: int, end: int, where: str,
                     token_ids=()) -> None:
    """The refusals every text edit owes, whichever tool stages it.

    A region edit shifts everything after it, so it may only sit after every
    respelling of the same text in the plan (the executor runs region edits
    first, then respellings with their still-valid offsets), and regions must
    not overlap. ``token_ids`` is the words and morphemes the edit will name
    as deleted, which nothing else in the plan may be anchored to."""
    for b, e in ws.planned_respells(text_id):
        if e > begin:
            raise ToolError(f'{where}: a respelling is planned at {b}-{e} in the same text, after this point; '
                            'plan the respellings in a separate plan (or discard_plan)')
    for op in ws.ops:
        if op.get('kind') == 'edit_text' and op.get('text_id') == text_id and (op['begin'], op['end']) != (begin, end) \
                and op['begin'] < max(end, begin + 1) and begin < max(op['end'], op['begin'] + 1):
            raise ToolError(f'{where}: overlaps a text edit already planned at {op["begin"]}-{op["end"]}')
    refuse_comment_and_text_edit(ws, token_ids, where, commenting=False)


def _clean_text(text: str) -> str:
    text = (text or '').replace('\r\n', '\n').strip('\n')
    if not text.strip():
        raise ToolError('text must not be empty')
    return text


def t_append_text(ws: Workspace, document: str, text: str) -> str:
    """PLAN: add sentences at the end of a document."""
    doc = ws.doc(document)
    reshape_guards(ws, doc)
    text = _clean_text(text)
    at = len(doc.body)
    _guard_text_edit(ws, doc.text_id, at, at, f'{ws.doc_label(doc.id)}: append')
    sep = '' if not doc.body or doc.body.endswith('\n') else '\n'
    sents = split_sentences(text)
    words = len(project_new_words(ws.project, doc.body, [(at, at, sep + text)],
                                  [(w.begin, w.end) for st in doc.sentences for w in st.words],
                                  [(st.begin, st.end) for st in doc.sentences]))
    ws.add_op({'kind': 'edit_text', 'document_id': doc.id, 'text_id': doc.text_id, 'sentence_id': None,
               'begin': at, 'end': at, 'old': '', 'new': sep + text, 'word_ids': [], 'morpheme_ids': [],
               'label': f'{ws.doc_label(doc.id)}: append {len(sents)} sentence{"s" if len(sents) != 1 else ""} '
                        f'({words} words): {qv(text[:60] + ("…" if len(text) > 60 else ""))}'})
    return ws.planned_note(1)


def t_retype_sentence(ws: Workspace, document: str, ref: str, text: str) -> str:
    """PLAN: replace one sentence's baseline text."""
    doc = ws.doc(document)
    reshape_guards(ws, doc)
    s = _need(resolve(doc, ref), Sentence, ref)
    text = _clean_text(text)
    b, e = s.begin, s.end
    while b < e and doc.body[b].isspace():
        b += 1
    while e > b and doc.body[e - 1].isspace():
        e -= 1
    old = doc.body[b:e]
    if old == text:
        return ws.planned_note(0)
    # The word ids, not the sentence's: a retype may respell or remove any
    # word of the sentence, and the analysis guard compares word ids. Handed a
    # sentence id it could never fire, so set_analysis then retype staged both
    # and approval silently dropped one of them.
    word_ids = [w.id for w in s.words]
    morpheme_ids = [m.id for w in s.words for m in w.morphemes]
    _guard(ws, s, ref, word_ids=word_ids)
    _guard_text_edit(ws, doc.text_id, b, e, f'{ws.doc_label(doc.id)} {ref}', word_ids + morpheme_ids)
    n = len(split_sentences(text))
    ws.add_op({'kind': 'edit_text', 'document_id': doc.id, 'text_id': doc.text_id, 'sentence_id': s.id,
               'begin': b, 'end': e, 'old': old, 'new': text,
               'word_ids': word_ids, 'morpheme_ids': morpheme_ids,
               'label': f'{ws.doc_label(doc.id)} {ref}: retype {qv(old[:40] + ("…" if len(old) > 40 else ""))} → '
                        f'{qv(text[:40] + ("…" if len(text) > 40 else ""))}' + (f' ({n} sentences)' if n > 1 else '')
                        + f' ({_retype_effects(ws, s, b, old, text)})'})
    return ws.planned_note(1)


def _retype_effects(ws: Workspace, s: Sentence, at: int, old: str, text: str) -> str:
    """What a retype does to the sentence's words, for the card. The text is
    sent as edits at their place (``plan._region_edits``) and the server's
    plain rule decides: a word edited or typed over keeps its token and its
    analysis, a word left with no letter is deleted with its analysis, and
    text between words becomes new words with none. The analyzed words an
    edit reaches are named, since each either carries its analysis onto a new
    spelling or loses it."""
    from difflib import SequenceMatcher
    from .stats import _analyzed
    gaps = [(at + i1, at + i2, text[j1:j2])
            for tag, i1, i2, j1, j2 in SequenceMatcher(None, old, text, autojunk=False).get_opcodes()
            if tag != 'equal']

    def reached(w) -> bool:
        for gb, ge, value in gaps:
            if gb < w.end and ge > w.begin:
                return True
            # Typed at an edge with no space between: the word takes it.
            if gb == ge == w.end and value[:1] and not value[:1].isspace():
                return True
            if gb == ge == w.begin and value[-1:] and not value[-1:].isspace():
                return True
            if gb == ge and w.begin < gb < w.end:
                return True
        return False

    touched = [w for w in s.words if _analyzed(w) and reached(w)]
    out = ('Changed words keep their analysis, removed words lose theirs, new words start unanalyzed. '
           'Sentence fields stay')
    if touched:
        out += '. Analyzed words changed: ' + ', '.join(w.surface for w in touched)
    return out
