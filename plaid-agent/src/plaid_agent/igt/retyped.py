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
from .project import split_sentences

#: The key of a value planned on a word of a retyped sentence.
PLANNED = 'planned_word'

RENUMBERED = ('{where}: s{n} is retyped in this plan, so its words are renumbered when it is applied. Plan this '
              'once the retype is applied, or discard_plan to start over. Only word field values can be planned on '
              'its words in this plan (set_field, by the numbers the retype listed).')
UNNUMBERED = ('{where}: s{n} is retyped in this plan, and its new text changes its words in a way that cannot be '
              'numbered before it is applied. Plan values on its words once the retype is applied, or discard_plan '
              'to start over.')


def planned_words(project, body: str, words, begin: int, old: str, text: str) -> Optional[List[Dict[str, Any]]]:
    """The words a sentence holds once ``old`` (its text, at ``begin`` in
    ``body``) is retyped as ``text``, in order, as a read numbers them (the
    ignored tokens left out): ``{surface, word_id}``, ``word_id`` the id of
    the word of ``words`` (the sentence's words as read) it is, None for a
    word "Tokenize new text" makes. None when they cannot be numbered here:
    the new text is several sentences, or a space typed inside a word.

    The server's plain rule, for the edits the executor sends (a diff of the
    region, ``plan._region_gaps``): a word with a letter of it left keeps its
    token, from its first kept letter to its last, and takes text typed
    against its edges up to whitespace or a character its layer keeps out of
    words. The rest of the text typed is cut into words at whitespace and
    those characters, each made a word when it holds a typed letter and is
    not a token the project ignores."""
    if len(split_sentences(text)) > 1:
        return None
    cfg = project.ignored_cfg
    to_new: Dict[int, int] = {}
    for tag, i1, i2, j1, j2 in SequenceMatcher(None, old, text, autojunk=False).get_opcodes():
        if tag == 'equal':
            for k in range(i2 - i1):
                to_new[begin + i1 + k] = j1 + k
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
