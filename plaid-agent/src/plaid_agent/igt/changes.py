"""Where each planned change lands, for the plan card in the Assistant tab.

An op carries the ids it will write to and one line for people, its
``label`` (``Text 1 s3.w2 "gam": Gloss "fish" → "carpet"``). The card wants
the parts of that line separately: the document, the sentence and word (to
link into the editor), the word itself, and the change. Rather than have
every planning tool emit them, they are derived here when the plan is
packaged, from the ids: the documents a plan touches were loaded to plan it
(that is where the ids came from), so an id resolves to its sentence, word
and morpheme. A change whose document was not loaded (a corpus-wide tool
past its loading budget) names the document alone.

``where`` is one of:
    {'kind': 'token', 'document_id', 'document_name', 'sentence_id', 'sentence', 'word', 'morpheme',
     'begin', 'surface'}     a sentence (word None), word, or morpheme
    {'kind': 'document', 'document_id', 'document_name'}
    {'kind': 'entry', 'vocab_id', 'vocab_name', 'item_id', 'form'}
    None                     nothing to link to yet (a new document)
``change`` is the label without its location, or None when the label did
not have the expected shape (the card then shows the label whole).
"""

import re
from typing import Any, Dict, List, Optional

from .project import Sentence, Word, Morpheme

_TOKEN_KINDS = {
    'set_span': 'token_id', 'link': 'token_id', 'unlink': 'token_id_hint',
    'set_analysis': 'word_id', 'set_orthography': 'word_id', 'discard_analysis': 'word_id',
    'split_word': 'word_id', 'delete_word': 'word_id',
    'set_morpheme_form': 'morpheme_id', 'set_morph_type': 'morpheme_id',
    'split_sentence': 'sentence_id', 'merge_sentences': 'sentence_id', 'edit_text': 'sentence_id',
    'add_comment': 'entity_id',
}
# Ops over several tokens (a multi-word expression) read at their first one.
_MULTI_KINDS = {'link_phrase': 'token_ids', 'unlink': 'token_ids'}
_ENTRY_KINDS = {'set_entry_field': 'item_id', 'set_entry_metadata': 'item_id', 'delete_entry': 'item_id',
                'rename_entry': 'item_id', 'merge_entries': 'keep_id'}
_DOC_KINDS = {'set_doc_metadata', 'rename_document', 'confirm'}


def describe_changes(ws, ops: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [describe_change(ws, op) for op in ops]


def describe_change(ws, op: Dict[str, Any]) -> Dict[str, Any]:
    label = op.get('label') or ''
    where = locate(ws, op)
    return {'label': label, 'where': where, 'change': split_change(ws, label, where)}


# --- location -------------------------------------------------------------------

def locate(ws, op: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    kind = op.get('kind')
    if kind == 'create_document':
        return None
    # A stored group of like ops (core.plan.compact_ops) names no entity of
    # its own: it is placed at its document when its members share one.
    if op.get('compact'):
        doc_id = op.get('doc')
        return {'kind': 'document', 'document_id': doc_id, 'document_name': _doc_name(ws, doc_id)} if doc_id else None
    if kind == 'create_entry':
        v = _vocab(ws, op.get('vocab_id'))
        return _entry_where(v, None, op.get('form'))
    if kind in _ENTRY_KINDS:
        item_id = op.get(_ENTRY_KINDS[kind])
        v = ws.vocab_of_item(item_id) if item_id else None
        item = next((it for it in ws.lexicon(v) if it['id'] == item_id), None) if v else None
        return _entry_where(v, item_id, (item or {}).get('form'))
    if kind == 'merge_words':
        # The label reads at the sentence, since several words go.
        found = _find(ws, op.get('word_id'), op.get('doc'))
        if found:
            doc, s, _, _ = found
            return _token_where(ws, doc, s, None, None)
    if kind == 'respell':
        found = _find_word_at(ws, op.get('text_id'), op.get('begin'), op.get('doc'))
        if found:
            return _token_where(ws, *found)
    if kind in _TOKEN_KINDS:
        found = _find(ws, op.get(_TOKEN_KINDS[kind]), op.get('doc') or op.get('document_id'))
        if found:
            return _token_where(ws, *found)
    if kind in _MULTI_KINDS:
        ids = op.get(_MULTI_KINDS[kind]) or []
        found = _find(ws, ids[0] if ids else None, op.get('doc') or op.get('document_id'))
        if found:
            return _token_where(ws, *found)
    if kind == 'confirm':
        for key in ('span_ids', 'token_ids', 'link_ids'):
            ids = op.get(key) or []
            if ids and len(op.get('span_ids') or []) + len(op.get('token_ids') or []) + len(op.get('link_ids') or []) < 50:
                found = _find(ws, ids[0], op.get('doc'))
                if found:
                    return _token_where(ws, *found)
                break
    doc_id = op.get('document_id') or op.get('doc') or _doc_of(ws, op)
    if doc_id:
        return {'kind': 'document', 'document_id': doc_id, 'document_name': _doc_name(ws, doc_id)}
    return None


def _doc_of(ws, op: Dict[str, Any]) -> Optional[str]:
    """The loaded document an op's ids belong to, when no key names one."""
    for key in ('token_id', 'word_id', 'morpheme_id', 'sentence_id', 'token_id_hint', 'entity_id'):
        eid = op.get(key)
        if eid:
            for doc in ws._docs.values():
                if doc.find(eid):
                    return doc.id
    for key in ('span_ids', 'token_ids', 'link_ids'):
        for eid in op.get(key) or []:
            for doc in ws._docs.values():
                if doc.find(eid):
                    return doc.id
    text_id = op.get('text_id')
    if text_id:
        for doc in ws._docs.values():
            if doc.text_id == text_id:
                return doc.id
    return None


def _find(ws, entity_id: Optional[str], doc_id: Optional[str]):
    """(doc, sentence, word|None, morpheme|None) for an id in a loaded document."""
    if not entity_id:
        return None
    docs = [ws._docs[doc_id]] if doc_id and doc_id in ws._docs else list(ws._docs.values())
    for doc in docs:
        hit = doc.find(entity_id)
        if hit:
            return (doc,) + hit
    return None


def _find_word_at(ws, text_id: Optional[str], begin: Optional[int], doc_id: Optional[str]):
    if text_id is None or begin is None:
        return None
    docs = [ws._docs[doc_id]] if doc_id and doc_id in ws._docs else list(ws._docs.values())
    for doc in docs:
        if doc.text_id != text_id:
            continue
        for s in doc.sentences:
            for w in s.words:
                if w.begin == begin:
                    return doc, s, w, None
    return None


def _token_where(ws, doc, s: Sentence, w: Optional[Word], m: Optional[Morpheme]) -> Dict[str, Any]:
    surface = m.form if m else (w.surface if w else s.text[:40])
    return {'kind': 'token', 'document_id': doc.id, 'document_name': _doc_name(ws, doc.id),
            'sentence_id': s.id, 'sentence': s.index, 'word': w.index if w else None,
            'morpheme': m.index if m else None, 'begin': w.begin if w else s.begin, 'surface': surface}


def _entry_where(v: Optional[dict], item_id: Optional[str], form: Optional[str]) -> Dict[str, Any]:
    return {'kind': 'entry', 'vocab_id': v['id'] if v else None, 'vocab_name': v['name'] if v else None,
            'item_id': item_id, 'form': form}


def _vocab(ws, vocab_id: Optional[str]) -> Optional[dict]:
    return next((v for v in ws.project.vocabs if v['id'] == vocab_id), None)


def _doc_name(ws, doc_id: str) -> str:
    doc = ws._docs.get(doc_id)
    if doc is not None:
        return doc.name
    try:
        return ws.corpus.doc_name(doc_id)
    except Exception:  # noqa: BLE001 - a name is a nicety; the id still links
        return doc_id


# --- the change without its location -------------------------------------------

_WHAT = r'(?: "[^"]*"| \(in "[^"]*"\))?'
# A positional reference as the tools print it: `s3`, `s3.w2`, `s3.w2.m1`, and
# a span of words `s3 w2+w3` (a phrase).
_REF = r's\d+(?:[. ]w\d+(?:\+w\d+)*)?(?:\.m\d+)?'


def split_change(ws, label: str, where: Optional[Dict[str, Any]]) -> Optional[str]:
    """The label after its location head, in the shapes the planning tools
    write: ``<doc> <ref>[ "what"|(in "…")]: <change>`` (``<ref>`` a sentence,
    word, morpheme, or a phrase ``s1 w2+w3``), ``<doc>: <change>``,
    ``"<doc>"[ "what"]: <change>`` (an unloaded document), ``entry "form":
    <change>`` and ``<lexicon>: <change>``."""
    if not label or not where:
        return None
    if where['kind'] == 'entry':
        for head in (f'entry "{where.get("form")}": ', f'{where.get("vocab_name")}: '):
            if where.get('form') is not None and label.startswith(head):
                return label[len(head):]
        return None
    doc_label = ws.doc_label(where['document_id'])
    heads = [re.escape(doc_label) + ' ' + _REF + _WHAT + ': ',
             re.escape(doc_label) + ': ',
             re.escape(f'"{doc_label}"') + _WHAT + ': ']
    for head in heads:
        m = re.match(head, label)
        if m:
            return label[m.end():]
    return None
