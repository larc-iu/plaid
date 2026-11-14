"""Word references into a sentence the plan retypes (BRIEF RR).

A retype (``retype_sentence``, an ``edit_text`` op naming its sentence) may
insert, remove or join words, so once a plan holds one, ``sN.wK`` of that
sentence names the K-th word of the sentence AS PLANNED: the words the retype
leaves, numbered as a read numbers them once it is applied. The retype's op
carries them (``planned_words``: each word's surface, and the id of the word it
was when it is a word the sentence already has), and its tool answer lists them.

Only word field values are planned on those words (``set_field``): a
``set_span`` naming its word by its place in the planned sentence
(``planned_word``), written in the text edit's follow-up once the server has
made the words and the sentence came out as planned (``plan._write_text_edit``).
Every other change naming a word or a morpheme of a retyped sentence is refused,
in both orders, with what to do instead.

Which words the retype leaves is the server's plain rule (a word keeps its
token while a letter of it is left, typed text against a word's edge joins it,
and "Tokenize new text" makes the words of the text typed between). The
numbering read here follows that rule for the edits the executor sends
(``plan._region_gaps``), and the executor checks it against the words the
server made before it writes a value: a sentence that came out otherwise is
refused, never written on another word.
"""

from difflib import SequenceMatcher
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Tuple

from plaid_client.workflows.igt.ignored import is_token_ignored
from plaid_client.workflows.igt.word_breaks import is_js_space, is_kept_out

from ..core.bidi import qv
from ..core.refs import read_ref, same_form
from ..core.tools import ToolError
from .project import Morpheme, Word, resolve, split_sentences

#: The key of a value planned on a word of a retyped sentence.
PLANNED = 'planned_word'

RENUMBERED = ('{where}: s{n} is retyped in this plan, so its words are renumbered when it is applied. Plan this '
              'once the retype is applied, or discard_plan to start over. Only word field values can be planned on '
              'its words in this plan (set_field, by the numbers the retype listed).')
UNNUMBERED = ('{where}: s{n} is retyped in this plan, and its new text changes its words in a way that cannot be '
              'numbered before it is applied. Plan values on its words once the retype is applied, or discard_plan '
              'to start over.')


# --- the retype's edits, word by word ------------------------------------------------


def word_runs(text: str, cfg=None) -> List[Tuple[int, int]]:
    """The words of ``text`` as a retype pairs them: each run of characters
    that are neither whitespace (JavaScript's, as the editor reads it) nor
    one the word layer's ignored-tokens rule keeps out of words (``cfg``,
    punctuation under the default rule), which stand between words."""
    out, i = [], 0
    stop = lambda c: is_js_space(c) or is_kept_out(c, cfg)  # noqa: E731
    while i < len(text):
        if stop(text[i]):
            i += 1
            continue
        j = i + 1
        while j < len(text) and not stop(text[j]):
            j += 1
        out.append((i, j))
        i = j
    return out


def paired_words(old: List[str], new: List[str]) -> List[Tuple[int, int]]:
    """``(i, j)``: old word i is new word j, the longest common subsequence
    of the two by exact text, and of the longest ones the one that pairs each
    new word with the earliest old word it can."""
    n, m = len(old), len(new)
    best = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            best[i][j] = best[i + 1][j + 1] + 1 if old[i] == new[j] else max(best[i + 1][j], best[i][j + 1])
    out, i, j = [], 0, 0
    while i < n and j < m:
        if old[i] == new[j] and best[i][j] == best[i + 1][j + 1] + 1:
            out.append((i, j))
            i, j = i + 1, j + 1
        elif best[i + 1][j] >= best[i][j + 1]:
            i += 1
        else:
            j += 1
    return out


def _letters(old: str, ob: int, oe: int, new: str, nb: int, ne: int) -> List[Dict[str, Any]]:
    """The gaps that make ``new[nb:ne]`` of ``old[ob:oe]``, letter by letter
    (a diff of the two pieces alone)."""
    return [{'start': ob + i1, 'end': ob + i2, 'value': new[nb + j1:nb + j2]}
            for tag, i1, i2, j1, j2 in SequenceMatcher(None, old[ob:oe], new[nb:ne], autojunk=False).get_opcodes()
            if tag != 'equal']


def word_gaps(old: str, new: str, at: int = 0, cfg=None) -> List[Dict[str, Any]]:
    """The gaps (``{start, end, value}``, code points, ``at`` added) a retype
    of ``old`` as ``new`` is sent as, read word by word:

    - old and new words (``word_runs``, ``cfg`` the word layer's
      ignored-tokens rule) are paired by exact text
      (``paired_words``), and a paired word is left as it is;
    - between two paired words (or a sentence's edge), as many old words as
      new: the k-th old word is the k-th new word, changed letter by letter,
      and so is each stretch between words (spaces, punctuation);
    - between them, fewer new words than old, none: the old words go whole,
      with the stretch after them up to the paired word after them (before
      them at the sentence's end), and the stretch left is changed letter by
      letter into the new one;
    - more new words than old, none: the new words are typed whole, with
      the stretch after them, at the paired word after them (with the
      stretch before them, after the paired word before them, at the
      sentence's end);
    - words on both sides, another number: the old words, from the first
      one's start to the last one's end, are typed over by the new ones as
      one stretch, which core reads by its own rule (a stretch over two or
      more words goes whole, R60; one word typed over keeps the letters it
      shares at either end, Q2).

    Touching gaps are one gap, as core composes them."""
    ow, nw = word_runs(old, cfg), word_runs(new, cfg)
    pairs = paired_words([old[b:e] for b, e in ow], [new[b:e] for b, e in nw])
    gaps: List[Dict[str, Any]] = []
    anchors = [(-1, -1)] + pairs + [(len(ow), len(nw))]
    for (i0, j0), (i1, j1) in zip(anchors, anchors[1:]):
        o, n = ow[i0 + 1:i1], nw[j0 + 1:j1]
        ob = ow[i0][1] if i0 >= 0 else 0
        oe = ow[i1][0] if i1 < len(ow) else len(old)
        nb = nw[j0][1] if j0 >= 0 else 0
        ne = nw[j1][0] if j1 < len(nw) else len(new)
        if len(o) == len(n):
            ocut = [ob] + [x for w in o for x in w] + [oe]
            ncut = [nb] + [x for w in n for x in w] + [ne]
            for k in range(len(ocut) - 1):
                gaps += _letters(old, ocut[k], ocut[k + 1], new, ncut[k], ncut[k + 1])
        elif o and n:
            gaps += _letters(old, ob, o[0][0], new, nb, n[0][0])
            gaps.append({'start': o[0][0], 'end': o[-1][1], 'value': new[n[0][0]:n[-1][1]]})
            gaps += _letters(old, o[-1][1], oe, new, n[-1][1], ne)
        elif o:
            if i1 < len(ow):
                gaps += _letters(old, ob, o[0][0], new, nb, ne)
                gaps.append({'start': o[0][0], 'end': oe, 'value': ''})
            elif i0 >= 0:
                gaps.append({'start': ob, 'end': o[-1][1], 'value': ''})
                gaps += _letters(old, o[-1][1], oe, new, nb, ne)
            else:
                gaps.append({'start': ob, 'end': oe, 'value': new[nb:ne]})
        else:
            if i1 < len(ow):
                gaps += _letters(old, ob, oe, new, nb, n[0][0])
                gaps.append({'start': oe, 'end': oe, 'value': new[n[0][0]:ne]})
            elif i0 >= 0:
                gaps.append({'start': ob, 'end': ob, 'value': new[nb:n[-1][1]]})
                gaps += _letters(old, ob, oe, new, n[-1][1], ne)
            else:
                gaps.append({'start': ob, 'end': oe, 'value': new[nb:ne]})
    out: List[Dict[str, Any]] = []
    for g in sorted(gaps, key=lambda g: (g['start'], g['end'])):
        if g['start'] == g['end'] and not g['value']:
            continue
        if out and out[-1]['end'] == g['start']:
            out[-1] = {**out[-1], 'end': g['end'], 'value': out[-1]['value'] + g['value']}
        else:
            out.append(dict(g))
    return [{'start': g['start'] + at, 'end': g['end'] + at, 'value': g['value']} for g in out]


def trimmed(body: str, gaps: List[Dict[str, Any]], words) -> List[Dict[str, Any]]:
    """``gaps`` as core reads them (``plaid.algos.text.read/trim-gap``): each
    less the text its new value shares with the old at either end, back to a
    word edge where the gap is over two or more of ``words`` (the word
    layer's ``(begin, end)``, R60), and none where nothing is left."""
    out = []
    for g in gaps:
        start, end, v = g['start'], g['end'], g['value']
        n, k = len(v), end - start
        p = 0
        while p < n and p < k and v[p] == body[start + p]:
            p += 1
        s = 0
        while s < n - p and s < k - p and v[n - 1 - s] == body[end - 1 - s]:
            s += 1
        over = [(b, e) for b, e in words if b < max(end, start + 1) and e > start and b < e]
        several = p + s > 0 and len([1 for b, e in over if b < end and start < e]) > 1
        x, y = start + p, end - s
        if several:
            inside = lambda q: next(((b, e) for b, e in words if b < q < e), None)  # noqa: E731
            while (w := inside(x)) is not None and start < x:
                x = max(start, w[0])
            while (w := inside(y)) is not None and y < end:
                y = min(end, w[1])
        p, s = x - start, end - y
        if p == 0 and s == 0:
            out.append(dict(g))
        elif p + s == n and p + s == k:
            continue
        else:
            out.append({'start': start + p, 'end': end - s, 'value': v[p:n - s]})
    return out


def planned_words(project, body: str, words, begin: int, old: str, text: str,
                  extents=()) -> Optional[List[Dict[str, Any]]]:
    """The words a sentence holds once ``old`` (its text, at ``begin`` in
    ``body``) is retyped as ``text``, in order, as a read numbers them (the
    ignored tokens left out): ``{surface, word_id}``, ``word_id`` the id of
    the word of ``words`` (the sentence's words as read) it is, None for a
    word "Tokenize new text" makes. None when they cannot be numbered here:
    the new text is several sentences, or a space typed inside a word.
    ``extents`` are the word layer's tokens as ``(begin, end)``, punctuation
    tokens too, which core's trim reads.

    The server's plain rule, for the edits the executor sends
    (:func:`word_gaps`, as core trims them, :func:`trimmed`): a word with a
    letter of it left keeps its token, from its first kept letter to its
    last, and takes text typed against its edges up to whitespace or a
    character its layer keeps out of words. The rest of the text typed is cut
    into words at whitespace and those characters, each made a word when it
    holds a typed letter and is not a token the project ignores."""
    if len(split_sentences(text)) > 1:
        return None
    cfg = project.ignored_cfg
    gaps = trimmed(body, word_gaps(old, text, begin, cfg), extents or [(w.begin, w.end) for w in words])
    to_new: Dict[int, int] = {}
    shift, gi = 0, 0
    for i in range(begin, begin + len(old)):
        while gi < len(gaps) and gaps[gi]['end'] <= i and not (gaps[gi]['start'] == gaps[gi]['end'] == i):
            shift += len(gaps[gi]['value']) - (gaps[gi]['end'] - gaps[gi]['start'])
            gi += 1
        while gi < len(gaps) and gaps[gi]['start'] == gaps[gi]['end'] == i:
            shift += len(gaps[gi]['value'])
            gi += 1
        if gi < len(gaps) and gaps[gi]['start'] <= i < gaps[gi]['end']:
            continue
        to_new[i] = i - begin + shift
    kept = set(to_new.values())

    def joins(j: int) -> bool:
        return j not in kept and not is_js_space(text[j]) and not is_kept_out(text[j], cfg)

    found: List[list] = []
    taken: set = set()
    for w in sorted(words, key=lambda x: x.begin):
        at = [to_new[i] for i in range(w.begin, w.end) if i in to_new and not is_js_space(body[i])]
        if not at:
            continue  # every letter of it goes: the word goes
        lo, hi = min(at), max(at) + 1
        if any(is_js_space(c) for c in text[lo:hi]):
            return None
        while hi < len(text) and hi not in taken and joins(hi):
            hi += 1
        while lo > 0 and lo - 1 not in taken and joins(lo - 1):
            lo -= 1
        taken.update(range(lo, hi))
        found.append([lo, hi, w.id])
    if project.tokenize_new_text:
        j = 0
        while j < len(text):
            if j in taken or is_js_space(text[j]) or is_kept_out(text[j], cfg):
                j += 1
                continue
            k = j + 1
            while k < len(text) and k not in taken and not is_js_space(text[k]) and not is_kept_out(text[k], cfg):
                k += 1
            if any(x not in kept for x in range(j, k)) and not is_token_ignored(text[j:k], cfg):
                found.append([j, k, None])
            j = k
    found.sort()
    return [{'surface': text[lo:hi], 'word_id': wid} for lo, hi, wid in found
            if not is_token_ignored(text[lo:hi], cfg)]


def listing(n: int, planned: List[Dict[str, Any]]) -> str:
    """The planned words of sentence ``n`` as the retype's answer lists them."""
    if not planned:
        return f's{n} has no words once retyped.'
    return (f's{n} once retyped: ' + ', '.join(f'w{i} {qv(p["surface"])}' + (' (new)' if p['word_id'] is None else '')
                                              for i, p in enumerate(planned, start=1))
            + f'. In this plan s{n}.wN names these words.')


def gone_words(s, planned: List[Dict[str, Any]]) -> str:
    """The words of sentence ``s`` a retype takes, each by its number as read
    and its spelling, for the retype's answer: '' when it takes none."""
    kept = {p['word_id'] for p in planned}
    gone = [f's{s.index}.w{w.index} {qv(w.surface)}' for w in s.words if w.id not in kept]
    return f' Words that go: {", ".join(gone)}.' if gone else ''


def retype_of(ops, sentence_id: Optional[str]) -> Optional[Dict[str, Any]]:
    """The retype of sentence ``sentence_id`` the plan holds, or None."""
    if not sentence_id:
        return None
    return next((o for o in ops if o.get('kind') == 'edit_text' and o.get('sentence_id') == sentence_id), None)


def retyped_tokens(ops) -> Dict[str, Dict[str, Any]]:
    """Each word and morpheme of a sentence the plan retypes, to its retype."""
    out: Dict[str, Dict[str, Any]] = {}
    for o in ops:
        if o.get('kind') == 'edit_text' and o.get('sentence_id'):
            for i in list(o.get('word_ids') or []) + list(o.get('morpheme_ids') or []):
                out[i] = o
    return out


def named_tokens(op: Dict[str, Any]) -> set:
    """Every word, morpheme or sentence id an op names."""
    out = set()
    for key in ('word_id', 'morpheme_id', 'token_id', 'token_id_hint', 'analysis_word_id', 'entity_id'):
        if isinstance(op.get(key), str):
            out.add(op[key])
    for key in ('token_ids', 'other_ids', 'word_ids', 'morpheme_ids'):
        out.update(i for i in op.get(key) or [] if isinstance(i, str))
    for m in op.get('existing') or []:
        if isinstance(m, dict) and m.get('id'):
            out.add(m['id'])
    return out


def sentence_number(doc, sentence_id: str) -> Optional[int]:
    return next((s.index for s in doc.sentences if s.id == sentence_id), None) if doc is not None else None


def planned_ref(ws, doc, ref: str, where: str):
    """For a reference into a sentence the plan retypes: ``None`` for a
    sentence or one not retyped, else ``(sentence, index, planned word,
    retype)`` for a word of it AS PLANNED. A morpheme of it, a word past the
    planned count or one its form does not match, and a retype whose words
    cannot be numbered, are refused."""
    r = read_ref(ref, 'wm')
    if r is None or not 1 <= r.sentence <= len(doc.sentences):
        return None
    s = doc.sentences[r.sentence - 1]
    edit = retype_of(ws.ops, s.id)
    wi, mi = r.parts
    if edit is None or (wi is None and not r.by_form):
        return None
    if mi is not None:
        raise ToolError(RENUMBERED.format(where=where, n=s.index), kind='conflict')
    planned = edit.get('planned_words')
    if planned is None:
        raise ToolError(UNNUMBERED.format(where=where, n=s.index), kind='conflict')
    if r.by_form:
        from .project import _word_by_form
        shown = SimpleNamespace(index=s.index, words=[SimpleNamespace(surface=p['surface'], index=i)
                                                      for i, p in enumerate(planned, start=1)])
        wi = _word_by_form(shown, ref, r).index
    if not 1 <= wi <= len(planned):
        raise ToolError(f'{ref}: {listing(s.index, planned)}', kind='not-found')
    if r.form and not same_form(r.form, planned[wi - 1]['surface']):
        raise ToolError(f'{ref}: s{s.index}.w{wi} is {qv(planned[wi - 1]["surface"])} once retyped, not '
                        f'{qv(r.form)}. {listing(s.index, planned)}', kind='not-found')
    return s, wi, planned[wi - 1], edit


def planned_token(s, entry: Dict[str, Any]) -> str:
    """The token a planned value names: the word it was, else (a word the
    retype makes) its sentence, with ``planned_word`` saying which word."""
    return entry['word_id'] or s.id


def refuse_on_retyped(ws, op: Dict[str, Any], others) -> None:
    """A change naming a word or a morpheme of a sentence the plan retypes,
    other than a planned word value: refused (``RENUMBERED``)."""
    from .plan import KIND, TEXT_SHAPE
    if op.get(PLANNED) is not None or KIND.get(op.get('kind')) is None or KIND[op['kind']].shape == TEXT_SHAPE:
        return
    # A confirmation over a scope leaves out what the plan may delete when it
    # is applied (``plan.normalize_ops``): only one naming words is refused.
    if op.get('kind') == 'confirm' and not op.get('named'):
        return
    retyped = retyped_tokens(others)
    hit = named_tokens(op) & set(retyped)
    if not hit:
        return
    edit = retyped[next(iter(hit))]
    doc = ws._docs.get(edit.get('document_id'))
    n = sentence_number(doc, edit.get('sentence_id'))
    where = f'{ws.doc_label(doc.id)} s{n}' if doc is not None else f's{n}'
    raise ToolError(RENUMBERED.format(where=where, n=n), kind='conflict')


def restage_on_retype(ws, doc, s, edit: Dict[str, Any], where: str) -> List[Tuple[int, Dict[str, Any]]]:
    """A retype of ``s`` staged after changes naming its words: the word
    values planned on them, each moved to the number its word has once
    retyped (``(index in the plan, the value as planned)``), and every other
    change refused, as is a value on a word the retype takes, a value on a
    word an earlier retype of the sentence made, and any value when the new
    words cannot be numbered."""
    from .plan import KIND, TEXT_SHAPE
    mine = set(edit.get('word_ids') or []) | set(edit.get('morpheme_ids') or [])
    planned = edit.get('planned_words')
    out = []
    for i, op in enumerate(ws.ops):
        spec = KIND.get(op.get('kind'))
        if spec is None or spec.shape == TEXT_SHAPE or (op.get('kind') == 'confirm' and not op.get('named')):
            continue
        p = op.get(PLANNED)
        if p is not None:
            if p.get('sentence_id') != s.id:
                continue
        elif not named_tokens(op) & mine:
            continue
        f = ws.project.field_by_layer(op.get('layer_id')) if op.get('kind') == 'set_span' else None
        label = op.get('label') or op.get('kind')
        if f is None or f.scope != 'Word':
            raise ToolError(f'{where}: this plan already has a change on a word of this sentence ({label}), and '
                            'a retype renumbers its words when it is applied. Plan one of them, or discard_plan '
                            'to start over', kind='conflict')
        word_id = p.get('word_id') if p is not None else op.get('token_id')
        if planned is None:
            raise ToolError(UNNUMBERED.format(where=where, n=s.index), kind='conflict')
        k = next((k for k, x in enumerate(planned, start=1) if word_id and x['word_id'] == word_id), None)
        if k is None:
            raise ToolError(f'{where}: this plan already has a value on a word this retype takes away or that an '
                            f'earlier retype made ({label}). Plan one of them, or discard_plan to start over',
                            kind='conflict')
        out.append((i, planned_value(ws, doc, s, k, planned[k - 1], f, op.get('value') or '',
                                     span_id=op.get('span_id'), old=old_value(doc, word_id, f))))
    return out


def old_value(doc, word_id: Optional[str], f):
    hit = doc.find(word_id) if word_id else None
    w = hit[1] if hit is not None else None
    return w.fields.get(f.name) if w is not None else None


def planned_value(ws, doc, s, k: int, entry: Dict[str, Any], f, value: str, span_id=None, old=None) -> Dict[str, Any]:
    """The set_span of field ``f`` = ``value`` on word ``k`` of sentence
    ``s`` as its retype plans it (``entry``). ``old`` the word's span as read,
    for a word the sentence already has."""
    from ..core.plan import labelled
    new = entry['word_id'] is None
    place = f'{ws.doc_label(doc.id)} s{s.index}.w{k} {qv(entry["surface"][:40])}' + (' (new)' if new else '')
    was = old.value if old is not None else ''
    change = f'{f.name} ' + (f'{qv(was)} → {qv(value)}' if was != '' else f'= {qv(value)}') \
        + (' (cleared)' if value == '' else '')
    return {'kind': 'set_span', 'layer_id': f.layer_id, 'token_id': planned_token(s, entry),
            'span_id': (old.id if old is not None else span_id) if not new else None, 'value': value,
            'doc': doc.id,
            PLANNED: {'sentence_id': s.id, 'index': k, 'surface': entry['surface'], 'word_id': entry['word_id']},
            **labelled(place, change)}


# --- bare numbers a planned split, merge or word delete renumbers ---------------------

#: The plan ops that change how many words a sentence has without changing
#: its text: a word ref after them names the word as read, by its number now.
WORD_RESHAPES = ('split_word', 'merge_words', 'delete_word')


def numbers_after(s, shapes) -> Dict[str, int]:
    """Each word of sentence ``s`` that ``shapes`` (split, merge and delete
    ops) leave, to its number once they run: a split word is followed by its
    right part, a deleted word and a word merged into another are gone."""
    split = {o.get('word_id') for o in shapes if o.get('kind') == 'split_word'}
    gone = {o.get('word_id') for o in shapes if o.get('kind') == 'delete_word'}
    for o in shapes:
        if o.get('kind') == 'merge_words':
            gone.update(o.get('other_ids') or [])
    out, n = {}, 0
    for w in s.words:
        if w.id in gone:
            continue
        n += 1
        out[w.id] = n
        if w.id in split:
            n += 1
    return out


def _shapes_in(ops, s) -> List[Dict[str, Any]]:
    ids = {w.id for w in s.words}
    return [o for o in ops if o.get('kind') in WORD_RESHAPES and o.get('word_id') in ids]


def _kept_numbers(s, after: Dict[str, int]) -> str:
    """Which words keep their numbers once the plan runs, for a refusal."""
    first = next((w.index for w in s.words if after.get(w.id, w.index) != w.index or w.id not in after), None)
    if first is None or first == 1:
        return 'No word of it keeps its number.'
    return f'Words before w{first} keep their numbers.'


def renumbering(ws, s, w):
    """``(the reshape's kind, the word's number once applied, every word's
    number then)`` when a split, merge or word delete the plan holds in
    sentence ``s`` gives word ``w`` another number, else None. A word the
    reshape itself takes has no number after: None."""
    shapes = _shapes_in(ws.ops, s)
    if not shapes:
        return None
    after = numbers_after(s, shapes)
    new = after.get(w.id)
    if new is None or new == w.index:
        return None
    return next(o.get('kind') for o in shapes), new, after


def renumbered(ws, doc, ref: str, obj, named: Optional[str] = None) -> None:
    """Refuse ``obj`` (what ``ref`` names in ``doc``) when ``ref`` names a
    word, or a morpheme of it, by its number alone and a split, merge or word
    delete the plan holds in its sentence gives that word another number
    once applied, as plaid-ud's ``renumbered_refusal``: the number names one
    word now and another once the plan runs, and the model may mean either.
    With its form beside the number, or by form alone, the word is the one
    read. A word the reshape itself takes (a deleted word, one merged into
    another) has no number after and is left to the shape guards. ``named``
    is how the refusal says to name it, for a morpheme of a planned
    analysis."""
    if getattr(ws, 'restaging', False):
        return
    r = read_ref(ref, 'wm')
    if r is None or r.by_form or r.form or not isinstance(obj, (Word, Morpheme)):
        return
    hit = doc.find(obj.id)
    if hit is None or hit[1] is None:
        return
    s, w = hit[0], hit[1]
    moved = renumbering(ws, s, w)
    if moved is None:
        return
    by, new, after = moved
    here = f's{s.index}.w{w.index}'
    if named is None:
        named = f'{here}.m{obj.index} "{obj.form}"' if isinstance(obj, Morpheme) else f'{here} "{w.surface}"'
    raise ToolError(f'{ws.doc_label(doc.id)} {ref}: {here} is {qv(w.surface)} now, but this '
                    f'plan\'s {by} renumbers s{s.index}: once it is applied, {qv(w.surface)} is w{new}. '
                    f'{_kept_numbers(s, after)} A plan names words by their numbers as read now, so add the form '
                    f'to say which you mean: {named}. A word the {by} makes is '
                    'named once the plan is applied.', kind='conflict')


def resolve_in(ws, doc, ref: str):
    """``project.resolve`` for a reference a tool was given: the thing it
    names, refused when it is a bare word number the plan's reshapes
    renumber (:func:`renumbered`)."""
    obj = resolve(doc, ref)
    renumbered(ws, doc, ref, obj)
    return obj
