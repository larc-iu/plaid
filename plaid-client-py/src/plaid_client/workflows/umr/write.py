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

Two services write this shape (drafting with a model, and the skeleton from
glosses). What they share lives here: the three request parameters
(:func:`draft_params`), reading the document and choosing the sentences to draft
(:func:`begin_draft`), writing the plans and reporting (:func:`finish_draft`),
the writer and the progress budget. A service supplies only its plan per
sentence.
"""

import contextlib
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from plaid_client.service import check_unchanged, progress_heartbeat
from plaid_client.service_schema import Param

from .graph import Sentence, UmrDocument, read_document
from .layers import UMR_NAMESPACE, UmrLayers, gloss_values, resolve_layers


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


def build_draft_notice(drafted, skipped, failed, first_error=None, kept=0,
                       linked=0) -> Dict[str, Any]:
    """The toast the editor shows when a run finishes. The service owns the
    wording and the severity; the editor maps ``level`` to a colour. A run that
    drafted nothing must not congratulate anyone.

    ``skipped`` and ``kept`` cannot both stand: a sentence with a graph is
    skipped when ``overwrite`` is off, and one a person built is kept when it
    is on. What is kept is what a person made, contributed or verified (the
    three protected states of the provenance convention), so the line says
    that rather than naming one of them. ``linked`` counts the sentences kept
    for another reason: nobody worked on them, but another sentence's graph
    links into them, and replacing them would cut that link.
    """
    def s(n):
        return '' if n == 1 else 's'

    tail = []
    if skipped:
        tail.append(f'Skipped {skipped} sentence{s(skipped)} that already had a graph.')
    if kept:
        tail.append(f'Kept {kept} sentence{s(kept)} a person had worked on.')
    if linked:
        tail.append(f'Kept {linked} sentence{s(linked)} that another sentence links to.')
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
    if kept or linked:
        return {'level': 'warning', 'title': 'Document not modified',
                'message': ' '.join(tail)}
    if failed:
        return {'level': 'warning', 'title': 'Nothing drafted',
                'message': f'Failed {failed} sentence{s(failed)}'
                           + (f': {first_error}' if first_error else '.')}
    return {'level': 'warning', 'title': 'Nothing to draft',
            'message': 'The document has no sentences in scope.'}


def write_graphs(client, layers: UmrLayers, plans: Sequence[dict], frag: dict,
                 progress: Optional[DraftProgress] = None) -> None:
    """Anchors, then nodes, then edges, in three batches.

    A plan for a sentence that already has a graph REPLACES it: the old
    graph's anchor tokens are deleted first, which cascades its concept spans
    and with them every edge and document-level triple on them. So a plan for
    a sentence that is not :attr:`Sentence.redraftable` is refused before
    anything is written, whatever the caller decided. ``frag`` is the
    provenance stamp every write carries: it is FLAT and the app's own half
    sits beside it under ``umr``, exactly as the importer and the canvas write
    it.
    """
    progress = progress or DraftProgress(None)
    kept = [plan['sentence'].index for plan in plans
            if plan['sentence'].nodes and not plan['sentence'].redraftable]
    if kept:
        raise ValueError(f'Sentence {kept[0]} has work a draft may not replace.')
    doomed = [pid for plan in plans for node in plan['sentence'].nodes
              for pid in node.piece_ids]
    if doomed:
        progress.report(DraftProgress.WRITE, 0.1, f'Clearing {len(doomed)} anchors…')
        client.tokens.bulk_delete(doomed)

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


def draft_params() -> List[Param]:
    """The three parameters every drafting service takes: the scope, the
    sentence when the scope is one sentence, and whether to write over a
    machine-made graph."""
    return [
        Param.enum('scope', 'Scope',
                   [('document', 'The whole document'), ('sentence', 'One sentence')],
                   default='document',
                   description='Every sentence, or one sentence by its number.'),
        Param.number('sentence', 'Sentence', default=1, min=1,
                     description='Which sentence, when the scope is one sentence.'),
        Param.boolean('overwrite', 'Overwrite existing graphs', default=False,
                      description='Write over sentences whose graph is machine-made, '
                                  'discarding those graphs. A sentence a person built '
                                  'or confirmed is kept either way, and so is every '
                                  'sentence with a graph when this is off. What is '
                                  'kept is counted in the report.'),
    ]


@dataclass
class DraftRun:
    """One drafting request, read: the document, the sentences to draft and
    the ones left alone, counted as :func:`build_draft_notice` words them.

    ``taken`` is every variable a new node may not take. With ``overwrite`` on
    the graphs about to be replaced free theirs, so a redraft of sentence 1
    writes s1b again rather than s1b2."""
    document_id: str
    project_id: Optional[str]
    read_version: Any
    layers: UmrLayers
    document: UmrDocument
    progress: DraftProgress
    targets: List[Sentence]
    skipped: int
    kept: int
    linked: int
    taken: set


def begin_draft(client, request_data: Dict[str, Any], response_helper) -> Optional[DraftRun]:
    """Read the document a drafting request names and choose its targets, or
    report the missing document id and return None.

    A sentence with words is a target when it has no graph, or when
    ``overwrite`` is on and its graph is :attr:`Sentence.redraftable`. With
    ``overwrite`` off every sentence with a graph is skipped. With it on, a
    sentence a person built or confirmed is kept, and so is one that another
    sentence's block writes an edge or triple on (the machine-writer
    contract), as igt's analyzers redraft machine output only. A sentence
    number the document does not have is a ValueError."""
    document_id = request_data.get('document_id')
    if not document_id:
        response_helper.error('Missing required parameter: documentId')
        return None
    scope = (request_data.get('scope') or 'document').strip()
    overwrite = bool(request_data.get('overwrite', False))
    try:
        wanted = int(request_data.get('sentence') or 1)
    except (TypeError, ValueError):
        wanted = 1

    progress = DraftProgress(response_helper)
    progress.report(DraftProgress.READ, 0.0, 'Reading the document…')
    raw = client.documents.get(document_id, include_body=True)
    layers = resolve_layers(raw)
    document = read_document(raw, layers, gloss=gloss_values(raw, layers))

    in_scope = document.sentences
    if scope == 'sentence':
        in_scope = [s for s in in_scope if s.index == wanted]
        if not in_scope:
            raise ValueError(f'The document has no sentence {wanted}.')
    with_graph = [s for s in in_scope if s.words and s.nodes]
    targets = [s for s in in_scope
               if s.words and (not s.nodes or (overwrite and s.redraftable))]
    taken = document.taken_variables
    for s in targets:
        for node in s.nodes:
            taken.discard(node.var)
    return DraftRun(
        document_id=document_id, project_id=request_data.get('project_id'),
        read_version=raw.get('version'), layers=layers, document=document, progress=progress,
        targets=targets,
        skipped=0 if overwrite else len(with_graph),
        kept=len([s for s in with_graph if s.person_made]) if overwrite else 0,
        linked=(len([s for s in with_graph if not s.redraftable and not s.person_made])
                if overwrite else 0),
        taken=taken)


def finish_draft(client, response_helper, run: DraftRun, plans: Sequence[dict],
                 failures: List[dict], frag: dict, operation: str, writing: str) -> None:
    """Write ``plans`` and send the run's report, or send the report alone when
    there is nothing to write.

    ``failures`` are ``{'sentence': n, 'reason': str}`` for the sentences the
    service could not plan. ``operation`` names the write in the history and
    ``writing`` is the progress line while it runs. The write, and the report
    after it, cannot be stopped once begun: a stop while the document is half
    written would leave anchors with no nodes, and one after the last write
    would call a finished run stopped. The plans were made from the read in
    :func:`begin_draft`, so nothing is written if the document has moved since.
    """
    drafted = len(plans)
    first_error = failures[0]['reason'] if failures else None

    def complete():
        notice = build_draft_notice(drafted, run.skipped, len(failures), first_error,
                                    kept=run.kept, linked=run.linked)
        response_helper.progress(100, notice['title'])
        response_helper.complete({'document_id': run.document_id, 'status': 'success',
                                  'sentences': len(run.document.sentences), 'drafted': drafted,
                                  'skipped': run.skipped, 'kept': run.kept,
                                  'linked': run.linked, 'failed': len(failures),
                                  'sentences_failed': list(failures), 'notice': notice})

    if not plans:
        complete()
        return
    run.progress.report(DraftProgress.WRITE, 0.0, writing)
    with response_helper.critical():
        with client.operation(operation):
            with client.documents.locked(run.document_id):
                check_unchanged(client, run.document_id, run.read_version)
                write_graphs(client, run.layers, plans, frag, run.progress)
        complete()
