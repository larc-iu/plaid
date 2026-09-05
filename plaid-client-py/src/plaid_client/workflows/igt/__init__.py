"""
Interlinear analysis workflow framework.

The model-independent half of an IGT ``analyze`` service: read a document
into sentences > words > morphemes with their annotations and links and
classify each word under the provenance write contract (:mod:`derive`);
parse a proposer's interleaved ``GLOSS(seg)-GLOSS(seg)`` output and align
it back onto the input words (:mod:`interlinear`); and write the resulting
analyses as morpheme chains + gloss spans in budgeted atomic batches,
stamped machine-made with the recorded prediction (:mod:`write`). Also
reads the tagsets a project holds its fields to, so a proposer can be shown
the values in use before it answers (:mod:`tagsets`); nothing enforces
them, and a value off the list is written as proposed for a person to see.

A proposer (PolyGloss, an LLM, a rule engine) only has to turn a sentence's
words (and free translation) into one interleaved line per sentence; see
``plaid-igt/services/igt_analyze_polygloss.py`` for the template.
"""

from .derive import derive, word_state, select_targets, is_token_ignored
from .interlinear import (
    ParsedWord,
    parse_interleaved,
    align_words,
    analysis_for,
    similarity,
    clitic_side_of_boundary,
    clitic_types,
    ALIGN_THRESHOLD,
)
from .write import write_analyses, chunk_plans, BATCH_OP_BUDGET
from .tagsets import (
    MODES,
    normalize_tagset,
    read_tagsets,
    read_tagset_name,
    resolve_tagset,
    tagset_for,
    vocab_tagset_for,
    governed_fields,
    mode_rule,
    value_lines,
)

__all__ = [
    'derive', 'word_state', 'select_targets', 'is_token_ignored',
    'ParsedWord', 'parse_interleaved', 'align_words', 'analysis_for', 'similarity',
    'clitic_side_of_boundary', 'clitic_types', 'ALIGN_THRESHOLD',
    'write_analyses', 'chunk_plans', 'BATCH_OP_BUDGET',
    'MODES', 'normalize_tagset', 'read_tagsets', 'read_tagset_name', 'resolve_tagset',
    'tagset_for', 'vocab_tagset_for', 'governed_fields', 'mode_rule', 'value_lines',
]
