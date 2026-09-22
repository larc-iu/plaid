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
- :mod:`penman` — the notation: the reader, the writer, the variable rule.
- :mod:`write` — writing drafted graphs in three batched passes, the progress
  budget and what a drafting run reports.

The JS side of the same rules lives in ``plaid-umr/src`` (``umrLayerUtils.js``,
``sentenceGraph.js``, ``format/penman.js``); that split is unavoidable, and
``plaid-agent/tests/test_penman_mirror.py`` holds the two readings of the
notation to each other over the corner cases the grammar turns on.
"""

from . import graph, layers, penman, write
from .graph import (COREF_RELATIONS, CYCLE_ROLES, DOC_CONSTANTS, Edge, GROUPS, MISSING,
                    Morpheme, Node, Piece, Sentence, Triple, UmrDocument, Word,
                    alignment_of, begins_in, group_of, next_order, penman_nodes, penman_of,
                    place_attributes, read_document, reachable_from_root, roots_of,
                    with_attribute)
from .layers import (CONCEPTS, DOCUMENT_GRAPH, GlossLayer, NODES, RELATIONS, REQUIRED,
                     UMR_NAMESPACE, UmrLayers, find_flagged, gloss_layers_of, gloss_values,
                     owns_umr, project_language, resolve_layers, umr_config, umr_metadata)
from .penman import (Child, Graph, ParseError, graph_text, is_variable, next_variable,
                     parse_attribute_line, parse_penman, serialize_penman, tree_edges,
                     variable_from)
from .write import DraftProgress, anchor_pieces, build_draft_notice, write_graphs

__all__ = [
    'graph', 'layers', 'penman', 'write',
    # layers
    'UMR_NAMESPACE', 'NODES', 'CONCEPTS', 'RELATIONS', 'DOCUMENT_GRAPH', 'REQUIRED',
    'GlossLayer', 'UmrLayers', 'resolve_layers', 'gloss_layers_of', 'gloss_values',
    'find_flagged', 'owns_umr', 'umr_config', 'umr_metadata', 'project_language',
    # graph
    'Piece', 'Word', 'Morpheme', 'Edge', 'Triple', 'Node', 'Sentence', 'UmrDocument',
    'read_document', 'roots_of', 'alignment_of', 'begins_in', 'group_of',
    'DOC_CONSTANTS', 'GROUPS', 'COREF_RELATIONS', 'CYCLE_ROLES', 'MISSING',
    'penman_nodes', 'penman_of', 'reachable_from_root',
    'next_order', 'place_attributes', 'with_attribute',
    # penman
    'Child', 'Graph', 'ParseError', 'parse_penman', 'serialize_penman', 'tree_edges',
    'graph_text', 'next_variable', 'is_variable', 'variable_from', 'parse_attribute_line',
    # write
    'anchor_pieces', 'write_graphs', 'DraftProgress', 'build_draft_notice',
]
