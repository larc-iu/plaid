"""The tool table the model sees, and the dispatch behind it.

Every tool a UMR assistant may call is declared here once, beside the function
that implements it, and nowhere else. A tool that plans a change says so in the
first word of its description, which is what makes it one: there is no second
list to keep in step with this one.

This is the last module in the app to be imported: it reads every tool module,
so nothing here may be imported back by one of them.
"""

from ..core import toolkit, webtools
from ..core.limits import MAX_SENTENCES_PER_READ
from ..core.tools import fn, limit_arg

from .corpus import (COUNTABLE, SEARCHABLE, WORKLIST_KINDS, t_find_nodes, t_frequency_list,
                     t_search, t_worklist)
from ..core.history import comments as t_comments, recent_changes as t_recent_changes
from plaid_client.workflows.umr import DOC_RELATIONS
from .project import DOC_CONSTANTS, GROUPS
from .query import t_query, t_query_help
from .sandbox import t_code_help, t_run_code
from ..core.plan import discard_plan as t_discard_plan, plan_status as t_plan_status
from ..core.tools import list_documents as t_list_documents, read_document as t_read_document
from .tools import (t_add_triple, t_apply_penman, t_delete_triple, t_document_graph,
                    t_project_overview, t_set_attribute_for_concept, t_set_attributes)

# Web tools are offered only where the operator configured a search backend
# (see core.tools.tools_for).
WEB_TOOLS = webtools.NAMES

_fn = fn
_SHARED = toolkit.shared_schemas(ref='One sentence, e.g. "s3".')

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
    _SHARED['list_documents'],
    _fn('read_document',
        'Read a document sentence by sentence: the words with their numbers, the gloss lines the '
        'project maps, the sentence graph as PENMAN, which words each node is aligned to, and any '
        'document-level triple written in that sentence\'s block. Up to '
        f'{MAX_SENTENCES_PER_READ} sentences per call, '
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
        'triple, by group, with the sentence each end belongs to, and the constants in use. A triple '
        'reads (reference rel node): (document-creation-time :before s6r) says s6r came before the document.',
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
        'PLAN: replace one sentence\'s graph with the PENMAN text you give. Roles are UMR 2.0\'s: a '
        'new possessor is :possessor, not :poss, though other graphs in the document may still say :poss '
        '(an edge that already says it is written back as it is). Use the concepts, roles and values '
        'the user names, spelled as they name them: asked for an :experiencer, write :experiencer, '
        'not :ARG0, and a concept given as a word and its gloss (purara "find") is the word, purara, '
        'not find-01. The difference against '
        'the stored graph is worked out for you: nodes are matched BY VARIABLE and relations BY '
        'ROLE AND TARGET, so a node written back with the same variable is kept, one variable '
        'typed over everywhere on a node with the same concept and parents is a rename that keeps '
        'its words and relations, any other new variable is a new node and the old one goes, and '
        'a changed role is a new relation and the old one goes. The text is the ROOT\'s graph, '
        'so a node the root does not reach is left alone. A node this creates is UNALIGNED until '
        'somebody anchors it to words on the canvas. '
        'Start from what read_document printed and edit it. Roles are a closed set: one UMR 2.0 does '
        'not have is refused unless that node or edge already holds it. '
        'The order you write a node\'s children in is ignored: one already there keeps its place '
        'and a new one goes after them. Set reorder only when the user asks for the children in a '
        'different order.',
        {'document': _DOC, 'sentence': _SENTENCE,
         'text': {'type': 'string',
                  'description': 'The whole sentence graph in PENMAN, from its root node.'},
         'reorder': {'type': 'boolean',
                     'description': 'Apply the order the text writes each node\'s children in. '
                                    'Default false.'}},
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
        'from them by leaving the value out. A node that already has the attribute keeps its '
        'value unless you pass overwrite. One change on the card, however many nodes it covers, '
        'and the nodes are read again when you approve it. Use set_attributes for one node.',
        {'document': _DOC,
         'concept': {'type': 'string', 'description': 'Match the node\'s concept, e.g. "say-01".'},
         'rel': {'type': 'string',
                 'description': 'The attribute, starting with a colon: :aspect, :refer-number.'},
         'value': {'type': 'string',
                   'description': 'What to set it to. Leave it out to remove the attribute.'},
         'whole': {'type': 'boolean', 'description': 'Match the whole concept only.'},
         'regex': {'type': 'boolean'},
         'case_sensitive': {'type': 'boolean'},
         'overwrite': {'type': 'boolean',
                       'description': 'Replace the value on nodes that already have the attribute. '
                                      'Only when the user asked to change existing values.'}},
        ['document', 'concept', 'rel']),
    _fn('add_triple',
        'PLAN: add one document-level relation between two nodes, or between a node and one of the '
        'format\'s constants. The group (' + ', '.join(GROUPS) + ') follows from the relation '
        'unless you say otherwise. A constant no triple has used yet is created with it. The '
        'triple reads (a rel b): b stands in relation rel to a, which is its reference, so the '
        'reference always comes first. (document-creation-time :before s6r) says s6r happened before '
        'the document was made (never (s6r :before document-creation-time)), '
        '(s4e :before s2e) between two events says s2e happened before s4e, and '
        '(author :full-affirmative e) says the author is sure e happened. A constant under a '
        'sentence node, or a triple that reverses one already there, is refused, as is a relation '
        'outside its group\'s closed set.',
        {'document': _DOC, 'a': _END,
         'rel': {'type': 'string',
                 'description': 'The relation, starting with a colon. temporal: '
                                + ', '.join(DOC_RELATIONS['temporal']) + '. modal: '
                                + ', '.join(DOC_RELATIONS['modal']) + '. coref: '
                                + ', '.join(DOC_RELATIONS['coref']) + '.'},
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
    _SHARED['query_help'],
    _SHARED['query'],
    _SHARED['recent_changes'],
    _SHARED['comments'],
    _SHARED['plan_status'],
    _SHARED['discard_plan'],
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
}

_IMPL.update({'run_code': t_run_code, 'code_help': t_code_help})
TOOLS, WRITE_TOOLS, tools_for, call_tool = toolkit.build(
    TOOLS, _IMPL, manual='this corpus: how this project annotates, and what it has decided about hard cases',
    web='this corpus', code='the corpus')
