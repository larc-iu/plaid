"""The tool table the model sees, and the dispatch behind it.

Every tool a UMR assistant may call is declared here once, beside the function
that implements it, and nowhere else. A tool that plans a change says so in the
first word of its description, which is what makes it one: there is no second
list to keep in step with this one.

This is the last module in the app to be imported: it reads every tool module,
so nothing here may be imported back by one of them.
"""

from typing import Any, Dict, List

from ..core import guidelines as _guidelines
from ..core import sandbox as _sandbox
from ..core import webtools
from ..core.guidelines import (t_add_guideline, t_read_guideline, t_revise_guideline,
                               t_rewrite_guideline)
from ..core.tools import fn, limit_arg, run_tool, tools_for as core_tools_for
from ..core.webtools import t_read_url, t_web_search

from .corpus import (COUNTABLE, SEARCHABLE, WORKLIST_KINDS, t_find_nodes, t_frequency_list,
                     t_search, t_worklist)
from .history import t_comments, t_recent_changes
from .project import DOC_CONSTANTS, GROUPS
from .query import t_query, t_query_help
from .sandbox import t_code_help, t_run_code
from .tools import (Workspace, t_add_triple, t_apply_penman, t_delete_triple, t_discard_plan,
                    t_document_graph, t_drop_planned, t_list_documents, t_plan_status,
                    t_project_overview, t_read_document, t_set_attribute_for_concept,
                    t_set_attributes)

# Offered only where the monty worker binary is present, and only where the
# operator configured a search backend (see tools_for): a model that cannot run
# code or look something up is never told that it can.
CODE_TOOLS = _sandbox.NAMES
WEB_TOOLS = webtools.NAMES

_fn = fn

_DOC = {'type': 'string', 'description': 'Document id or exact name (see project_overview).'}
_SENTENCE = {'type': ['integer', 'string'],
             'description': 'The sentence, 1-based: 3 or "s3".'}
_VAR = {'type': 'string', 'description': 'A node\'s variable, as the graph writes it, e.g. "s3e".'}
_END = {'type': 'string',
        'description': 'A node variable, e.g. "s3e", or one of the constants '
                       + ', '.join(DOC_CONSTANTS) + '.'}

TOOLS = [
    _fn('project_overview',
        'The project: its language, the gloss lines under each sentence, how much corpus there '
        'is, and its documents. Call this first.', {}, []),
    _fn('list_documents',
        'The documents by name, a page at a time, optionally filtered by a name substring.',
        {'pattern': {'type': 'string'}, 'limit': limit_arg('list_documents', 'Documents to show'),
         'offset': {'type': 'integer'}},
        []),
    _fn('read_document',
        'Read a document sentence by sentence: the words with their numbers, the gloss lines the '
        'project maps, the sentence graph as PENMAN, which words each node is aligned to, and any '
        'document-level triple written in that sentence\'s block. Up to 40 sentences per call, '
        'fewer when their graphs are large: the first line says which sentences were shown and '
        'where to continue. WHEN YOU ALREADY KNOW WHICH SENTENCES YOU NEED (find_nodes told you, '
        'or an earlier read did), name them in `sentences` and get them all in ONE call.',
        {'document': _DOC,
         'sentences': {'type': 'array', 'items': {'type': 'string'},
                       'description': 'Just these sentences, e.g. ["s3","s8"]. A node reference '
                                      'like "s3.s3e" names its sentence. Overrides the range '
                                      'below.'},
         'from_sentence': {'type': ['integer', 'string'],
                           'description': 'First sentence, 1-based: 3 or "s3" (default 1).'},
         'to_sentence': {'type': ['integer', 'string'],
                         'description': 'Last sentence, inclusive: 8 or "s8".'}},
        ['document']),
    _fn('document_graph',
        'The whole document-level graph of one document: every temporal, modal and coreference '
        'triple, by group, with the sentence each end belongs to, and the constants in use.',
        {'document': _DOC}, ['document']),
    _fn('find_nodes',
        'Nodes across the project, by the concept they carry, by a relation hanging off them, or '
        'by an attribute. Searches the whole project unless a document is named: the first line '
        'gives the total and how many documents have hits, and the hits shown come from several '
        'documents rather than all from one. Name a document to see every hit in it.',
        {'concept': {'type': 'string', 'description': 'Match the node\'s concept, e.g. "say-01".'},
         'role': {'type': 'string', 'description': 'Match a relation on the node, e.g. ":ARG0".'},
         'attribute': {'type': 'string',
                       'description': 'Match an attribute, by relation (":aspect") or by relation '
                                      'and value (":aspect state").'},
         'document': _DOC,
         'whole': {'type': 'boolean', 'description': 'Match the whole value only.'},
         'regex': {'type': 'boolean'},
         'case_sensitive': {'type': 'boolean',
                            'description': 'Match case too (off: "person" finds "Person").'},
         'limit': limit_arg('search', 'Max hits to return')},
        []),
    _fn('search',
        'Sentences whose words match, or whose graph carries a matching concept. Searches the '
        'whole project unless a document is named. This is the way in from a word: find_nodes '
        'takes a concept, and this takes what is on the page.',
        {'pattern': {'type': 'string', 'description': 'What to look for.'},
         'where': {'type': 'string', 'enum': list(SEARCHABLE),
                   'description': 'Match the sentence\'s words (default) or its concepts.'},
         'document': _DOC,
         'whole': {'type': 'boolean', 'description': 'Match the whole word or concept only.'},
         'regex': {'type': 'boolean'},
         'case_sensitive': {'type': 'boolean'},
         'limit': limit_arg('search', 'Sentences to show')},
        ['pattern']),
    _fn('worklist',
        'The sentences that are unfinished: "ungraphed" has no graph at all, "unrooted" has no '
        'single root, "unaligned" has nodes anchored to no words, "disconnected" has nodes the '
        'root does not reach. Without a kind it reports all four. Name a document for a complete '
        'answer about it.',
        {'kind': {'type': 'string', 'enum': list(WORKLIST_KINDS)}, 'document': _DOC,
         'limit': limit_arg('worklist', 'Sentences per kind')},
        []),
    _fn('frequency_list',
        'The commonest values, with counts, across the project or inside one document: concepts, '
        'sentence-level roles, node attributes, or document-level relations.',
        {'what': {'type': 'string', 'enum': list(COUNTABLE)}, 'document': _DOC,
         'limit': limit_arg('frequency_list', 'Rows')},
        ['what']),
    _fn('apply_penman',
        'PLAN: replace one sentence\'s graph with the PENMAN text you give. The difference against '
        'the stored graph is worked out for you: nodes are matched BY VARIABLE and relations BY '
        'ROLE AND TARGET, so a node written back with the same variable is kept, a renamed '
        'variable is a new node and the old one goes, and a changed role is a new relation and the '
        'old one goes. The text is the ROOT\'s graph, so a node the root does not reach is left '
        'alone. A node this creates is UNALIGNED until somebody anchors it to words on the canvas. '
        'Start from what read_document printed and edit it.',
        {'document': _DOC, 'sentence': _SENTENCE,
         'text': {'type': 'string',
                  'description': 'The whole sentence graph in PENMAN, from its root node.'}},
        ['document', 'sentence', 'text']),
    _fn('set_attributes',
        'PLAN: set the attributes of ONE node, whole. Give every attribute the node should end up '
        'with, as a PENMAN attribute line (":aspect state :refer-number singular"); an empty line '
        'removes them all. An attribute that was already there keeps its place among the node\'s '
        'children. Use apply_penman instead to change concepts or relations.',
        {'document': _DOC, 'sentence': _SENTENCE, 'var': _VAR,
         'line': {'type': 'string',
                  'description': 'The attributes, e.g. ":aspect state :polarity -". Empty removes '
                                 'them all.'}},
        ['document', 'sentence', 'var', 'line']),
    _fn('set_attribute_for_concept',
        'PLAN: set one attribute on every node in a document whose concept matches, or remove it '
        'from them by leaving the value out. One change on the card, however many nodes it '
        'covers, and the nodes are read again when you approve it. Use set_attributes for one '
        'node.',
        {'document': _DOC,
         'concept': {'type': 'string', 'description': 'Match the node\'s concept, e.g. "say-01".'},
         'rel': {'type': 'string',
                 'description': 'The attribute, starting with a colon: :aspect, :refer-number.'},
         'value': {'type': 'string',
                   'description': 'What to set it to. Leave it out to remove the attribute.'},
         'whole': {'type': 'boolean', 'description': 'Match the whole concept only.'},
         'regex': {'type': 'boolean'},
         'case_sensitive': {'type': 'boolean'}},
        ['document', 'concept', 'rel']),
    _fn('add_triple',
        'PLAN: add one document-level relation between two nodes, or between a node and one of the '
        'format\'s constants. The group (' + ', '.join(GROUPS) + ') follows from the relation '
        'unless you say otherwise. A constant no triple has used yet is created with it.',
        {'document': _DOC, 'a': _END,
         'rel': {'type': 'string',
                 'description': 'The relation, starting with a colon: :same-entity, :before, '
                                ':full-affirmative.'},
         'b': _END,
         'group': {'type': 'string', 'enum': list(GROUPS),
                   'description': 'Only where the relation belongs to two groups (:contains).'},
         'sentence': dict(_SENTENCE, description='Whose block writes a triple between two '
                                                 'constants. Ignored otherwise.')},
        ['document', 'a', 'rel', 'b']),
    _fn('delete_triple',
        'PLAN: remove one document-level relation. Name both of its ends, and the relation when '
        'the two are joined by more than one.',
        {'document': _DOC, 'a': _END,
         'rel': {'type': 'string', 'description': 'The relation, e.g. ":same-entity".'},
         'b': _END},
        ['document', 'a', 'b']),
    _fn('query_help',
        'The Plaid query language, and this project\'s layer names. Call it before writing a '
        'query; it costs nothing until you need it.', {}, []),
    _fn('query',
        'Run one read-only Plaid query over this project. The escape hatch for a question the '
        'other reads cannot express: two conditions at once, a join, a count under your own '
        'definition. Layers are named by name. Call query_help first.',
        {'query': {'type': 'object',
                   'description': 'The query object: find, where, return, limit, order_by. See '
                                  'query_help.'},
         'limit': limit_arg('query', 'Rows to show')},
        ['query']),
    _fn('recent_changes',
        'Who changed what, when, and under which operation label. The assistant\'s own applied '
        'plans appear here like anyone else\'s work.',
        {'document': _DOC, 'limit': limit_arg('recent_changes', 'Entries to show'),
         'since': {'type': 'string', 'description': 'A date (YYYY-MM-DD) or timestamp.'},
         'user': {'type': 'string', 'description': 'Match the actor\'s name or email.'}}, []),
    _fn('comments',
        'What people have written to each other on a document or one of its sentences. These are '
        'notes between annotators, never annotation.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'One sentence, e.g. "s3".'},
         'limit': limit_arg('comments', 'Comments to show')},
        ['document']),
    _fn('plan_status', 'Every change planned so far in this turn, numbered.', {}, []),
    _fn('discard_plan', 'Throw away everything planned so far and start the plan over.', {}, []),
    _fn('drop_planned', 'Drop some of the planned changes by their numbers from plan_status.',
        {'indexes': {'type': 'array', 'items': {'type': 'integer'}}}, ['indexes']),
]

_IMPL = {
    'project_overview': t_project_overview,
    'list_documents': t_list_documents,
    'read_document': t_read_document,
    'document_graph': t_document_graph,
    'find_nodes': t_find_nodes,
    'search': t_search,
    'worklist': t_worklist,
    'frequency_list': t_frequency_list,
    'recent_changes': t_recent_changes,
    'comments': t_comments,
    'apply_penman': t_apply_penman,
    'set_attributes': t_set_attributes,
    'set_attribute_for_concept': t_set_attribute_for_concept,
    'add_triple': t_add_triple,
    'delete_triple': t_delete_triple,
    'query': t_query,
    'query_help': t_query_help,
    'plan_status': t_plan_status,
    'discard_plan': t_discard_plan,
    'drop_planned': t_drop_planned,
}

# The project's own annotation manual. Always offered: the titles and opening
# lines are in the prompt, and this reads one in full.
TOOLS += _guidelines.schemas('this corpus: how this project annotates, and what it has decided '
                             'about hard cases')
_IMPL.update({'read_guideline': t_read_guideline})

# Drafting one is a PLAN, like every other change: the user approves it on the
# card before anything is written.
TOOLS += _guidelines.write_schemas()
_IMPL.update({'add_guideline': t_add_guideline, 'revise_guideline': t_revise_guideline,
              'rewrite_guideline': t_rewrite_guideline})

# Offered only when the operator configured a search backend (see tools_for).
TOOLS += webtools.schemas('this corpus')
_IMPL.update({'web_search': t_web_search, 'read_url': t_read_url})

# Offered only where the sandbox's worker binary is installed.
TOOLS += _sandbox.schemas('the corpus')
_IMPL.update({'run_code': t_run_code, 'code_help': t_code_help})

# A tool that plans a change says so in the first word of its description, and
# that is what makes it one: no second list to keep in step with the first.
WRITE_TOOLS = {t['function']['name'] for t in TOOLS
               if t['function']['description'].startswith('PLAN:')}


def tools_for(ws: Workspace) -> List[Dict[str, Any]]:
    """The tools a turn on this workspace may call."""
    return core_tools_for(ws, TOOLS, WEB_TOOLS, CODE_TOOLS)


def call_tool(ws: Workspace, name: str, args: Dict[str, Any]) -> str:
    """Run one tool. Every failure comes back as text for the model."""
    impl = _IMPL.get(name)
    if not impl:
        return f'Unknown tool {name}'
    # A change this turn planned over one an earlier call planned is worth a
    # sentence: the model asked for two and is getting one. Said here rather
    # than in each tool, so a tool cannot be written without it.
    after = (lambda out: out + ws.superseded_note()) if name in WRITE_TOOLS else None
    return run_tool(ws, name, impl, args, after=after)
