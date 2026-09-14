"""The tool table the model sees, and the dispatch behind it.

Every tool a treebank assistant may call is declared here once, beside the
function that implements it, and nowhere else. A tool that plans a change says
so in the first word of its description, which is what makes it one: there is
no second list to keep in step with this one.

This is the last module in the app to be imported: it reads every tool module,
so nothing here may be imported back by one of them.
"""

from typing import Any, Dict, List

from ..core import sandbox as _sandbox
from ..core import webtools
from ..core.webtools import t_read_url, t_web_search
from ..core.tools import ToolError, fn, tools_for as core_tools_for, truncate

from .bulk import t_replace_in_field
from .query import t_query, t_query_help
from .restore import t_restore_document
from .sandbox import t_code_help, t_run_code
from .sentences import t_merge_sentences, t_split_sentence
from .shape import t_set_words
from .stats import (COUNTABLE, CONSISTENCY, SEARCHABLE, WORKLIST_KINDS, t_check_consistency,
                    t_comments, t_frequency_list, t_recent_changes, t_search, t_worklist)
from .tools import (FIELDS, Workspace, t_add_comment, t_confirm, t_del_relation,
                    t_discard_plan, t_discard_predictions, t_drop_planned, t_list_documents,
                    t_plan_status, t_project_overview, t_read_document, t_run_parse, t_set_feature,
                    t_set_field, t_set_head)

# Offered only where the monty worker binary is present, and only where the
# operator configured a search backend (see tools_for): a model that cannot
# run code or look something up is never told that it can.
CODE_TOOLS = _sandbox.NAMES
WEB_TOOLS = webtools.NAMES

_fn = fn


# --- the tool table -------------------------------------------------------------

_DOC = {'type': 'string', 'description': 'Document id or exact name (see project_overview).'}
_REFS = {'type': 'array', 'items': {'type': 'string'},
         'description': 'Word references in the same document, e.g. ["s3.w2", "s3.w5"].'}
_FIELD = {'type': 'string', 'enum': list(FIELDS),
          'description': 'Which column: lemma, upos, xpos or features.'}

TOOLS = [
    _fn('project_overview',
        'The project: its language, its controlled vocabularies and whether each one is a rule or a '
        'suggestion, and its documents. Call this first.', {}, []),
    _fn('list_documents',
        'The documents by name, a page at a time, optionally filtered by a name substring.',
        {'pattern': {'type': 'string'}, 'limit': {'type': 'integer'}, 'offset': {'type': 'integer'}},
        []),
    _fn('read_document',
        'Read a document as tab-separated CoNLL-U rows: one line per word with its form, lemma, UPOS, '
        'XPOS, features, head and deprel, and a range line for each multi-word token. A value followed '
        'by ~ was made by a machine and nobody has confirmed it; ^ is a contributor\'s unreviewed work. '
        'Up to 40 sentences per call, fewer when they are long: the first line says which sentences '
        'were shown and where to continue. WHEN YOU ALREADY KNOW WHICH SENTENCES YOU NEED (a search '
        'told you, or an earlier read did), name them in `sentences` and get them all in ONE call. '
        'Paging a long document with from_sentence/to_sentence costs a call per page and will run out '
        'of steps before it runs out of document.',
        {'document': _DOC,
         'sentences': {'type': 'array', 'items': {'type': 'string'},
                       'description': 'Just these sentences, e.g. ["s34","s64","s104"]. A word '
                                      'reference like "s34.w2" names its sentence. Overrides the '
                                      'range below.'},
         'from_sentence': {'type': ['integer', 'string'],
                           'description': 'First sentence, 1-based: 3 or "s3" (default 1).'},
         'to_sentence': {'type': ['integer', 'string'],
                         'description': 'Last sentence, inclusive: 8 or "s8".'}},
        ['document']),
    _fn('set_field',
        'PLAN: set one annotation column on one or more words. An empty value clears it. features '
        'takes the whole set at once, in CoNLL-U form ("Case=Nom|Number=Sing").',
        {'document': _DOC, 'refs': _REFS, 'field': _FIELD,
         'value': {'type': 'string', 'description': 'The new value, or "" to clear the column.'}},
        ['document', 'refs', 'field']),
    _fn('set_feature',
        'PLAN: set or remove ONE Feature=Value inside the features of one or more words, keeping the '
        'rest of the bundle as it is (set_field replaces the whole bundle). An empty value removes the '
        'feature. The bundle is kept in CoNLL-U order.',
        {'document': _DOC, 'refs': _REFS,
         'feature': {'type': 'string', 'description': 'The feature name, e.g. Number.'},
         'value': {'type': 'string', 'description': 'The value, e.g. Sing; "" removes the feature.'}},
        ['document', 'refs', 'feature']),
    _fn('set_head',
        'PLAN: give one word its head and its relation to it. head is the CoNLL-U id of another word in '
        'the SAME sentence, or 0 to make this word the sentence root (deprel "root"). A word has one '
        'head, so this replaces whatever head it had.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The dependent word, e.g. "s3.w2".'},
         'head': {'type': 'integer', 'description': 'The head word\'s CoNLL-U id, or 0 for the root.'},
         'deprel': {'type': 'string', 'description': 'The relation label, e.g. nsubj, obj, det.'}},
        ['document', 'ref', 'head']),
    _fn('del_relation',
        'PLAN: leave one or more words with no head at all. Use set_head to re-attach instead whenever '
        'there is a head to give.',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('confirm',
        'PLAN: mark values as reviewed and correct, which is what clears the ~ and ^ marks. With refs, '
        'only those words; without, everything in the document that is waiting, as ONE planned change '
        'for the whole document. With field, only that column (deprel is allowed here too); without, '
        'all of them. Give `documents` instead of `document` to cover several at once: a list of '
        'names, or "all" for every document with something waiting (up to 100).',
        {'document': _DOC, 'refs': _REFS,
         'documents': {'type': 'array', 'items': {'type': 'string'},
                       'description': 'Several documents, by id or name; or ["all"].'},
         'field': {'type': 'string', 'enum': list(FIELDS) + ['deprel']}},
        []),
    _fn('discard_predictions',
        'PLAN: throw away machine values nobody has confirmed, so the columns go back to empty. A '
        'person\'s work and a confirmed value are never touched. Without refs it covers the whole '
        'document as one planned change; `documents` covers several, or "all".',
        {'document': _DOC, 'refs': _REFS,
         'documents': {'type': 'array', 'items': {'type': 'string'},
                       'description': 'Several documents, by id or name; or ["all"].'},
         'field': {'type': 'string', 'enum': list(FIELDS) + ['deprel']}},
        []),
    _fn('replace_in_field',
        'PLAN: substitute inside every value of one column that matches a pattern, across the whole '
        'project or in one document: rename a lemma everywhere, retag a deprel, fix a feature '
        'spelling. A literal substring unless regex is true; whole matches the whole value; case is '
        'ignored unless case_sensitive. Empty values are never filled. The plan holds it as ONE change '
        'with its count; search shows every match first.',
        {'field': {'type': 'string', 'enum': list(FIELDS) + ['deprel']},
         'pattern': {'type': 'string'},
         'replacement': {'type': 'string', 'description': 'With regex, \\1 refers to a group.'},
         'regex': {'type': 'boolean'}, 'whole': {'type': 'boolean'},
         'case_sensitive': {'type': 'boolean'}, 'document': _DOC},
        ['field', 'pattern', 'replacement']),
    _fn('run_parse',
        'PLAN: have the project\'s parser re-parse whole documents. This REWRITES each document '
        'from scratch (tokens, columns and tree), so it cannot share a plan with any other change '
        'to the same document, and it is the right tool only when a document should be parsed '
        'afresh, never for fixing particular words. overwrite=false leaves sentences a person made '
        'or confirmed alone.',
        {'documents': {'type': 'array', 'items': {'type': 'string'},
                       'description': 'Document ids or exact names.'},
         'language': {'type': 'string', 'description': 'Defaults to the project\'s own language.'},
         'overwrite': {'type': 'boolean'},
         'service_id': {'type': 'string', 'description': 'Only when several parsers are connected.'}},
        ['documents']),
    _fn('set_words',
        'PLAN: say which WORDS a token holds. Two or more makes it a multi-word token (Spanish '
        '"al" holding "a" and "el"); one collapses it back to a plain token. This REPLACES the '
        'token\'s words, so it discards their lemma, UPOS, XPOS, features and heads, and seeds '
        'each new word\'s lemma from its form. Use it to fix segmentation, never to change one '
        'value.',
        {'document': _DOC,
         'ref': {'type': 'string', 'description': 'The token: "s3.w2", or "s3.w2-3" if it is '
                                                  'already a multi-word token.'},
         'forms': {'type': 'array', 'items': {'type': 'string'},
                   'description': 'The words, in order, e.g. ["a", "el"].'}},
        ['document', 'ref', 'forms']),
    _fn('split_sentence',
        'PLAN: start a new sentence at this word, so the sentence it is in becomes two. Any '
        'dependency relation that would end up spanning the two is deleted, because a relation '
        'never crosses a sentence. Sentences after it renumber, so this is the ONLY change a '
        'plan may carry for this document: every other reference would move.',
        {'document': _DOC,
         'ref': {'type': 'string', 'description': 'The word the new sentence starts at, "s3.w5".'}},
        ['document', 'ref']),
    _fn('merge_sentences',
        'PLAN: join this sentence onto the one before it, so the two become one. Name the SECOND '
        'of them: "s3" joins s2 and s3. Nothing is lost, since merging only widens a sentence. '
        'Sentences after it renumber, so this is the ONLY change a plan may carry for this '
        'document.',
        {'document': _DOC,
         'ref': {'type': 'string', 'description': 'The second of the two sentences, "s3".'}},
        ['document', 'ref']),
    _fn('query_help',
        'The Plaid query language, and this project\'s layer names. Call it before writing a '
        'query; it costs nothing until you need it.', {}, []),
    _fn('query',
        'Run one read-only Plaid query over this project. The escape hatch for a question the '
        'other reads cannot express: two columns at once, adjacency, a join. Layers are named by '
        'name. Call query_help first.',
        {'query': {'type': 'object', 'description': 'The query object: find, where, return, limit, '
                                                    'order_by. See query_help.'},
         'limit': {'type': 'integer', 'description': 'Rows to show (default 50, max 500).'}},
        ['query']),
    _fn('restore_document',
        'PLAN: put a document back as it was at a moment in its history, every layer of it. The '
        'plan shows what would change, from the server\'s own dry run, so it is not a guess. '
        'Maintainers only. It rewrites the whole document, so it must be the ONLY change in its '
        'plan. recent_changes prints an as_of instant for every change.',
        {'document': _DOC,
         'as_of': {'type': 'string', 'description': 'An ISO-8601 instant, e.g. '
                                                    '2026-09-05T18:45:49Z.'}},
        ['document', 'as_of']),
    _fn('plan_status', 'Every change planned so far in this turn, numbered.', {}, []),
    _fn('discard_plan', 'Throw away everything planned so far and start the plan over.', {}, []),
    _fn('drop_planned', 'Drop some of the planned changes by their numbers from plan_status.',
        {'indexes': {'type': 'array', 'items': {'type': 'integer'}}}, ['indexes']),
]

TOOLS += [
    _fn('search',
        'Words whose column matches a pattern, each shown in its context with the hit in brackets. '
        'Searches the whole project unless a document is named: the first line gives the total '
        'and how many documents have hits, and the hits shown are a few from each of several '
        'documents, not every hit from one. Name a document to see every hit in it.',
        {'field': {'type': 'string', 'enum': list(SEARCHABLE)},
         'pattern': {'type': 'string', 'description': 'A literal substring unless regex is true.'},
         'document': _DOC, 'whole': {'type': 'boolean', 'description': 'Match the whole value only.'},
         'regex': {'type': 'boolean'}, 'limit': {'type': 'integer'},
         'case_sensitive': {'type': 'boolean', 'description': 'Match case too (off: "the" finds "The"). '
                                                              'The same switch replace_in_field takes.'}},
        ['field', 'pattern']),
    _fn('frequency_list',
        'The commonest values of one column, with counts. Across the project, or inside one document. '
        '"features" counts each Feature=Value on its own; "feature-bundles" counts whole FEATS strings '
        'as stored.',
        {'what': {'type': 'string', 'enum': list(COUNTABLE)}, 'document': _DOC,
         'limit': {'type': 'integer'}}, ['what']),
    _fn('check_consistency',
        'Places where the corpus disagrees with itself: one lemma under several UPOS, one form under '
        'several lemmas, deprel and UPOS pairs seen once or twice. Every hit is a question, not a '
        'verdict: read the sentences before planning anything.',
        {'kind': {'type': 'string', 'enum': list(CONSISTENCY)}, 'limit': {'type': 'integer'}}, []),
    _fn('worklist',
        'What is unfinished. kind "unverified" is machine output nobody has confirmed, '
        '"contributed" a contributor\'s unreviewed work, "missing" words with no value in a '
        'column at all. Without a document it counts per document, so a session has somewhere to '
        'start. WITH A DOCUMENT it names the words themselves, by reference, whichever kind you '
        'ask for: that is the list to plan from, and it saves reading or searching the document '
        'to find them.',
        {'kind': {'type': 'string', 'enum': list(WORKLIST_KINDS)},
         'field': {'type': 'string', 'enum': list(FIELDS) + ['deprel'],
                   'description': 'One column; without it, all five including the tree (deprel).'},
         'document': _DOC,
         'limit': {'type': 'integer', 'description': 'How many rows per column (default 20, '
                                                     'max 500).'}}, []),
    _fn('recent_changes',
        'Who changed what, when, and under which operation label. Each entry prints the as_of '
        'instant a restore would use.',
        {'document': _DOC, 'limit': {'type': 'integer'},
         'since': {'type': 'string', 'description': 'A date (YYYY-MM-DD) or timestamp.'},
         'user': {'type': 'string', 'description': 'Match the actor\'s name or email.'}}, []),
    _fn('comments',
        'What people have written to each other on a document or one of its sentences. These are '
        'notes between annotators, never annotation.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'One sentence, e.g. "s3".'},
         'limit': {'type': 'integer'}}, ['document']),
    _fn('add_comment',
        'PLAN: leave a note for the annotators on a sentence or on the document, under the user\'s '
        'name. A note, never annotation: use it for a question or an observation the data cannot '
        'hold, not for a change.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'One sentence, e.g. "s3"; leave it '
                                                                    'out for the document.'},
         'body': {'type': 'string'}}, ['document', 'body']),
]

_IMPL = {
    'project_overview': t_project_overview,
    'add_comment': t_add_comment,
    'search': t_search,
    'frequency_list': t_frequency_list,
    'check_consistency': t_check_consistency,
    'worklist': t_worklist,
    'recent_changes': t_recent_changes,
    'comments': t_comments,
    'list_documents': t_list_documents,
    'read_document': t_read_document,
    'set_field': t_set_field,
    'set_feature': t_set_feature,
    'set_head': t_set_head,
    'del_relation': t_del_relation,
    'confirm': t_confirm,
    'discard_predictions': t_discard_predictions,
    'plan_status': t_plan_status,
    'discard_plan': t_discard_plan,
    'drop_planned': t_drop_planned,
}

TOOLS += webtools.schemas('this corpus')


_IMPL.update({'web_search': t_web_search, 'read_url': t_read_url})

# A tool that plans a change says so in the first word of its description, and
# that is what makes it one: no second list to keep in step with the first.
WRITE_TOOLS = {t['function']['name'] for t in TOOLS if t['function']['description'].startswith('PLAN:')}


def tools_for(ws: Workspace) -> List[Dict[str, Any]]:
    """The tools a turn on this workspace may call."""
    return core_tools_for(ws, TOOLS, WEB_TOOLS, CODE_TOOLS)


def call_tool(ws: Workspace, name: str, args: Dict[str, Any]) -> str:
    """Run one tool. Every failure comes back as text for the model."""
    fn = _IMPL.get(name)
    if not fn:
        return f'Unknown tool {name}'
    # Each tool answers for its OWN reads. The corpus helper lives as long as
    # the turn, so without this a report would carry the note about a clipped
    # read that an earlier tool in the same turn had made.
    ws.forget_clipping()
    try:
        out = truncate(fn(ws, **(args or {})))
        # A change this turn planned over one an earlier call planned is worth
        # a sentence: the model asked for two and is getting one. Said here
        # rather than in each tool, so a tool cannot be written without it.
        if name in WRITE_TOOLS:
            out += ws.superseded_note()
        return out
    except (ToolError, ValueError) as e:  # ValueError: a reference lookup failed, message is for the model
        return f'Error: {e}'
    except (TypeError, AttributeError) as e:
        return f'Error: an argument has the wrong type ({e}); check the tool\'s parameter types'
    except Exception as e:  # noqa: BLE001 - the model gets the failure as text; the log gets the trace
        import traceback
        traceback.print_exc()
        return f'Error: {type(e).__name__}: {e}'


_IMPL['run_parse'] = t_run_parse

_IMPL['set_words'] = t_set_words
_IMPL['replace_in_field'] = t_replace_in_field
_IMPL['split_sentence'] = t_split_sentence
_IMPL['restore_document'] = t_restore_document
_IMPL['query'] = t_query
_IMPL['query_help'] = t_query_help
_IMPL['merge_sentences'] = t_merge_sentences


TOOLS += _sandbox.schemas('the treebank')
_IMPL.update({'run_code': t_run_code, 'code_help': t_code_help})
