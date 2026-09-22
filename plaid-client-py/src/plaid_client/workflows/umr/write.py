"""Writing drafted UMR graphs, and what a drafting run reports.

A service that drafts graphs hands :func:`write_graphs` one plan per sentence::

    {'sentence': Sentence,
     'pieces':   [(begin, end), ...],                  token extents
     'nodes':    [{'concept': str, 'meta': {...},
                   'piece_indexes': [i, ...]}, ...],   pieces by index
     'edges':    [{'source': i, 'target': i,
                   'role': ':ARG0', 'order': n}, ...]} nodes by index

and gets three batched passes: anchors, then nodes, then edges, because an op
cannot reference an id produced earlier in the same batch. That is the order the
``.umr`` importer writes in (``src/domain/umrImport.js``).

Two services write this shape today (drafting with a model, and the skeleton
from glosses), which is why the writer, the progress budget and the report's
wording live here rather than in one of them.
"""

import contextlib
from typing import Any, Dict, List, Optional, Sequence, Tuple

from plaid_client.service import progress_heartbeat

from .layers import UMR_NAMESPACE, UmrLayers


def anchor_pieces(ranges, words, sentence_extent) -> List[Tuple[int, int]]:
    """The anchor tokens for one node: one piece per aligned word range, or one
    piece over the whole sentence when the concept is not overtly realized.

    That is how a node aligned to no word is stored: what says it is unaligned is
    its sentence record, not the anchor, and an anchor over the sentence survives
    an edit to the text around it (``src/domain/umrReconcile.js``).
    """
    pieces: List[Tuple[int, int]] = []
    for begin, end in ranges or []:
        first = words[begin - 1] if 0 < begin <= len(words) else None
        last = words[end - 1] if 0 < end <= len(words) else None
        if first is None or last is None:
            continue
        pieces.append((first.begin, last.end))
    return pieces or [tuple(sentence_extent)]


class DraftProgress:
    """A fixed percentage budget over the phases, so the bar moves for the same
    reason on every document:

        2-10    reading the document and the project
        10-85   drafting
        85-100  writing

    ``report`` is a CANCELLATION CHECKPOINT (``ResponseHelper.progress`` raises),
    so every call in the write phase sits inside ``critical()``.
    """

    READ, DRAFT, WRITE = (2, 10), (10, 85), (85, 100)

    def __init__(self, helper=None):
        self._helper = helper

    @staticmethod
    def _percent(phase, fraction):
        low, high = phase
        return int(low + (high - low) * min(max(fraction, 0.0), 1.0))

    def report(self, phase, fraction, message):
        if self._helper:
            self._helper.progress(self._percent(phase, fraction), message)

    def heartbeat(self, phase, fraction, message):
        """Keep saying ``message`` through one model call, which reports nothing
        of its own and can outlast a requester's patience with silence."""
        if not self._helper:
            return contextlib.nullcontext()
        return progress_heartbeat(self._helper, self._percent(phase, fraction), message)


def build_draft_notice(drafted, skipped, failed, first_error=None, kept=0) -> Dict[str, Any]:
    """The toast the editor shows when a run finishes. The service owns the
    wording and the severity; the editor maps ``level`` to a colour. A run that
    drafted nothing must not congratulate anyone.

    ``skipped`` and ``kept`` cannot both stand: a sentence with a graph is
    skipped when ``overwrite`` is off, and one a person built is kept when it
    is on.
    """
    def s(n):
        return '' if n == 1 else 's'

    tail = []
    if skipped:
        tail.append(f'Skipped {skipped} sentence{s(skipped)} that already had a graph.')
    if kept:
        tail.append(f'Kept {kept} verified sentence{s(kept)}.')
    if failed:
        tail.append(f'Failed {failed} sentence{s(failed)}'
                    + (f': {first_error}' if first_error else '.'))
    if drafted:
        return {'level': 'success', 'title': f'Drafted {drafted} sentence{s(drafted)}',
                'message': ' '.join(tail)}
    if skipped:
        subject = ('1 sentence already has a graph' if skipped == 1
                   else f'All {skipped} sentences already have graphs')
        return {'level': 'warning', 'title': 'Document not modified',
                'message': (f"{subject}. Enable 'Overwrite existing graphs' to draft over them."
                            + (f' Failed {failed} sentence{s(failed)}.' if failed else ''))}
    if kept:
        return {'level': 'warning', 'title': 'Document not modified',
                'message': ' '.join(tail)}
    if failed:
        return {'level': 'warning', 'title': 'Nothing drafted',
                'message': f'Failed {failed} sentence{s(failed)}'
                           + (f': {first_error}' if first_error else '.')}
    return {'level': 'warning', 'title': 'Nothing to draft',
            'message': 'The document has no sentences in scope.'}


def write_graphs(client, layers: UmrLayers, plans: Sequence[dict], doomed: Sequence[str],
                 frag: dict, progress: Optional[DraftProgress] = None) -> None:
    """Anchors, then nodes, then edges, in three batches.

    ``doomed`` are the anchor tokens of the graphs being replaced; deleting them
    cascades their concept spans, and with those the edges and document-level
    triples that hung off them. ``frag`` is the provenance stamp every write
    carries: it is FLAT and the app's own half sits beside it under ``umr``,
    exactly as the importer and the canvas write it.
    """
    progress = progress or DraftProgress(None)
    if doomed:
        progress.report(DraftProgress.WRITE, 0.1, f'Clearing {len(doomed)} anchors…')
        client.tokens.bulk_delete(list(doomed))

    piece_ops: List[dict] = []
    bases: List[Tuple[int, int]] = []
    for plan in plans:
        piece_base = len(piece_ops)
        piece_ops.extend({'token_layer_id': layers.node_layer['id'],
                          'text': layers.text_id, 'begin': begin, 'end': end}
                         for begin, end in plan['pieces'])
        bases.append((piece_base, 0))
    progress.report(DraftProgress.WRITE, 0.3, f'Writing {len(piece_ops)} anchors…')
    piece_ids = client.tokens.bulk_create(piece_ops)['ids'] if piece_ops else []
    if len(piece_ids) != len(piece_ops):
        raise RuntimeError(f'The server returned {len(piece_ids)} anchor ids for '
                           f'{len(piece_ops)} anchors.')

    span_ops: List[dict] = []
    for n, plan in enumerate(plans):
        piece_base, _ = bases[n]
        bases[n] = (piece_base, len(span_ops))
        for node in plan['nodes']:
            span_ops.append({
                'span_layer_id': layers.concept_layer['id'],
                'tokens': [piece_ids[piece_base + i] for i in node['piece_indexes']],
                'value': node['concept'],
                'metadata': {**frag, UMR_NAMESPACE: node['meta']},
            })
    progress.report(DraftProgress.WRITE, 0.6, f'Writing {len(span_ops)} nodes…')
    span_ids = client.spans.bulk_create(span_ops)['ids'] if span_ops else []
    if len(span_ids) != len(span_ops):
        raise RuntimeError(f'The server returned {len(span_ids)} node ids for '
                           f'{len(span_ops)} nodes.')

    edge_ops: List[dict] = []
    for n, plan in enumerate(plans):
        _, node_base = bases[n]
        for edge in plan['edges']:
            edge_ops.append({
                'relation_layer_id': layers.relation_layer['id'],
                'source': span_ids[node_base + edge['source']],
                'target': span_ids[node_base + edge['target']],
                'value': edge['role'],
                'metadata': {**frag, UMR_NAMESPACE: {'order': edge['order']}},
            })
    if edge_ops:
        progress.report(DraftProgress.WRITE, 0.9, f'Writing {len(edge_ops)} relations…')
        client.relations.bulk_create(edge_ops)
