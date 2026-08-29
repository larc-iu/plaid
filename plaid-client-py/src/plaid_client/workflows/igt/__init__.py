"""
Interlinear analysis workflow framework.

The model-independent half of an IGT ``analyze`` service: read a document
into sentences > words > morphemes with their annotations and links and
classify each word under the provenance write contract (:mod:`derive`);
parse a proposer's interleaved ``GLOSS(seg)-GLOSS(seg)`` output and align
it back onto the input words (:mod:`interlinear`); and write the resulting
analyses as morpheme chains + gloss spans in budgeted atomic batches,
stamped machine-made with the recorded prediction (:mod:`write`).

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

__all__ = [
    'derive', 'word_state', 'select_targets', 'is_token_ignored',
    'ParsedWord', 'parse_interleaved', 'align_words', 'analysis_for', 'similarity',
    'clitic_side_of_boundary', 'clitic_types', 'ALIGN_THRESHOLD',
    'write_analyses', 'chunk_plans', 'BATCH_OP_BUDGET',
]
