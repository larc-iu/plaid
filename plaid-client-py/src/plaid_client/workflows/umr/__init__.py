"""
Uniform Meaning Representation: one reading of the storage model.

A UMR graph is stored as annotation over the shared substrate: one token per
contiguous anchor piece, one concept span per graph node carrying
``metadata.umr = {var, attrs, root?, sentence?, constant?}``, one relation per
sentence-level edge and one per document-level triple. Reading that back is a
set of rules with no obvious home (which layer is which, what an unaligned node
looks like, where a document-level triple is written, how a variable is minted,
what the PENMAN text means), and every piece of code that touched UMR used to
carry its own copy of them.

This package is the one copy, shared by the assistant in ``plaid-agent`` and by
the bundled UMR services:

- :mod:`layers` — which layer is which (``resolve_layers``), the gloss layers
  another app contributes, the project's language.
- :mod:`graph` — a document response as sentences, words, morphemes, nodes,
  edges and document-level triples (``read_document``), plus the roots, the
  alignment, the attribute placing rule and the stored graph as PENMAN.
- :mod:`inventory` — the closed relation sets and why a relation is not in
  them (``unknown_relation_problem``, ``unknown_doc_relation_problem``).
- :mod:`penman` — the notation: the reader, the writer, the variable rule.
- :mod:`flat`: a graph a model wrote one block per node, joined back into one
  (``join_flat_graph``).
- :mod:`write` — a drafting service's run: its parameters, the sentences it
  drafts, writing the graphs in three batched passes, the progress budget and
  what the run reports.

The JS side of the same rules lives in ``plaid-umr/src`` (``umrLayerUtils.js``,
``sentenceGraph.js``, ``format/penman.js``); that split is unavoidable, and
``plaid-agent/tests/test_penman_mirror.py`` holds the two readings of the
notation to each other over the corner cases the grammar turns on, and
``test_umr_inventory_mirror.py`` the two copies of the relation sets.
"""

from . import graph, inventory, layers, penman, write
from .graph import (COREF_RELATIONS, CYCLE_ROLES, DOC_CONSTANTS, Edge, GROUPS, MISSING,
                    Morpheme, Node, Piece, Sentence, Triple, UmrDocument, Word,
                    alignment_of, cycle_edges, file_numbers, group_of, next_order, penman_nodes, penman_of,
                    place_attributes, read_document, reachable_from_root, roots_of,
                    sentence_penman, triple_sentence_number, with_attribute)
from .flat import join_flat_graph
from .inventory import DOC_RELATIONS, unknown_doc_relation_problem, unknown_relation_problem
from .layers import (GlossLayer, UMR_NAMESPACE, UmrLayers, gloss_values, project_language,
                     resolve_layers, umr_config)
from .penman import (Graph, attr_value_problem, concept_problem, is_variable,
                     new_variable_problem, next_variable, parse_attribute_line, parse_penman,
                     relation_form_problem, serialize_penman, tree_edges, variable_form_problem,
                     variable_from, written_value_problem)
from .write import (DraftProgress, anchor_pieces, begin_draft, draft_params, finish_draft,
                    run_label, write_graphs)

__all__ = [
    'graph', 'inventory', 'layers', 'penman', 'write',
    # inventory
    'DOC_RELATIONS', 'unknown_relation_problem',
    'unknown_doc_relation_problem',
    # layers
    'UMR_NAMESPACE',
    'GlossLayer', 'UmrLayers', 'resolve_layers', 'gloss_values',
    'umr_config', 'project_language',
    # graph
    'Piece', 'Word', 'Morpheme', 'Edge', 'Triple', 'Node', 'Sentence', 'UmrDocument',
    'read_document', 'roots_of', 'alignment_of', 'group_of', 'file_numbers',
    'triple_sentence_number', 'cycle_edges',
    'DOC_CONSTANTS', 'GROUPS', 'COREF_RELATIONS', 'CYCLE_ROLES', 'MISSING',
    'penman_nodes', 'penman_of', 'sentence_penman', 'reachable_from_root',
    'next_order', 'place_attributes', 'with_attribute',
    # penman
    'Graph', 'parse_penman', 'serialize_penman', 'tree_edges',
    'next_variable', 'is_variable', 'variable_from', 'parse_attribute_line',
    'concept_problem', 'relation_form_problem', 'attr_value_problem', 'variable_form_problem',
    'new_variable_problem', 'written_value_problem',
    # flat
    'join_flat_graph',
    # write
    'anchor_pieces', 'write_graphs', 'DraftProgress', 'draft_params', 'begin_draft',
    'finish_draft', 'run_label',
]
