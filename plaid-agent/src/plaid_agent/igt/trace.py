"""IGT's words for its own tools, for the trace next to a reply.

The counting, the summary line and the item shape are in
:mod:`plaid_agent.core.trace`. What a call DID is here, next to the tool table
in :mod:`.tools`, so a new tool is described where it is declared. A tool with
no line of its own falls back to its name, and ``test_trace.py`` fails if any
declared tool reaches that fallback.
"""

from typing import Any, Dict, Optional

from ..core.trace import META, READ, count, in_doc, plural, q, tracer_for
from .toolkit import WEB_TOOLS, WRITE_TOOLS


def _entry(a: Dict[str, Any]) -> str:
    return q(a.get('entry_form') or a.get('entry_id'))


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
        return f'Tallied the analyses of {what}{in_doc(a)}'
    if name == 'lexicon_entry':
        return f'Looked up the entry {_entry(a)}'
    if name == 'check_consistency':
        return f'Checked {a.get("field")} for consistency{in_doc(a)}'
    if name == 'corpus_stats':
        return 'Counted the corpus' + (f' by {a["by"]}' if a.get('by') else '') + in_doc(a)
    if name == 'frequency_list':
        return f'Ranked {a.get("what") or "wordform"}s by frequency{in_doc(a)}'
    if name == 'worklist':
        field = f'{a["field"]} ' if a.get('field') else ''
        return f'Listed {a.get("kind") or "unglossed"} {field}work{in_doc(a)}'
    if name == 'check_lexicon':
        return 'Checked the lexicon'
    if name == 'check_integrity':
        return f'Checked data integrity{in_doc(a)}'
    if name == 'sequence_search':
        return f'Searched for a word sequence{in_doc(a)}'

    # --- plans: one item at a time -------------------------------------------
    if name == 'set_field':
        if isinstance(a.get('values'), dict) and a['values']:
            sets = ', '.join(f'{k} = {q(v)}' for k, v in a['values'].items())
            return f'Planned {sets} on {plural(count(a), "item")}{in_doc(a)}'
        return f'Planned {a.get("field")} = {q(a.get("value"))} on {plural(count(a), "item")}{in_doc(a)}'
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
        return f'Planned linking {plural(count(a), "item")} to {_entry(a)}{in_doc(a)}'
    if name == 'unlink_entry':
        return f'Planned unlinking {plural(count(a), "item")}{in_doc(a)}'
    if name == 'confirm':
        what = f' ({a["field"]})' if a.get('field') else ''
        scope = plural(count(a), 'item') if a.get('refs') else 'everything awaiting review'
        docs = a.get('documents')
        if docs and not a.get('document'):
            across = (' across the project' if isinstance(docs, str) or (len(docs) == 1 and str(docs[0]).lower() == 'all')
                      else f' across {plural(len(docs), "document")}')
        else:
            across = in_doc(a) or (' across the project' if not a.get('refs') else '')
        return f'Planned confirming {scope}{what}{across}'
    if name == 'discard_analysis':
        return f'Planned discarding the unverified analysis of {plural(count(a), "item")}{in_doc(a)}'

    # --- plans: across the corpus --------------------------------------------
    if name == 'replace_in_field':
        return (f'Planned replacing {q(a.get("pattern"))} → {q(a.get("replacement"))} '
                f'in {a.get("field")}{in_doc(a)}')
    if name == 'respell_all':
        return f'Planned respelling {q(a.get("pattern"))} → {q(a.get("replacement"))}{in_doc(a)}'
    if name == 'copy_to_orthography':
        return f'Planned filling {a.get("orthography")} from {a.get("source") or "the baseline"}{in_doc(a)}'
    if name == 'set_field_for_form':
        return f'Planned {a.get("field")} = {q(a.get("value"))} on every {q(a.get("form"))}{in_doc(a)}'
    if name == 'set_analysis_for_form':
        return f'Planned an analysis for every {q(a.get("form"))}{in_doc(a)}'

    # --- plans: the lexicon ---------------------------------------------------
    if name == 'create_entry':
        return f'Planned a new lexicon entry {q(a.get("form"))}'
    if name == 'set_entry_field':
        return f'Planned {a.get("field")} = {q(a.get("value"))} on entry {_entry(a)}'
    if name == 'add_sense':
        return f'Planned a sense under {_entry(a)}'
    if name == 'move_sense':
        return f'Planned {_entry(a)} as sense {a.get("number")}'
    if name == 'make_sense_of':
        return f'Planned {_entry(a)} as a sense of {q(a.get("under_form") or a.get("under_id"))}'
    if name == 'order_homographs':
        return f'Planned an order for the entries spelled like {_entry(a)}'
    if name == 'free_sense':
        return f'Planned freeing {_entry(a)} into an entry of its own'
    if name == 'promote_example':
        return f'Planned a usage example for {_entry(a)}{in_doc(a)}'
    if name == 'remove_example':
        return f'Planned dropping a usage example from {_entry(a)}'
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

    # --- tagsets: one tool, the action says which ------------------------------
    if name == 'tagsets':
        act = a.get('action')
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
    'tagsets': lambda a: 'Checking a tagset…' if a.get('action') == 'check' else 'Working on tagsets…',
    'add_sense': lambda a: 'Adding a sense…',
    'move_sense': lambda a: 'Renumbering a sense…',
    'make_sense_of': lambda a: 'Moving an entry under another…',
    'free_sense': lambda a: 'Freeing a sense…',
    'order_homographs': lambda a: 'Ordering the entries spelled the same…',
    'promote_example': lambda a: 'Marking a usage example…',
    'remove_example': lambda a: 'Dropping a usage example…',
    'check_integrity': lambda a: 'Checking data integrity…',
    'sequence_search': lambda a: 'Searching for the sequence…',
}


# The tagsets tool plans with edit and assign, and only reads with help (its
# manual) and check.
_READING = {'tagsets': lambda a: {'help': META, 'check': READ}.get(a.get('action'))}

TRACER = tracer_for(WEB_TOOLS, WRITE_TOOLS, _own, _PROGRESS, searches=('sequence_search', 'concordance'),
                    reading=_READING)
describe_step = TRACER.describe
