"""The tool table the model sees, and the dispatch behind it.

Every tool a treebank assistant may call is declared here once, beside the
function that implements it, and nowhere else. A tool that plans a change says
so in the first word of its description, which is what makes it one: there is
no second list to keep in step with this one.

This is the last module in the app to be imported: it reads every tool module,
so nothing here may be imported back by one of them.
"""

from ..core import toolkit, webtools
from ..core.limits import MAX_SENTENCES_PER_READ
from ..core.tools import fn, limit_arg

from .bulk import t_replace_in_field
from .grew_search import t_grew_search
from ..core.history import recent_changes as t_recent_changes
from .query import t_query, t_query_help
from .restore import t_restore_document
from .sandbox import t_code_help, t_run_code
from .sentences import t_merge_sentences, t_split_sentence
from .shape import t_set_words
from ..core.history import add_comment as t_add_comment, comments as t_comments
from .stats import (COUNTABLE, CONSISTENCY, SEARCHABLE, WORKLIST_KINDS, t_check_consistency,
                    t_frequency_list, t_search, t_worklist)
from ..core.plan import discard_plan as t_discard_plan, drop_planned as t_drop_planned, \
    plan_status as t_plan_status
from ..core.tools import list_documents as t_list_documents, read_document as t_read_document
from .tools import (FIELDS, t_confirm, t_del_relation,
                    t_discard_predictions, t_project_overview, t_run_parse,
                    t_set_feature, t_set_field, t_set_head)

# Web tools are offered only where the operator configured a search backend
# (see core.tools.tools_for).
WEB_TOOLS = webtools.NAMES

_fn = fn
_SHARED = toolkit.shared_schemas(ref='One sentence, e.g. "s3".')


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
    _SHARED['list_documents'],
    _fn('read_document',
        'Read a document as tab-separated CoNLL-U rows: one line per word with its form, lemma, UPOS, '
        'XPOS, features, head and deprel, and a range line for each multi-word token. A sentence whose '
        'enhanced graph differs from its tree carries a DEPS column as well. A value followed '
        'by ~ was made by a machine and nobody has confirmed it; ^ is a contributor\'s unreviewed work. '
        f'Up to {MAX_SENTENCES_PER_READ} sentences per call, fewer when they are long: the first '
        'line says which sentences '
        'were shown and where to continue. WHEN YOU ALREADY KNOW WHICH SENTENCES YOU NEED (a search '
        'told you, or an earlier read did), name them in `sentences` and get them all in ONE call. '
        'Paging a long document with from_sentence/to_sentence costs a call per page and will run out '
        'of steps before it runs out of document.',
        {'document': _DOC,
         'sentences': {'type': 'array', 'items': {'type': 'string'},
                       'description': 'Just these sentences, e.g. ["s34","s64","s104"]. A word '
                                      'reference like "s34.w2" names its sentence, and "sent_id=a3" '
                                      'the sentence whose stored sent_id is a3. Overrides the '
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
        'PLAN: set or remove ONE Feature=Value on one or more words, keeping their other features as '
        'they are (set_field replaces them all). An empty value removes the feature.',
        {'document': _DOC, 'refs': _REFS,
         'feature': {'type': 'string', 'description': 'The feature name, e.g. Number.'},
         'value': {'type': 'string', 'description': 'The value, e.g. Sing; "" removes the feature.'}},
        ['document', 'refs', 'feature']),
    _fn('set_head',
        'PLAN: give one word its head and its relation to it. head is the CoNLL-U id of another word in '
        'the SAME sentence, or 0 to make this word the sentence root (deprel "root"). A word has one '
        'head, so this replaces whatever head it had. A sentence has one root: making a word the root '
        'when another word is the root needs old_root_head and old_root_deprel, where the old root goes.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The dependent word, e.g. "s3.w2".'},
         'head': {'type': ['integer', 'string'],
                  'description': 'The head word\'s CoNLL-U id (or its reference, e.g. "s3.w5"), or 0 for the root.'},
         'deprel': {'type': 'string', 'description': 'The relation label, e.g. nsubj, obj, det.'},
         'old_root_head': {'type': ['integer', 'string'],
                           'description': 'With head 0 only: the CoNLL-U id of the current root\'s new head.'},
         'old_root_deprel': {'type': 'string', 'description': 'With head 0 only: the current root\'s '
                                                              'relation to its new head.'}},
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
        'spelling. A literal substring unless regex is true; whole matches the whole value; case '
        'counts unless case_sensitive is false. Empty values are never filled. The plan holds it as ONE change '
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
        'PLAN: say which WORDS a token holds, and how each is spelled. Two or more makes it a '
        'multi-word token (Spanish "al" holding "a" and "el"); one collapses it back to a plain '
        'token. As many forms as the token has words RESPELLS them: each keeps its lemma, UPOS, '
        'XPOS, features and heads, and only its form changes (this is how to fix a word\'s '
        'spelling). Another number REPLACES the token\'s words, so it discards their lemma, UPOS, '
        'XPOS, features and heads, and seeds each new word\'s lemma from its form. Never use it '
        'to change a lemma, a tag or a feature.',
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
        'A sentence has one root: when both have one, root_head and root_deprel say where one '
        'of them goes. Sentences after it renumber, so this is the ONLY change a plan may carry '
        'for this document.',
        {'document': _DOC,
         'ref': {'type': 'string', 'description': 'The second of the two sentences, "s3".'},
         'root_head': {'type': 'string', 'description': 'When both sentences have a root: a word of '
                                                        'one of them, "s2.w3", that takes the OTHER '
                                                        'sentence\'s root as its dependent.'},
         'root_deprel': {'type': 'string', 'description': 'The relation the demoted root takes to '
                                                          'root_head.'}},
        ['document', 'ref']),
    _SHARED['query_help'],
    _SHARED['query'],
    _fn('restore_document',
        'PLAN: put a document back as it was at a moment in its history, every layer of it. The '
        'plan shows what would change, from the server\'s own dry run, so it is not a guess. '
        'Maintainers only. It rewrites the whole document, so it must be the ONLY change in its '
        'plan. recent_changes prints an as_of instant for every change.',
        {'document': _DOC,
         'as_of': {'type': 'string', 'description': 'An ISO-8601 instant, e.g. '
                                                    '2026-09-05T18:45:49Z.'}},
        ['document', 'as_of']),
    _SHARED['plan_status'],
    _SHARED['discard_plan'],
    _SHARED['drop_planned'],
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
         'regex': {'type': 'boolean'}, 'limit': limit_arg('search', 'Max hits to return'),
         'case_sensitive': {'type': 'boolean', 'description': 'Match case too (off: "the" finds "The"). '
                                                              'The same switch replace_in_field takes.'}},
        ['field', 'pattern']),
    _fn('grew_search',
        'Sentences matching a Grew pattern, the language of the Search tab: the structural '
        'questions (a head and its dependent, a deprel with a UPOS on either end, a word that '
        'lacks a dependent) in ONE engine query instead of walking documents in run_code. Gives '
        'the total matches, sentences and documents, then sentences with the matched words in '
        'brackets and each node\'s word (V=w2 S=w1), and echoes the pattern so the user can '
        'paste it into the Search tab: show it when they ask how something was found. A node is '
        'a word: [upos=VERB, lemma="be", Number=Sing, !Tense, form=re"^un"]. An edge is '
        'H -[nsubj]-> D, -[nsubj|obj]->, -[^punct]->, -[re"subj"]->, -[E:nsubj]-> for the enhanced '
        'graph, -> for any. A root is * -[root]-> D. Also X < Y (next word), X << Y (anywhere '
        'before), without { ... } for what must be absent. Example: pattern { V [upos=VERB]; '
        'V -[nsubj]-> S; S [upos=PRON] } without { V -[obj]-> O }',
        {'pattern': {'type': 'string', 'description': 'A Grew request: pattern { ... }, '
                                                      'optionally with without { ... } and '
                                                      'global { ... } blocks.'},
         'document': _DOC, 'limit': limit_arg('search', 'Max sentences to show')},
        ['pattern']),
    _fn('frequency_list',
        'The commonest values of one column, with counts. Across the project, or inside one document. '
        '"features" counts each Feature=Value on its own; "feature-bundles" counts whole FEATS strings '
        'as stored.',
        {'what': {'type': 'string', 'enum': list(COUNTABLE)}, 'document': _DOC,
         'limit': limit_arg('frequency_list', 'Rows')}, ['what']),
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
         'limit': limit_arg('worklist', 'How many rows per column')}, []),
    _SHARED['recent_changes'],
    _SHARED['comments'],
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
    'grew_search': t_grew_search,
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

_IMPL['run_parse'] = t_run_parse

_IMPL['set_words'] = t_set_words
_IMPL['replace_in_field'] = t_replace_in_field
_IMPL['split_sentence'] = t_split_sentence
_IMPL['restore_document'] = t_restore_document
_IMPL['query'] = t_query
_IMPL['query_help'] = t_query_help
_IMPL['merge_sentences'] = t_merge_sentences

_IMPL.update({'run_code': t_run_code, 'code_help': t_code_help})
TOOLS, WRITE_TOOLS, tools_for, call_tool = toolkit.build(
    TOOLS, _IMPL, manual='this treebank: how this project annotates, and what it has decided about hard cases',
    web='this corpus', code='the treebank')
