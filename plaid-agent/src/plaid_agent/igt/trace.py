"""IGT's words for its own tools, for the trace next to a reply.

The counting, the summary line and the item shape are in
:mod:`plaid_agent.core.trace`. What a call DID is here, next to the tool table
in :mod:`.tools`, so a new tool is described where it is declared. A tool with
no line of its own falls back to its name, and ``test_trace.py`` fails if any
declared tool reaches that fallback.
"""

from typing import Any, Dict, List, Optional

from ..core.refs import read_ref
from ..core.scope import is_all
from ..core.trace import META, READ, count, in_doc as _in_one_doc, plural, q, tracer_for
from .toolkit import WEB_TOOLS, WRITE_TOOLS


def _named(a: Dict[str, Any]) -> List[str]:
    """The documents a call's ``documents`` names when it gives no
    ``document``, each once. A name given twice, or in another case, is one
    document. The turn hands over the documents as resolved (core.agent), so
    an id and a name of one document are one too."""
    docs = a.get('documents')
    if not docs or a.get('document'):
        return []
    docs = [docs] if isinstance(docs, str) else list(docs) if isinstance(docs, list) else []
    named: Dict[str, str] = {}
    for d in docs:
        named.setdefault(str(d).strip().casefold(), str(d).strip())
    return list(named.values())


def in_doc(a: Dict[str, Any]) -> str:
    """' in "<document>"', ' in 3 documents' for a read held to several
    (core/scope.py), or nothing when the call was project-wide."""
    docs = _named(a)
    if docs:
        return f' in {q(docs[0])}' if len(docs) == 1 else f' in {plural(len(docs), "document")}'
    return _in_one_doc(a)


def _action(a: Dict[str, Any]) -> str:
    """The action of a tool with several, as the tool reads it."""
    return str(a.get('action') or '').strip().lower()


def _entry(a: Dict[str, Any]) -> str:
    return q(a.get('entry_form') or a.get('entry_id'))


def _held(a: Dict[str, Any]) -> str:
    """A corpus-wide change's ``where``, as the trace says it."""
    w = a.get('where')
    if not isinstance(w, dict) or not w:
        return ''
    return ' where ' + ' and '.join(f'{k} is {q(v)}' for k, v in w.items())


#: What a reference names, by how deep it goes, singular and plural.
_PLACES = (('sentence', 'sentences'), ('word', 'words'), ('morpheme', 'morphemes'))


def _counted(a: Dict[str, Any]) -> str:
    """The places a call's ``refs`` name, counted by what they are: "2 words",
    "1 word and 2 morphemes". A reference that does not read as one is
    counted as a reference."""
    refs = a.get('refs')
    refs = refs if isinstance(refs, list) else [refs] if refs else []
    tally: Dict[tuple, int] = {}
    for ref in refs:
        r = read_ref(ref, 'wm')
        if r is None:
            place = ('reference', 'references')
        else:
            depth = 2 if r.parts[1] is not None else 1 if (r.parts[0] is not None or r.by_form) else 0
            place = _PLACES[depth]
        tally[place] = tally.get(place, 0) + 1
    if not tally:
        return plural(0, 'word')
    parts = [plural(n, one, many) for (one, many), n in tally.items()]
    return parts[0] if len(parts) == 1 else ', '.join(parts[:-1]) + ' and ' + parts[-1]


def _own(name: str, a: Dict[str, Any]) -> Optional[str]:
    """One past-tense line for a finished call of a tool of this app's own, or
    None for a shared one (:data:`core.trace.SHARED_DESCRIBE`)."""
    # --- reads ---------------------------------------------------------------
    if name == 'search':
        where = a.get('where') if a.get('where') and a['where'] != 'baseline' else 'the baseline'
        return f'Searched {where} for {q(a.get("pattern"))}{in_doc(a)}'
    if name == 'read_sentences':
        return f'Read sentences of {plural(count(a, "items"), "document")}'
    if name == 'read_lexicon':
        return 'Read the lexicon' + (f' for {q(a["pattern"])}' if a.get('pattern') else '')
    if name == 'concordance':
        scope = f' in {a["where"]}' if a.get('where') and a['where'] != 'morpheme' else ''
        return f'Concordanced {q(a.get("pattern"))}{scope}{in_doc(a)}'
    if name == 'analyses_of':
        forms = [f for f in ([a.get('form')] if a.get('form') else []) + list(a.get('forms') or []) if f]
        what = q(forms[0]) if len(forms) == 1 else plural(len(forms), 'form') if forms else q(None)
        held = f' and listed those holding {q(a["value"])}' if a.get('value') else ''
        return f'Tallied the analyses of {what}{held}{in_doc(a)}'
    if name == 'lexicon_entry':
        return f'Looked up the entry {_entry(a)}'
    if name == 'check_consistency':
        return f'Checked {a.get("field")} for consistency{in_doc(a)}'
    if name == 'corpus_stats':
        return 'Counted the corpus' + (f' by {a["by"]}' if a.get('by') else '') + in_doc(a)
    if name == 'frequency_list':
        n = a.get('ngram') if isinstance(a.get('ngram'), int) and a.get('ngram') > 1 else None
        unit = f'{a.get("what") or "wordform"} {"bigrams" if n == 2 else f"{n}-grams"}' if n else \
            f'{a.get("what") or "wordform"}s'
        return f'Ranked {unit} by frequency{_held(a)}{in_doc(a)}'
    if name == 'worklist':
        field = f'{a["field"]} ' if a.get('field') else ''
        return f'Listed {a.get("kind") or "unglossed"} {field}work{in_doc(a)}'
    if name == 'check_lexicon':
        return 'Checked the lexicon'
    if name == 'check_integrity':
        return f'Checked data integrity{in_doc(a)}'
    if name == 'sequence_search':
        return f'Searched for a word sequence{in_doc(a)}'

    # --- plans: one place at a time ------------------------------------------
    if name == 'set_field':
        if isinstance(a.get('values'), dict) and a['values']:
            sets = ', '.join(f'{k} = {q(v)}' for k, v in a['values'].items())
            return f'Planned {sets} on {_counted(a)}{in_doc(a)}'
        return f'Planned {a.get("field")} = {q(a.get("value"))} on {_counted(a)}{in_doc(a)}'
    if name == 'set_analysis':
        many = a.get('analyses') if isinstance(a.get('analyses'), list) else []
        if many and not a.get('ref'):
            return f'Planned new analyses for {plural(len(many), "word")}{in_doc(a)}'
        return f'Planned a new analysis for {a.get("ref")}{in_doc(a)}'
    if name == 'set_morpheme':
        bits = [b for b in (f'form {q(a["form"])}' if a.get('form') is not None else '',
                            f'type {q(a["type"])}' if a.get('type') is not None else '') if b]
        return f'Planned changing the morpheme {a.get("ref")}' + (': ' + ', '.join(bits) if bits else '') + in_doc(a)
    if name == 'link_phrase':
        return f'Planned a multi-word expression over {plural(count(a), "word")} for {_entry(a)}{in_doc(a)}'
    if name == 'unlink_phrase':
        return f'Planned removing a multi-word expression{in_doc(a)}'
    if name == 'set_orthography':
        return f'Planned {a.get("orthography")} = {q(a.get("value"))} on {plural(count(a), "word")}{in_doc(a)}'
    if name == 'respell':
        return f'Planned respelling {a.get("ref")} → {q(a.get("new_text"))}{in_doc(a)}'
    if name == 'link_entry':
        return f'Planned linking {_counted(a)} to {_entry(a)}{in_doc(a)}'
    if name == 'unlink_entry':
        return f'Planned unlinking {_counted(a)}{in_doc(a)}'
    if name == 'confirm':
        what = f' ({a["field"]})' if a.get('field') else ''
        scope = _counted(a) if a.get('refs') else 'everything awaiting review'
        docs = _named(a)
        if docs and is_all(a['documents']):
            across = ' across the project'
        elif len(docs) > 1:
            across = f' across {plural(len(docs), "document")}'
        else:
            across = in_doc(a) or (' across the project' if not a.get('refs') else '')
        return f'Planned confirming {scope}{what}{across}'
    if name == 'discard_analysis':
        return f'Planned discarding the unverified analysis of {_counted(a)}{in_doc(a)}'

    # --- plans: across the corpus --------------------------------------------
    if name == 'replace_in_field':
        return (f'Planned replacing {q(a.get("pattern"))} → {q(a.get("replacement"))} '
                f'in {a.get("field")}{_held(a)}{in_doc(a)}')
    if name == 'respell_all':
        return f'Planned respelling {q(a.get("pattern"))} → {q(a.get("replacement"))}{in_doc(a)}'
    if name == 'copy_to_orthography':
        return f'Planned filling {a.get("orthography")} from {a.get("source") or "the baseline"}{in_doc(a)}'
    if name == 'set_field_for_form':
        return f'Planned {a.get("field")} = {q(a.get("value"))} on every {q(a.get("form"))}{_held(a)}{in_doc(a)}'
    if name == 'set_analysis_for_form':
        return f'Planned an analysis for every {q(a.get("form"))}{in_doc(a)}'

    # --- plans: the lexicon ---------------------------------------------------
    if name == 'create_entry':
        return f'Planned a new lexicon entry {q(a.get("form"))}'
    if name == 'set_entry_field':
        return f'Planned {a.get("field")} = {q(a.get("value"))} on entry {_entry(a)}'
    if name == 'senses':
        act = _action(a)
        if act == 'help':
            return 'Read how to change the sense tree'
        if act == 'add':
            return f'Planned a sense under {_entry(a)}'
        if act == 'move':
            return f'Planned {_entry(a)} as sense {a.get("number")}'
        if act == 'order_homographs':
            return f'Planned an order for the entries spelled like {_entry(a)}'
        if act == 'free':
            return f'Planned freeing {_entry(a)} into an entry of its own'
        if act == 'promote_example':
            return f'Planned a usage example for {_entry(a)}{in_doc(a)}'
        if act == 'remove_example':
            return f'Planned dropping a usage example from {_entry(a)}'
        return f'Planned a change to the sense tree of {_entry(a)}'
    if name == 'make_sense_of':
        return f'Planned {_entry(a)} as a sense of {q(a.get("under_form") or a.get("under_id"))}'
    if name == 'merge_entries':
        return (f'Planned merging {q(a.get("remove_form") or a.get("remove_id"))} into '
                f'{q(a.get("keep_form") or a.get("keep_id"))}')
    if name == 'delete_entry':
        return f'Planned deleting the entry {_entry(a)}'
    if name == 'rename_entry':
        return f'Planned renaming the entry {_entry(a)} → {q(a.get("new_form"))}'

    # --- plans: documents and the shape of the text ---------------------------
    if name == 'set_document_metadata':
        return f'Planned {a.get("field")} = {q(a.get("value"))} on document {q(a.get("document"))}'
    if name == 'create_document':
        return f'Planned a new document {q(a.get("name"))}'
    if name == 'rename_document':
        return f'Planned renaming {q(a.get("document"))} → {q(a.get("new_name"))}'
    if name == 'split_word':
        return f'Planned splitting the word {a.get("ref")} at {q(a.get("at"))}{in_doc(a)}'
    if name == 'merge_words':
        return f'Planned merging {plural(count(a), "word")} into one{in_doc(a)}'
    if name == 'delete_word':
        return f'Planned deleting {plural(count(a), "word token")}{in_doc(a)}'
    if name == 'split_sentence':
        return f'Planned splitting {a.get("ref")} before word {a.get("before_word")}{in_doc(a)}'
    if name == 'merge_sentences':
        return f'Planned merging {a.get("ref")} into the sentence before it{in_doc(a)}'
    if name == 'append_text':
        return f'Planned adding text to the end of {q(a.get("document"))}'
    if name == 'retype_sentence':
        return f'Planned retyping {a.get("ref")}{in_doc(a)}'

    if name == 'app_guide':
        return 'Read the app guide' + (f' on {q(a["topic"])}' if a.get('topic') else ', its parts')

    # --- tagsets: one tool, the action says which ------------------------------
    if name == 'tagsets':
        act = _action(a)
        if act == 'help':
            return 'Read how to set up tagsets'
        if act == 'check':
            return f'Checked the tagset {q(a.get("tagset"))}'
        if act == 'assign':
            return f'Planned the tagset {q(a.get("tagset"))} on {q(a.get("field"))}'
        return f'Planned a change to the tagset {q(a.get("tagset"))}'

    return None


# --- while it is happening ------------------------------------------------------
# The same call, in the present tense, for the progress line the tab shows
# while the turn runs. Only the calls worth naming get a line of their own.

_PROGRESS = {
    'search': lambda a: f'Searching for "{a.get("pattern", "")}"…',
    'read_sentences': lambda a: 'Reading sentences…',
    'read_lexicon': lambda a: 'Reading the lexicon…',
    'concordance': lambda a: f'Concordancing "{a.get("pattern", "")}"…',
    'analyses_of': lambda a: f'Tallying analyses of "{a.get("form", "")}"…',
    'lexicon_entry': lambda a: f'Looking up "{a.get("entry_form") or a.get("form") or a.get("entry_id") or ""}"…',
    'check_consistency': lambda a: f'Checking {a.get("field", "")} consistency…',
    'corpus_stats': lambda a: 'Counting the corpus…',
    'frequency_list': lambda a: 'Counting frequencies…',
    'worklist': lambda a: f'Listing {a.get("kind") or "unfinished"} work…',
    'check_lexicon': lambda a: 'Checking the lexicon…',
    'tagsets': lambda a: 'Checking a tagset…' if _action(a) == 'check' else 'Working on tagsets…',
    'senses': lambda a: {'help': 'Reading how to change the sense tree…', 'add': 'Adding a sense…',
                         'move': 'Renumbering a sense…', 'free': 'Freeing a sense…',
                         'order_homographs': 'Ordering the entries spelled the same…',
                         'promote_example': 'Marking a usage example…',
                         'remove_example': 'Dropping a usage example…'}.get(_action(a), 'Working on senses…'),
    'make_sense_of': lambda a: 'Moving an entry under another…',
    'check_integrity': lambda a: 'Checking data integrity…',
    'sequence_search': lambda a: 'Searching for the sequence…',
    'app_guide': lambda a: 'Reading the app guide…',
}


# The tagsets tool plans with edit and assign, and only reads with help (its
# manual) and check.
_READING = {'tagsets': lambda a: {'help': META, 'check': READ}.get(_action(a)),
            'senses': lambda a: META if _action(a) == 'help' else None,
            'app_guide': lambda a: META}

TRACER = tracer_for(WEB_TOOLS, WRITE_TOOLS, _own, _PROGRESS, searches=('sequence_search', 'concordance'),
                    reading=_READING)
describe_step = TRACER.describe
