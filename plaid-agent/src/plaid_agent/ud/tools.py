"""The tools a UD assistant may call (the workspace they run against is
:mod:`.workspace`).

A tool returns TEXT for the model, never a structure: every failure is a
sentence it can read and recover from. A tool whose description starts with
``PLAN:`` proposes a change instead of making one, and what it proposes lands
on ``ws.ops`` for the user to approve.

Everything is addressed positionally (``s3.w2``), never by id: see
:mod:`.project` for why, and for what a UD project is shaped like.
"""

import re
from typing import Any, Dict, List, Optional

from ..core import keep
from ..core.keep import is_keep
from ..core.bidi import qname, qv
from ..core.args import whole
from ..core.limits import MAX_SCOPE_DOCS, OVERVIEW_DOCS
from ..core.history import doc_label, doc_labels, plain_quote
from ..core.plan import MANY, by_document, confirm_preview
from ..core.provenance import unmark
from ..core.refs import clip, read_ref
from ..core.tools import ToolError, server_refused
from .plan import (RESHAPES_DOCUMENT, RESHAPES_TOKEN, REWRITES_DOCUMENT, contributed_work, docs_of_op,
                   scope_taking)
from .project import (FEATURES, Sentence, Token, UdDoc, Word, feats_order, feature_key,
                      feature_refusal, normalize_feature, resolve, word_ref, words_listing)
from .review import (REVIEW_FIELDS, all_words, confirm_targets, counts_phrase, discard_targets,
                     left_phrase, per_field)
# The workspace lives in its own module, as igt's does. SPLITS_KEEP_WORDS is
# read from here by .bulk.
from .workspace import PLANNED_WORDS_LATER, SPLITS_KEEP_WORDS, Workspace  # noqa: F401

# --- reads --------------------------------------------------------------------

FIELDS = ('lemma', 'upos', 'xpos', 'features')


def t_project_overview(ws: Workspace) -> str:
    p = ws.project
    out = [f'Project "{p.name}" (Universal Dependencies)']
    if p.language:
        out.append(f'Language: {p.language}')
    out.append('')
    out.append('Every annotation sits on a WORD (a CoNLL-U word). A word is addressed by its '
               'position: s3.w2 is word 2 of sentence 3. A multi-word token is s3.w1-2.')
    out.append('')
    out.append('Vocabularies:')
    for f in ('upos', 'xpos', 'deprel'):
        out.append('  ' + p.rule(f))
    feats = p.vocab.get('feats') or {}
    if feats:
        out.append('  features: ' + ', '.join(f'{k}={"/".join(v)}' if v else k
                                              for k, v in sorted(feats.items())))
    else:
        out.append('  features: no inventory set, any Feature=Value is allowed')
    docs = ws.documents()
    out.append('')
    # How much corpus there is, so the model knows before it reads anything
    # whether reading is a way to answer. A project without the engine (a
    # test double) just goes without the line.
    try:
        sizes = ws.corpus.sizes()
        out.append(f'Size: {len(docs)} documents, {sizes["sentences"]} sentences, {sizes["words"]} words. '
                   'search, frequency_list, worklist and check_consistency read the whole corpus at '
                   'once; read_document reads one document a page at a time.')
        out.append('')
    except Exception:  # noqa: BLE001 - the overview is worth having without the size
        pass
    out.append(f'Documents ({len(docs)}):')
    labels = doc_labels(ws, plain_quote)
    for d in docs[:OVERVIEW_DOCS]:
        out.append(f'  {labels[d["id"]]}')
    if len(docs) > OVERVIEW_DOCS:
        out.append(f'  ... and {len(docs) - OVERVIEW_DOCS} more (list_documents pages through them)')
    return '\n'.join(out)


# --- planning helpers ----------------------------------------------------------

def _no_parse_planned(ws: Workspace, doc: UdDoc) -> None:
    """A parse rewrites a document from scratch, so nothing else in the same
    plan may write into it: whichever was planned first, the other is lost.
    Per document, which is why a parse is not tagged EXCLUSIVE: a plan may
    write to one document and parse another."""
    for op in ws.ops:
        if op.get('kind') in REWRITES_DOCUMENT and doc.id in docs_of_op(op):
            raise ToolError(f'This plan already parses {doc_label(ws, doc.id, qname)}, and a parse rewrites the '
                            f'document from scratch, so this change would be thrown away. Plan '
                            f'the parse on its own, or discard_plan and plan this without it.', kind='conflict')


def _no_restore_planned(ws: Workspace) -> None:
    """A restore rewrites every layer of its document, so nothing may join its
    plan. The rule and its wording are the workspace's, and every staged op
    reaches them through `guard_op`; this is the early refusal for a tool that
    would otherwise do expensive work first."""
    ws.refuse_exclusive(None)


def _no_boundary_moved(ws: Workspace, doc: UdDoc) -> None:
    """Moving a sentence boundary renumbers every sentence after it, and every
    reference in a plan is positional. Rather than decide whether a later
    "s7.w2" means before or after, a plan that moves a boundary does that and
    nothing else to the document."""
    for op in ws.ops:
        if op.get('kind') in RESHAPES_DOCUMENT and op.get('document_id') == doc.id:
            raise ToolError(f'This plan already moves a sentence boundary in {doc_label(ws, doc.id, qname)}, and '
                            f'that renumbers the sentences every other reference names. Apply it '
                            f'on its own, then plan the rest against the new numbering.', kind='conflict')


def _boundary_can_still_move(ws: Workspace, doc: UdDoc) -> None:
    """The same rule seen from the other side, for the boundary tools
    themselves. `_no_boundary_moved` refuses an edit planned AFTER a boundary
    move; without this, planning them the other way round was accepted, the
    card said the sentences would renumber, and `validate_ops` refused the
    whole thing only once the user had approved it."""
    if any(doc.id in docs_of_op(op) for op in ws.ops):
        raise ToolError(f'This plan already changes {doc_label(ws, doc.id, qname)}, and moving a sentence boundary '
                        f'renumbers the sentences every other reference names, so it has to be a '
                        f'plan of its own. Apply what is planned, then move the boundary.', kind='conflict')


def _guards(ws: Workspace, doc: UdDoc) -> None:
    """The refusals every edit to a document owes, whichever tool stages it.
    Kept in one place because the hole they leave is invisible: a tool that
    reaches a document's words without passing through here can join a plan
    that deletes the very tokens it writes to."""
    _no_parse_planned(ws, doc)
    _no_boundary_moved(ws, doc)
    _no_restore_planned(ws)




def _after_plan(ws: Workspace, doc: UdDoc, s: Sentence) -> List[tuple]:
    """The words of ``s`` once this plan's reshapes run, in order, each as
    ``(form, word)`` with ``word`` the word it is now, or None for one a
    reshape makes. [] when the plan reshapes none of its tokens."""
    ops = {}
    for op in ws.ops:
        if op.get('kind') in RESHAPES_TOKEN and op.get('document_id') == doc.id and op.get('forms'):
            for wid in op.get('existing_word_ids') or []:
                ops[wid] = op
    if not any(w.id in ops for w in s.words):
        return []
    by_id = {w.id: w for w in s.words}
    out, done = [], set()
    for w in s.words:
        op = ops.get(w.id)
        if op is None:
            out.append((w.form, w))
        elif id(op) not in done:
            done.add(id(op))
            # A split keeps its words, and says which they are (`after_ids`).
            # A set_words of another number makes every one of them anew.
            kept = op.get('after_ids') or [None] * len(op['forms'])
            out.extend((f, by_id.get(i)) for f, i in zip(op['forms'], kept))
    return out


def _reshaper(ws: Workspace, doc: UdDoc, s: Sentence) -> str:
    """The tool whose planned reshape changes the words of ``s``, as the
    refusals name it."""
    ids = {w.id for w in s.words}
    return next((op['kind'] for op in ws.ops if op.get('kind') in RESHAPES_TOKEN
                 and op.get('document_id') == doc.id and ids & set(op.get('existing_word_ids') or [])),
                'set_words')


def _listing_after(after: List[tuple]) -> str:
    listed = [f'w{i} "{clip(f)}"' for i, (f, _w) in enumerate(after, 1)]
    if len(listed) > 12:
        listed = listed[:11] + ['…', listed[-1]]
    return ', '.join(listed)


def planned_word_refusal(ws: Workspace, doc: UdDoc, s: Sentence, index: int, ref: str) -> Optional[str]:
    """The refusal for word ``index`` of ``s`` where there is one only once
    this plan's reshapes run."""
    after = _after_plan(ws, doc, s)
    if not after or not len(s.words) < index <= len(after):
        return None
    form, now = after[index - 1]
    out = (f'{ref} does not exist yet: s{s.index} has {len(s.words)} word'
           f'{"s" if len(s.words) != 1 else ""} now, and once this plan\'s {_reshaper(ws, doc, s)} runs its words are '
           + _listing_after(after) + '. ')
    if now is not None:
        return out + (f'A plan names words by their numbers now: "{clip(form)}" is '
                      f's{s.index}.w{now.index}.')
    return out + PLANNED_WORDS_LATER


def renumbered_refusal(ws: Workspace, doc: UdDoc, s: Sentence, index: int, ref: str) -> Optional[str]:
    """The refusal for word ``index`` of ``s`` named by its number alone when
    this plan's reshape of an earlier token renumbers it: the number names
    one word now and another once the plan runs, and a model that has just
    read what set_words makes may mean either. None when the number is the
    same before and after, or names a word the reshape itself replaces (the
    clash refusal says that)."""
    word = s.word(index)
    after = _after_plan(ws, doc, s)
    new = next((i for i, (_f, w) in enumerate(after, 1) if w is word), None) if word is not None else None
    if new is None or new == index:
        return None
    form = clip(word.form)
    then = f' and w{index} is "{clip(after[index - 1][0])}"' if index <= len(after) else ''
    out = (f'{ref} is "{form}" now, but this plan\'s {_reshaper(ws, doc, s)} renumbers s{s.index}: once it is applied, '
           f'"{form}" is w{new}{then}. A plan names words by their numbers now, so add the form to say '
           f'which you mean: s{s.index}.w{index} "{form}".')
    return out


def resolve_in(ws: Workspace, doc: UdDoc, ref: str):
    """:func:`resolve`, with the refusal a word this plan is still making
    calls for instead of a count that does not say why, and a refusal for a
    bare number this plan's reshape renumbers (no write lands on a word the
    model may not have meant)."""
    try:
        thing = resolve(doc, ref)
    except ValueError:
        r = read_ref(ref, 'w', ranged=True)
        if r is not None and r.parts[0] and 1 <= r.sentence <= len(doc.sentences):
            note = planned_word_refusal(ws, doc, doc.sentences[r.sentence - 1], r.until or r.parts[0], ref)
            if note:
                raise ToolError(note, kind='conflict') from None
        raise
    r = read_ref(ref, 'w', ranged=True)
    if isinstance(thing, (Word, Token)) and not r.form and not r.by_form:
        first = thing if isinstance(thing, Word) else (thing.words or [None])[0]
        note = first and renumbered_refusal(ws, doc, doc.sentences[r.sentence - 1], first.index, ref)
        if note:
            raise ToolError(note, kind='conflict')
    return thing


def _words(ws: Workspace, doc: UdDoc, refs) -> List[Word]:
    """The words a list of references names, with a readable failure when one
    of them names a sentence or a multi-word token instead."""
    _guards(ws, doc)
    if isinstance(refs, str):
        refs = [refs]
    if not refs:
        raise ToolError('Name at least one word, as a list of references like ["s1.w2"].', kind='invalid-argument')
    out = []
    for ref in refs:
        thing = resolve_in(ws, doc, str(ref))
        if isinstance(thing, Sentence):
            raise ToolError(f'{ref} is a sentence. Name its words (s{thing.index}.w1 and so on): '
                            f'an annotation sits on a word.', kind='invalid-argument')
        if isinstance(thing, Token):
            raise ToolError(f'{ref} is a multi-word token, which carries no annotation of its own. '
                            f'Name its words: ' + ', '.join(f's?.w{w.index}' for w in thing.words),
                            kind='invalid-argument')
        out.append(thing)
    return out


def _field_layer(ws: Workspace, field: str) -> str:
    if field not in FIELDS:
        raise ToolError(f'Unknown field "{field}". One of: ' + ', '.join(FIELDS), kind='invalid-argument')
    return ws.project.layer('features' if field == 'features' else field)


def t_set_field(ws: Workspace, document: str = None, refs=None, field: str = None,
                value: str = None) -> str:
    doc = ws.doc(document)
    layer_id = _field_layer(ws, field)
    value = '' if value is None else str(value)
    if field == FEATURES:
        return _set_features(ws, doc, layer_id, refs, value)
    value = unmark(value, field)
    words = _words(ws, doc, refs)
    staged, dropped, changed, kept, took = [], [], [], [], []
    for w in words:
        sp = w.fields.get(field)
        old = sp.value if sp else ''
        ref = word_ref(ws.sentence_of(doc, w), w)
        mine = [op for op in ws.ops if ws.op_target(op) == ('span', layer_id, w.id, None)]
        if old == value:
            # What the word holds already. Planning it again would restate it
            # and restamp its provenance as the plan's (Eline 2026-10-07), so
            # it is left out, and set back to what is stored the earlier
            # planned change is taken back. A corpus-wide change in the plan
            # that would change it is the one exception: the user is keeping
            # it out of that change, which a keep says without writing
            # (core.keep, Luke 2026-10-16).
            if sp is not None and value and scope_taking(ws.ops, doc.id, ws.sentence_of(doc, w), w, field, sp):
                if not any(is_keep(op) for op in mine):
                    staged.append(keep.op(('span', layer_id, w.id, None), f'{field} stays {qv(old)}',
                                          document_id=doc.id, ref=ref, field=field))
                    kept.append(ref)
            elif mine:
                dropped += mine
                # A keep left with nothing to keep the value out of goes
                # quietly: it planned nothing to take back.
                if any(not is_keep(op) for op in mine):
                    took.append(ref)
            continue
        if _planned_value(ws, layer_id, w, field) == value:
            continue
        changed.append(w)
        # The value it replaces, as igt's card says it: lemma "run" → "ran".
        label = (f'{field} {qv(old)} → {qv(value)}' if old and value else f'{field} = {qv(value)}' if value
                 else f'clear {field} {qv(old)}' if old else f'clear {field}')
        staged.append({'kind': 'set_span', 'layer_id': layer_id, 'token_id': w.id,
                       'span_id': sp.id if sp else None, 'value': value,
                       'field': field, 'document_id': doc.id,
                       'label': label,
                       'ref': ref})
    ws.add_ops(staged)
    ws.take_back(dropped)
    if not (changed or kept or took):
        return (f'Nothing to change: {field} is already "{value}" on every word named.' if value
                else f'Nothing to change: none of the words named has {field}.')
    what = f'{field} = "{value}"' if value else f'{field} cleared'
    said, line = [], []
    if changed:
        refs_ = [word_ref(ws.sentence_of(doc, w), w) for w in changed]
        said.append(f'Planned {what} on {len(changed)} word(s): ' + ', '.join(refs_) + _same_form_left(
            ws, doc, words, lambda o: _planned_value(ws, layer_id, o, field) == value))
        line.append(f'Planned {what} on ' + ', '.join(refs_))
    _keep_said(said, line, kept, took, f'{field} "{value}"', f'the planned {field} change',
               f'"{value}"' if value else f'no {field}')
    if kept or took:
        ws.step_label = '. '.join(line)
    return _joined(said)


def _joined(said: List[str]) -> str:
    """The parts of a tool's answer, each ending as a sentence does."""
    return ' '.join(p if i == len(said) - 1 or p.endswith('.') else p + '.' for i, p in enumerate(said))


def _keep_said(said: List[str], line: List[str], kept: List[str], took: List[str], what: str,
               change: str, stays: str) -> None:
    """What the model and the trace are told of values kept out of a
    corpus-wide change and of planned changes taken back, after anything
    planned. Neither is said as a change: nothing is written to either."""
    if kept:
        said.append(f'Kept {what} on {", ".join(kept)}: the corpus-wide change in the plan leaves '
                    f'{"it" if len(kept) == 1 else "them"} out, and approval writes nothing to '
                    f'{"it" if len(kept) == 1 else "them"}.')
        line.append(f'Kept {what} on {", ".join(kept)}')
    if took:
        said.append(f'Took back {change} on {", ".join(took)}: '
                    f'{"it keeps" if len(took) == 1 else "they keep"} {stays}.')
        line.append(f'Took back {change} on {", ".join(took)}')


def _planned_value(ws: Workspace, layer_id: str, w: Word, field: str) -> str:
    """The word's value of a single-valued field once the plan runs."""
    for op in reversed(ws.ops):
        if op.get('kind') == 'set_span' and op.get('layer_id') == layer_id and op.get('token_id') == w.id:
            return op.get('value') or ''
    sp = w.fields.get(field)
    return sp.value if sp else ''


def _same_form_left(ws: Workspace, doc: UdDoc, words: List[Word], holds=lambda o: False) -> str:
    """The words of the same form in the same sentence that a change by
    reference leaves out, said after it. Asked to retag "de" in a sentence
    holding six, a model changed the first and never saw the other five, so
    the user was neither asked which one nor told. A word that ``holds``
    the value written already, stored or planned, is as the user wants it
    either way, and is not named (the bench's commas found by their UPOS)."""
    named = {w.id for w in words}
    notes = []
    seen = set()
    for w in words:
        s = ws.sentence_of(doc, w)
        key = (s.index, w.form.casefold())
        if key in seen:
            continue
        seen.add(key)
        rest = [o for o in s.words if o.id not in named and o.form.casefold() == key[1] and not holds(o)]
        if rest:
            notes.append(f's{s.index} also has "{clip(w.form)}" at ' + ', '.join(f'w{o.index}' for o in rest))
    if not notes:
        return ''
    more = f', and {len(notes) - 3} more sentences' if len(notes) > 3 else ''
    return (' Not in this plan: ' + '; '.join(notes[:3]) + more + '. If the user named the word by its form '
            'alone, they did not say which: discard_plan and ask them.')


def _pairs(bundle: str) -> Dict[str, str]:
    """A FEATS string as ``{feature: value}``, each pair read as the app reads
    one. A pair it cannot read, or a feature named twice, is refused."""
    out: Dict[str, str] = {}
    for raw in (bundle or '').split('|'):
        if not raw.strip():
            continue
        # A read marks each pair on its own ("Mood=Ind~|Number=Plur").
        raw = unmark(raw, 'feature')
        pair = normalize_feature(raw)
        if not pair:
            raise ToolError(f'"{raw}" is not a feature: write each one as Feature=Value, '
                            f'joined by |, e.g. Case=Nom|Number=Sing.', kind='invalid-argument')
        refusal = feature_refusal(pair[2])
        if refusal:
            raise ToolError(f'"{raw}": {refusal}', kind='invalid-argument')
        if pair[0] in out:
            raise ToolError(f'{pair[0]} is named twice. A word holds one value of each feature.',
                            kind='invalid-argument')
        out[pair[0]] = pair[1]
    return out


def _check_feature(ws: Workspace, feature: str, value: str) -> None:
    """Refuse a pair a CLOSED feature inventory does not list."""
    inventory = ws.project.vocab.get('feats') or {}
    if not (inventory and ws.project.modes.get('feats') == 'closed' and value):
        return
    if feature not in inventory:
        raise ToolError(f'"{feature}" is not in this project\'s feature inventory, which is closed. '
                        f'Features: ' + ', '.join(sorted(inventory)), kind='invalid-argument')
    allowed = inventory.get(feature) or []
    if allowed and value not in allowed:
        raise ToolError(f'"{value}" is not a value of {feature} here. Allowed: ' + ', '.join(allowed),
                        kind='invalid-argument')


def _is_feature_op(op: Dict[str, Any], layer_id: str, word_id: str) -> bool:
    return (op.get('kind') == 'set_span' and op.get('layer_id') == layer_id
            and op.get('token_id') == word_id and op.get('feature') is not None)


def _planned_features(ws: Workspace, layer_id: str, w: Word) -> Dict[str, str]:
    """The word's features once the plan runs, ``{feature: value}``: what is
    stored, with every planned write to one of its pairs applied."""
    out: Dict[str, str] = {}
    for sp in w.features:
        pair = normalize_feature(sp.value)
        if pair:
            out[pair[0]] = pair[1]
    for op in ws.ops:
        if _is_feature_op(op, layer_id, w.id):
            pair = normalize_feature(op.get('value'))
            if pair:
                out[op['feature']] = pair[1]
            else:
                out.pop(op['feature'], None)
    return out


def _feature_ops(ws: Workspace, doc: UdDoc, layer_id: str, w: Word,
                 want: Dict[str, Optional[str]]) -> tuple:
    """What a word needs for its features to be ``want`` (a value, or None to
    remove one): ``(ops to stage, planned ops to drop)``. Each feature is its
    own span, so a change is a create, an update or a delete of the one span
    holding that feature, as the app's FEATS cell writes it. Wanting what is
    stored drops the planned change to that feature (removing a feature only
    this plan adds, or putting back a stored one this plan removes), or, where
    a corpus-wide change in the plan would change that pair, keeps it out of
    that change (core.keep)."""
    planned = _planned_features(ws, layer_id, w)
    sentence = ws.sentence_of(doc, w)
    ref = word_ref(sentence, w)
    stage, drop = [], []
    for key, value in want.items():
        sp = w.feature_span(key)
        stored = (normalize_feature(sp.value) or (None, None))[1] if sp is not None else None
        if (value or None) == stored:
            # Back to what is stored: drop the planned change rather than
            # stage a write of the span's own value, which an approved plan
            # would stamp verified.
            mine = [op for op in ws.ops if ws.op_target(op) == ('span', layer_id, w.id, key)]
            if stored is not None and scope_taking(ws.ops, doc.id, sentence, w, FEATURES, sp):
                if not any(is_keep(op) for op in mine):
                    stage.append(keep.op(('span', layer_id, w.id, key), f'{key}={stored} stays',
                                         document_id=doc.id, ref=ref, field=FEATURES, feature=key))
            else:
                drop += mine
            continue
        if (planned.get(key) or None) == (value or None):
            continue
        stage.append({'kind': 'set_span', 'layer_id': layer_id, 'token_id': w.id,
                      'span_id': sp.id if sp else None, 'value': f'{key}={value}' if value else '',
                      'field': FEATURES, 'feature': key, 'document_id': doc.id, 'ref': ref,
                      'label': f'{key}={value}' if value else f'remove {key}'})
    return stage, drop


def _stage_features(ws: Workspace, changes: List[tuple]) -> tuple:
    """Stage every word's feature ops as one batch, then drop the planned adds
    a removal undoes. The refs of the words that change, of those with a
    pair kept out of a corpus-wide change, and of those whose planned change
    was only taken back, in order."""
    ws.add_ops([op for _ref, stage, _drop in changes for op in stage])
    ws.take_back([op for _ref, _stage, drop in changes for op in drop])
    changed = [ref for ref, stage, drop in changes if any(not is_keep(op) for op in stage)]
    kept = [ref for ref, stage, drop in changes if any(is_keep(op) for op in stage)]
    took = [ref for ref, stage, drop in changes if any(not is_keep(op) for op in drop) and not stage]
    return changed, kept, took


def _set_features(ws: Workspace, doc: UdDoc, layer_id: str, refs, value: str) -> str:
    """set_field on features: the word's whole FEATS becomes ``value``. Each
    pair is its own span, so this writes the pairs that differ and removes
    the ones ``value`` leaves out."""
    # A read prints "_" for a word with no features, as CoNLL-U does.
    pairs = _pairs('' if value.strip() == '_' else value)
    for k, v in pairs.items():
        _check_feature(ws, k, v)
    words = _words(ws, doc, refs)
    changes = []
    for w in words:
        planned = _planned_features(ws, layer_id, w)
        want: Dict[str, Optional[str]] = {k: None for k in planned if k not in pairs}
        want.update(pairs)
        stage, drop = _feature_ops(ws, doc, layer_id, w, want)
        changes.append((word_ref(ws.sentence_of(doc, w), w), stage, drop))
    changed, kept, took = _stage_features(ws, changes)
    bundle = '|'.join(sorted((f'{k}={v}' for k, v in pairs.items()), key=feats_order))
    if not (changed or kept or took):
        return (f'Nothing to change: features are already "{bundle}" on every word named.' if bundle
                else 'Nothing to change: none of the words named has features.')
    what = f'features = "{bundle}"' if bundle else 'features cleared'
    said, line = [], []
    if changed:
        said.append(f'Planned {what} on {len(changed)} word(s): ' + ', '.join(changed))
        line.append(f'Planned {what} on ' + ', '.join(changed))
    _keep_said(said, line, kept, took, f'features "{bundle}"' if bundle else 'no features',
               'the planned features change', f'"{bundle}"' if bundle else 'no features')
    if kept or took:
        ws.step_label = '. '.join(line)
    return _joined(said)


def t_set_feature(ws: Workspace, document: str = None, refs=None, feature: str = None,
                  value: str = None) -> str:
    """PLAN: one Feature=Value on each word named, leaving its other features
    as they are. set_field on features replaces them all."""
    feature = (feature or '').strip()
    if not feature or '=' in feature or '|' in feature:
        raise ToolError('Give feature: one feature name, like Number (the value goes in value).',
                        kind='invalid-argument')
    value = '' if value is None else unmark(str(value), 'value').strip()
    if value:
        refusal = feature_refusal(f'{feature}={value}')
        if refusal or '|' in value:
            raise ToolError(refusal or 'Give value: one value, like Sing. Set each feature on its own.',
                            kind='invalid-argument')
    _check_feature(ws, feature, value)
    doc = ws.doc(document)
    layer_id = ws.project.layer(FEATURES)
    words = _words(ws, doc, refs)
    changes = []
    for w in words:
        stage, drop = _feature_ops(ws, doc, layer_id, w, {feature: value or None})
        changes.append((word_ref(ws.sentence_of(doc, w), w), stage, drop))
    changed, kept, took = _stage_features(ws, changes)
    if not (changed or kept or took):
        return (f'Nothing to change: {feature}={value} is already set on every word named.' if value
                else f'Nothing to change: none of the words named has {feature}.')
    what = f'{feature}={value}' if value else f'{feature} removed'
    said, line = [], []
    if changed:
        said.append(f'Planned {what} on {len(changed)} word(s): ' + ', '.join(changed) + _same_form_left(
            ws, doc, words, lambda o: _planned_features(ws, layer_id, o).get(feature) == (value or None)))
        line.append(f'Planned {what} on ' + ', '.join(changed))
    _keep_said(said, line, kept, took, f'{feature}={value}' if value else f'no {feature}',
               f'the planned {feature} change', f'{feature}={value}' if value else f'no {feature}')
    if kept or took:
        ws.step_label = '. '.join(line)
    return _joined(said)


def _head_id(head, doc: Optional[UdDoc] = None, sentence: Optional[Sentence] = None,
             ws: Optional[Workspace] = None) -> int:
    """The head argument as a word number.

    Every other argument in this module is a reference, so a model reaches for
    one ("w3", "s3.w3") before it reaches for a bare number. Either names one
    word of the dependent's own sentence, so either is read as that word's
    number; a reference into another sentence is refused, since a relation
    never crosses one. A plain number goes through `core.args.whole`, the one
    reader of a number a model wrote: it refuses a fraction rather than
    truncating it (2.7 is not word 2), refuses True, and refuses "\u00b2",
    which `isdigit` calls a digit and `int` then complains about in Python's
    own words.
    """
    try:
        return whole(head, 'head')
    except ValueError:
        pass
    text = str(head).strip() if isinstance(head, str) else ''
    if text and sentence is not None and doc is not None:
        if re.match(r'(?i)w\s*\d', text):
            text = f's{sentence.index}.{text}'
        r = read_ref(text, 'w', ranged=True)
        if r is not None and (r.parts[0] or r.by_form):
            if r.sentence != sentence.index:
                raise ToolError(f'"{head}" is in s{r.sentence}, and a head is a word of the same sentence '
                                f'(s{sentence.index}). Give its number there: {words_listing(sentence)}.',
                                kind='invalid-argument')
            thing = resolve_in(ws, doc, text) if ws is not None else resolve(doc, text)
            if isinstance(thing, Word):
                return thing.index
            raise ToolError(f'"{head}" is a multi-word token. A head is one of its words: '
                            + ', '.join(f'{w.index} ("{clip(w.form)}")' for w in thing.words) + '.',
                            kind='invalid-argument')
    raise ToolError(f'"{head}" is not a head. Give the number the head word carries within its own sentence '
                    '(1, 2, 3 …), or 0 for the root.'
                    + (f' s{sentence.index} has: {words_listing(sentence)}.' if sentence is not None else ''),
                    kind='invalid-argument')


def _other_roots(ws: Workspace, sentence: Sentence, word: Word) -> List[Word]:
    """The words of ``sentence`` other than ``word`` that are its root once
    the plan as it stands is applied: a stored root the plan gives no head
    and does not unhead, and a word the plan makes the root."""
    roots = {w.id for w in sentence.words if w.relation_id and w.head == 0}
    for o in ws.ops:
        if o.get('kind') == 'set_head':
            if o.get('head_id') == o.get('word_id'):
                roots.add(o['word_id'])
            else:
                roots.discard(o.get('word_id'))
        elif o.get('kind') == 'del_relation':
            roots.discard(o.get('word_id'))
    return [w for w in sentence.words if w.id in roots and w.id != word.id]


def t_set_head(ws: Workspace, document: str = None, ref: str = None, head=None,
               deprel: str = None, old_root_head=None, old_root_deprel: str = None) -> str:
    doc = ws.doc(document)
    word = _words(ws, doc, [ref])[0]
    sentence = ws.sentence_of(doc, word)
    if head is not None and _head_id(head, doc, sentence, ws) == 0:
        # A sentence has one root. A second is never staged: the old root
        # takes the head the model names for it, in the same plan and after
        # the new root (so the tree's cycle rule sees the new root first), or
        # the call is refused.
        others = _other_roots(ws, sentence, word)
        if len(others) > 1:
            raise ToolError(f's{sentence.index} already has {len(others)} roots ('
                            + ', '.join(word_ref(sentence, w) for w in others)
                            + '). Give each of them a head first (set_head).', kind='conflict')
        if others and old_root_head is None:
            old = others[0]
            raise ToolError(f'{word_ref(sentence, old)} ("{old.form}") is the root of s{sentence.index}, and a '
                            f'sentence has one. To make {word_ref(sentence, word)} the root instead, say where '
                            f'{word_ref(sentence, old)} goes: old_root_head (its new head\'s id, often '
                            f'{word.index}) and old_root_deprel.', kind='invalid-argument')
        if others:
            old = others[0]
            if not (old_root_deprel or '').strip():
                raise ToolError('Give old_root_deprel: the relation the old root takes to its new head.',
                                kind='invalid-argument')
            if _head_id(old_root_head, doc, sentence, ws) == 0:
                raise ToolError('old_root_head is the old root\'s new head word, not 0: a sentence has one root.',
                                kind='invalid-argument')
            if _head_id(old_root_head, doc, sentence, ws) == old.index:
                # Said in the parameter's terms: "A word cannot be its own
                # head" read as being about the new root, and a model gave up.
                raise ToolError(f'old_root_head {old.index} is {word_ref(sentence, old)} ("{old.form}") itself. '
                                f'old_root_head is the word {word_ref(sentence, old)} will hang from once '
                                f'{word_ref(sentence, word)} is the root, often {word.index}. Nothing was planned.',
                                kind='invalid-argument')
            with ws.staging():
                note = _stage_head(ws, doc, word, sentence, head, deprel)
                old_note = _stage_head(ws, doc, old, sentence, old_root_head, old_root_deprel)
            return f'{note} {old_note}'
    elif old_root_head is not None or old_root_deprel:
        raise ToolError('old_root_head and old_root_deprel go with head 0, when another word is the root.',
                        kind='invalid-argument')
    return _stage_head(ws, doc, word, sentence, head, deprel)


def _stage_head(ws: Workspace, doc: UdDoc, word: Word, sentence: Sentence, head, deprel: Optional[str]) -> str:
    """Stage ``word``'s head ``head`` (a CoNLL-U id, 0 for the root) with
    ``deprel``, refusing what a tree cannot hold."""
    ref = word_ref(sentence, word)
    if head is None:
        raise ToolError('Give head: the CoNLL-U id of the head word in the same sentence, or 0 for the root.',
                        kind='invalid-argument')
    given = head
    head = _head_id(head, doc, sentence, ws)
    if head and sentence.word(head) is None:
        raise ToolError(planned_word_refusal(ws, doc, sentence, head, f's{sentence.index}.w{head}')
                        or f'Sentence s{sentence.index} has no word {head}. Its words: '
                        f'{words_listing(sentence)}.', kind='not-found')
    # A head given as a plain number names a word by its number now, as a
    # reference does, and is refused the same way where this plan renumbers
    # it. One given as a reference was read by `resolve_in` already.
    try:
        whole(given, 'head')
        plain = True
    except ValueError:
        plain = False
    note = plain and head and renumbered_refusal(ws, doc, sentence, head, f'Head {head}')
    if note:
        raise ToolError(note, kind='conflict')
    if head == word.index:
        raise ToolError(f'A word cannot be its own head. Use head 0 to make {ref} the root of s{sentence.index}.',
                        kind='invalid-argument')
    deprel = unmark(deprel or '', 'deprel').strip()
    if head == 0 and not deprel:
        deprel = 'root'
    if not deprel:
        raise ToolError('Give deprel: the relation label, e.g. nsubj, obj, det.', kind='invalid-argument')
    if head == 0 and deprel != 'root':
        raise ToolError(f'Head 0 is the sentence root, whose deprel is "root", not "{deprel}".',
                        kind='invalid-argument')
    if head != 0 and deprel == 'root':
        raise ToolError('The deprel "root" belongs to head 0. Give the head word\'s id.', kind='invalid-argument')
    head_word = sentence.word(head) if head else word
    lemma, head_lemma = word.fields.get('lemma'), head_word.fields.get('lemma')
    # The suppressors this write leaves stranded: the one over the relation it
    # replaces, and one already lying over the pair it creates, which would
    # otherwise leave the new relation faded and the word with no enhanced
    # head. The editor's `createRelation` clears both. A RELABEL (same head)
    # strands nothing: the pair stays, and so does whatever the enhanced graph
    # says about it, as in the editor's `updateRelation`.
    relabel = bool(word.relation_id) and word.head == head
    stale = [] if relabel else [
        word.suppressor_id,
        doc.suppressor_over(head_lemma.id if head_lemma else None, lemma.id if lemma else None)]
    op = {'kind': 'set_head', 'word_id': word.id, 'head_id': head_word.id,
               'lemma_layer_id': ws.project.layer('lemma'),
               'relation_layer_id': ws.project.relation_layer_id,
               'word_form': word.form, 'head_form': head_word.form,
               # A dependency hangs off the lemma spans, so a word with no
               # lemma yet needs one made before the relation can exist.
               'lemma_span_id': lemma.id if lemma else None,
               'head_lemma_span_id': head_lemma.id if head_lemma else None,
               'relation_id': word.relation_id, 'deprel': deprel, 'document_id': doc.id,
               'suppressor_ids': [i for i in dict.fromkeys(stale) if i],
               # The same head: the stored relation takes the new label.
               **({'relabel': True} if relabel else {}),
               'label': (f'{word_ref(sentence, word)} root' if head == 0
                         else f'{word_ref(sentence, word)} {deprel} of word {head}'),
               'ref': word_ref(sentence, word)}
    if relabel and word.deprel == deprel:
        return _restated_head(ws, doc, word, sentence, op, head, head_word)
    ws.add_op(op)
    if head == 0:
        return f'Planned {word_ref(sentence, word)} ("{word.form}") as the root of s{sentence.index}.'
    return (f'Planned {word_ref(sentence, word)} ("{word.form}") as {deprel} of '
            f'word {head} ("{head_word.form}").')


def _restated_head(ws: Workspace, doc: UdDoc, word: Word, sentence: Sentence, op: Dict[str, Any], head: int,
                   head_word: Word) -> str:
    """set_head to the head and relation the word already has. Planning it
    would restate it and restamp its provenance as the plan's (Eline
    2026-10-07). A change planned for its head is taken back, and where a
    corpus-wide change in the plan would discard or relabel the relation,
    a keep holds it out of that change without writing (core.keep, Luke
    2026-10-16). Otherwise there is nothing to change."""
    ref = word_ref(sentence, word)
    stays = f'the root of s{sentence.index}' if head == 0 else f'{op["deprel"]} of word {head} ("{head_word.form}")'
    at = ws.replacing(op)
    if scope_taking(ws.ops, doc.id, sentence, word, 'deprel'):
        if at is None or not is_keep(ws.ops[at]):
            ws.add_op(keep.op(('head', word.id), f'{ref} stays ' + ('root' if head == 0 else
                                                                   f'{op["deprel"]} of word {head}'),
                              entity_key=('relation', word.relation_id), document_id=doc.id, ref=ref))
            ws.step_label = f'Kept {ref} as {stays}'
            return (f'Kept {ref} ("{word.form}") as {stays}: the corpus-wide change in the plan leaves it out, '
                    'and approval writes nothing to it.')
    elif at is not None and is_keep(ws.ops[at]):
        # Nothing left to keep it out of: it planned nothing to take back.
        ws.take_back([ws.ops[at]])
    elif at is not None:
        ws.take_back([ws.ops[at]])
        ws.step_label = f'Took back the planned change to the head of {ref}'
        return f'Took back the planned change to the head of {ref} ("{word.form}"): it stays {stays}.'
    return f'Nothing to change: {ref} ("{word.form}") is already {stays}.'


def t_del_relation(ws: Workspace, document: str = None, refs=None) -> str:
    doc = ws.doc(document)
    words = _words(ws, doc, refs)
    headless = [w for w in words if not w.relation_id]
    if len(headless) == len(words):
        return 'Nothing to remove: ' + ', '.join(
            word_ref(ws.sentence_of(doc, w), w) for w in words) + ' already have no head.'
    ws.add_ops([{'kind': 'del_relation', 'word_id': w.id, 'relation_id': w.relation_id,
                 'document_id': doc.id,
                 # The suppressor over it goes with it (see Word.suppressor_id).
                 'suppressor_ids': [w.suppressor_id] if w.suppressor_id else [],
                 'label': f'remove the head of {word_ref(ws.sentence_of(doc, w), w)}',
                 'ref': word_ref(ws.sentence_of(doc, w), w)}
                for w in words if w.relation_id])
    n = len(words) - len(headless)
    return f'Planned removing the head of {n} word(s).'


# --- review -------------------------------------------------------------------
#
# Named words get one op per value. A whole document gets ONE op, a scope
# (the document and the fields), found again at approval: see review.py.

def _review_fields(field: str) -> List[str]:
    fields = [field] if field else list(REVIEW_FIELDS)
    for f in fields:
        if f not in REVIEW_FIELDS:
            raise ToolError(f'Unknown field "{f}". One of: ' + ', '.join(REVIEW_FIELDS), kind='invalid-argument')
    return fields


def _named(ws: Workspace, doc: UdDoc, refs) -> List[tuple]:
    words = _words(ws, doc, refs)
    return [(ws.sentence_of(doc, w), w) for w in words]


def _whole_document(ws: Workspace, doc: UdDoc) -> List[tuple]:
    """Every word, with the refusals `_words` would have made. The scope op
    this feeds is refused against a reshape of the same document when it is
    staged, which is where every other path into that rule goes too."""
    _guards(ws, doc)
    return all_words(doc)


def _scope_fields(ws: Workspace, kind: str, doc: UdDoc, fields: List[str]) -> List[str]:
    """The fields a scope op on this document ends up covering: a second call
    widens the first rather than replacing it (add_op replaces by target)."""
    for op in ws.ops:
        if op.get('kind') == kind and op.get('document_id') == doc.id:
            return [f for f in REVIEW_FIELDS if f in set(op.get('fields') or []) | set(fields)]
    return fields


def _refs_need_a_document(document, refs) -> None:
    """A reference is positional inside one document, so refs without a
    document to read them against are a request that cannot be answered."""
    if refs and not document:
        raise ToolError('refs need a document', kind='invalid-argument')


def _scope_documents(ws: Workspace, documents, kind: str, fields: List[str]) -> List[str]:
    """The document ids a many-document review covers: the ones named, or
    every document with something waiting when ``documents`` is "all"."""
    if isinstance(documents, list) and len(documents) == 1 and str(documents[0]).strip().lower() == 'all':
        documents = 'all'
    if isinstance(documents, str) and documents.strip().lower() == 'all':
        c = ws.corpus
        stamps = [{'prov': 'inferred'}] + ([{'prov': 'contributed'}] if kind == 'confirm' else [])
        ids: List[str] = []
        for f in fields:
            for stamp in stamps:
                # A head is a relation, not a span, so it is found on its own
                # layer. Skipping it meant confirm(documents=["all"],
                # field="deprel") always answered that nothing was waiting.
                if f == 'deprel':
                    where = [c.dep('?s', metadata=stamp), c.unconfirmed_relation('?s')]
                else:
                    where = [c.field(f, '?s', metadata=stamp), c.unconfirmed('?s')]
                for did, _n in c.documents_with(where, '?s'):
                    if did not in ids:
                        ids.append(did)
        if not ids:
            raise ToolError('Nothing is waiting for review anywhere in the project.', kind='not-found')
    else:
        if isinstance(documents, str):
            documents = [documents]
        ids = []
        for d in documents or []:
            did = ws.resolve_document_id(str(d))
            if did not in ids:
                ids.append(did)
        if not ids:
            raise ToolError('Name the documents as a list, or "all" for every document with something waiting.',
                            kind='invalid-argument')
    if len(ids) > MAX_SCOPE_DOCS:
        raise ToolError(f'{len(ids)} documents, more than the {MAX_SCOPE_DOCS} one plan covers. Go in passes: '
                        f'worklist lists them by document.', kind='too-large')
    return ids


def _many(ws: Workspace, documents, field: str, one) -> str:
    """Run a one-document review tool over several documents, and sum up.

    All of them or none. A guard firing on the third document used to leave the
    first two staged while the model was told the call had failed, so the user
    was offered changes nobody had described to them.
    """
    fields = _review_fields(field)
    kind = 'confirm' if one is t_confirm else 'discard'
    ids = _scope_documents(ws, documents, kind, fields)
    planned = 0
    theirs = 0
    per_doc: List[str] = []  # one name per value, for the exact count by document
    with ws.staging():
        for did in ids:
            before = len(ws.ops)
            one(ws, document=did, field=field)
            if len(ws.ops) > before:
                n = ws.ops[-1].get('count') or 0
                theirs += ws.ops[-1].get('contributed_count') or 0
                planned += n
                per_doc += [doc_label(ws, did)] * n
    if not per_doc:
        return f'Nothing is waiting for review in the {len(ids)} document(s) named.'
    verb = 'confirming' if kind == 'confirm' else 'discarding'
    reviewed = (confirm_preview(planned - theirs, theirs) + ' '
                if kind == 'confirm' and ws.requester_reviewed() else '')
    return (f'Planned {verb} {planned} value(s), one planned change per document. ' + reviewed
            + by_document(per_doc))


def t_confirm(ws: Workspace, document: str = None, refs=None, field: str = None, documents=None) -> str:
    """Mark machine output and contributors' work as reviewed and correct."""
    # refs name words INSIDE one document, so a request that gives refs and
    # several documents means two different things at once. IGT refuses it;
    # here the refs were silently dropped and the card offered whole documents
    # when the model had asked for one word.
    _refs_need_a_document(document, refs)
    if documents and not document:
        return _many(ws, documents, field, t_confirm)
    if not document:
        raise ToolError('Name a document, or documents: a list of names, or ["all"] for every document with '
                        'something waiting.', kind='invalid-argument')
    doc = ws.doc(document)
    fields = _review_fields(field)
    if refs:
        targets, left = confirm_targets(_named(ws, doc, refs), fields, ws.project)
        if not targets:
            return (' '.join(x for x in (left_phrase(left), 'Nothing else to confirm.') if x) if left
                    else 'Nothing to confirm: every value named is already a person\'s work or confirmed.')
        staged = []
        for sentence, w, f, span_id, relation_id, state in targets:
            ref = word_ref(sentence, w)
            staged.append({'kind': 'confirm', 'span_id': span_id, 'relation_id': relation_id,
                           'token_id': w.id, 'document_id': doc.id, 'ref': ref,
                           **contributed_work(state),
                           'label': f'confirm the head of {ref}' if f == 'deprel' else f'confirm {f} on {ref}'})
        ws.add_ops(staged)
        return (f'Planned confirming {len(targets)} value(s).' + _reviewed_phrase(ws, targets)
                + (f' {left_phrase(left)}' if left else ''))
    fields = _scope_fields(ws, 'confirm_scope', doc, fields)
    targets, left = confirm_targets(_whole_document(ws, doc), fields, ws.project)
    if not targets:
        return (f'{left_phrase(left)} Nothing else in {doc_label(ws, doc.id, qname)} is waiting for review.' if left
                else f'Nothing in {doc_label(ws, doc.id, qname)} is waiting for review.')
    counts = per_field(targets)
    off = f', {len(left)} off the list left unconfirmed' if left else ''
    from .settle import as_rule
    ws.add_op(as_rule(ws, {
        'kind': 'confirm_scope', 'document_id': doc.id, 'fields': fields,
        'count': len(targets), 'per_field': counts, 'ref': None,
        **({'contributed_count': k} if (k := sum(1 for t in targets if t[5] == 'contributed')) else {}),
        'label': f'confirm {len(targets)} values in {doc_label(ws, doc.id, qname)} ({counts_phrase(counts)}{off})'}))
    return (f'Planned confirming {len(targets)} value(s) in {doc_label(ws, doc.id, qname)}: {counts_phrase(counts)}. '
            f'That is one planned change covering the whole document.' + _reviewed_phrase(ws, targets)
            + (f' {left_phrase(left)}' if left else ''))


def _reviewed_phrase(ws: Workspace, targets) -> str:
    """What a confirmation does when the requester's work is reviewed, or ''
    for a verifier, whose approval marks it all verified."""
    if not ws.requester_reviewed():
        return ''
    theirs = sum(1 for t in targets if t[5] == 'contributed')
    return ' ' + confirm_preview(len(targets) - theirs, theirs)


def t_discard_predictions(ws: Workspace, document: str = None, refs=None, field: str = None,
                          documents=None) -> str:
    """Throw away machine output nobody has confirmed. A person's work and a
    confirmed value are never touched."""
    # refs name words INSIDE one document, so a request that gives refs and
    # several documents means two different things at once. IGT refuses it;
    # here the refs were silently dropped and the card offered whole documents
    # when the model had asked for one word.
    _refs_need_a_document(document, refs)
    if documents and not document:
        return _many(ws, documents, field, t_discard_predictions)
    if not document:
        raise ToolError('Name a document, or documents: a list of names, or ["all"] for every document with '
                        'unconfirmed machine values.', kind='invalid-argument')
    doc = ws.doc(document)
    fields = _review_fields(field)
    if refs:
        targets, spared = discard_targets(_named(ws, doc, refs), fields)
        staged = []
        for sentence, w, f, span, relation_id in targets:
            ref = word_ref(sentence, w)
            if f == 'deprel':
                staged.append({'kind': 'del_relation', 'word_id': w.id, 'relation_id': relation_id,
                               'document_id': doc.id, 'ref': ref,
                               'suppressor_ids': [w.suppressor_id] if w.suppressor_id else [],
                               'label': f'discard the unconfirmed head of {ref}'})
            else:
                staged.append({'kind': 'set_span', 'layer_id': span.layer_id, 'token_id': w.id,
                               'span_id': span.id, 'value': '', 'field': f, 'document_id': doc.id,
                               'feature': feature_key(f, span.value),
                               'ref': ref, 'label': f'discard the unconfirmed {f} on {ref}'})
        ws.add_ops(staged)
        n = len(targets)
    else:
        fields = _scope_fields(ws, 'discard_scope', doc, fields)
        targets, spared = discard_targets(_whole_document(ws, doc), fields)
        n = len(targets)
        if n:
            counts = per_field(targets)
            from .settle import as_rule, discard_label
            ws.add_op(as_rule(ws, {'kind': 'discard_scope', 'document_id': doc.id, 'fields': fields,
                                   'count': n, MANY: True, 'per_field': counts, 'ref': None,
                                   'label': discard_label(ws, doc.id, n, counts)}))
    spared_note = f' Left {spared} machine lemma(s) that anchor arcs a person drew.' if spared else ''
    if not n:
        if spared:
            return f'Nothing to discard: {spared} machine lemma(s) here anchor arcs a person drew.'
        return 'Nothing to discard: no unconfirmed machine values here.'
    from .bulk import KEEP_HINT
    scope_note = '' if refs else f' That is one planned change covering the whole of {doc_label(ws, doc.id, qname)}.' + KEEP_HINT
    return f'Planned discarding {n} unconfirmed machine value(s).{spared_note}{scope_note}'


# --- the plan so far -----------------------------------------------------------

# --- running the parser ----------------------------------------------------------
# The odd one out among the plan ops: it does not write anything itself, it
# asks another service to. It is a plan op all the same, because a parse
# rewrites documents and that is exactly the kind of thing a user should be
# approving rather than discovering.

def parse_services(ws: Workspace) -> List[dict]:
    """The parse services currently connected to this project."""
    from plaid_client.services import discover_services
    try:
        seen = discover_services(ws.client, ws.project.id) or []
    except Exception as e:  # noqa: BLE001 - the model reads the server's reason
        raise server_refused('The project\'s services', e)
    return [s for s in seen
            if s.get('online') and 'parse' in ((s.get('extras') or {}).get('tasks') or [])]


def t_run_parse(ws: Workspace, documents=None, language: str = None,
                overwrite: bool = False, service_id: str = None) -> str:
    _no_restore_planned(ws)
    if isinstance(documents, str):
        documents = [documents]
    if not documents:
        raise ToolError('Name the documents to parse, as a list.', kind='invalid-argument')
    online = parse_services(ws)
    if not online:
        raise ToolError('No parser is connected to this project right now. A parse cannot be '
                        'planned until the operator starts one.', kind='unavailable')
    if service_id:
        chosen = next((s for s in online if s.get('service_id') == service_id), None)
        if not chosen:
            raise ToolError(f'No connected parser "{service_id}". Connected: '
                            + ', '.join(s.get('service_id') for s in online), kind='not-found')
    elif len(online) > 1:
        raise ToolError('Several parsers are connected; name one in service_id: '
                        + ', '.join(f'{s.get("service_id")} ({s.get("service_name")})' for s in online),
                        kind='ambiguous')
    else:
        chosen = online[0]

    ids = []
    for d in documents:
        did = ws.resolve_document_id(d)
        if did not in ids:
            ids.append(did)   # named twice is parsed once
    if len(ids) > MAX_SCOPE_DOCS:
        raise ToolError(f'{len(ids)} documents, more than the {MAX_SCOPE_DOCS} one plan covers. '
                        f'Go in passes.', kind='too-large')
    # Names come from the document LIST, which is already in hand: reading
    # every named document just to write its name into a label cost a full
    # fetch per document, which on a corpus-sized parse is most of the call.
    listed = doc_labels(ws, qname)
    # A parse deletes and recreates a document's tokens, spans and relations.
    # Anything else this plan writes into the same document would be thrown
    # away by it, so the two cannot travel together.
    clash = set().union(*(docs_of_op(op) for op in ws.ops)) & set(ids) if ws.ops else set()
    if clash:
        names = ', '.join(listed.get(i, i) for i in clash)
        raise ToolError(f'This plan already changes {names}, and a parse rewrites a document from '
                        f'scratch, so those changes would be thrown away. Plan the parse on its own, '
                        f'or discard_plan and plan it alone.', kind='conflict')
    lang = (language or ws.project.language or '').strip()
    if not lang:
        raise ToolError('Give language: the project does not record one, and the parser needs to '
                        'know which models to load.', kind='invalid-argument')
    # The service coerces its request against its declared parameters, so a
    # language its enum leaves out would quietly become its default.
    declared = next((p for p in ((chosen.get('extras') or {}).get('parameters') or [])
                     if p.get('key') == 'language'), None)
    if declared and declared.get('type') == 'enum':
        offered = [o.get('value') for o in (declared.get('options') or [])]
        if offered and lang not in offered:
            raise ToolError(f'{chosen.get("service_name")} does not offer "{lang}". It offers: '
                            + ', '.join(offered) + '. Give language as one of these to parse '
                            'with that language\'s models.', kind='invalid-argument')
    names = [listed.get(i, i) for i in ids]
    ws.add_op({'kind': 'run_parse', 'document_ids': ids, 'service_id': chosen.get('service_id'),
               'project_id': ws.project.id, 'language': lang, 'overwrite': bool(overwrite),
               'label': (f'parse {len(ids)} document(s) with {chosen.get("service_name")} ({lang})'
                         + (', overwriting human work' if overwrite else '')),
               'ref': None})
    warn = (' It will overwrite annotations a person made or confirmed.' if overwrite
            else ' Sentences a person made or confirmed are left alone.')
    shown = ', '.join(names[:20]) + (f', … {len(names) - 20} more' if len(names) > 20 else '')
    return (f'Planned a parse of {len(ids)} document(s) with {chosen.get("service_name")} '
            f'in {lang}: ' + shown + '.' + warn
            + ' A parse rewrites a document, so it is the only kind of change in this plan.')
