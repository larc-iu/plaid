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

from plaid_client.provenance import PROV_DETAIL_KEY, PROV_KEY
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


def _count(n: int, noun: str) -> str:
    return f'{n} {noun}' + ('' if n == 1 else 's')


def _sentences(numbers) -> str:
    """``Sentence 3``, ``Sentences 3 and 5``, ``Sentences 2, 4 and 7``."""
    numbers = [str(n) for n in numbers]
    if len(numbers) == 1:
        return f'Sentence {numbers[0]}'
    return f'Sentences {", ".join(numbers[:-1])} and {numbers[-1]}'


def _sentence_reason(reason) -> str:
    text = str(reason or '').strip() or 'No reason given.'
    return text if text[-1] in '.!?' else text + '.'


def _failure_line(failures: Sequence[dict]) -> str:
    """Every failed sentence with its own reason, sentences that failed for
    the same reason named together, in document order::

        Failed to draft sentence 3: The reply was cut off at the token limit.
        Failed to draft 3 sentences. Sentence 2: ... Sentences 4 and 7: ...
    """
    if not failures:
        return ''
    if len(failures) == 1:
        [only] = failures
        return f"Failed to draft sentence {only['sentence']}: {_sentence_reason(only['reason'])}"
    by_reason: Dict[str, List[Any]] = {}
    for failure in failures:
        by_reason.setdefault(_sentence_reason(failure['reason']), []).append(failure['sentence'])
    groups = ' '.join(f'{_sentences(numbers)}: {reason}' for reason, numbers in by_reason.items())
    return f'Failed to draft {len(failures)} sentences. {groups}'


def build_draft_notice(drafted, skipped, failures: Sequence[dict] = (), kept=0,
                       linked=0) -> Dict[str, Any]:
    """The toast the editor shows when a run finishes. The service owns the
    wording and the severity; the editor maps ``level`` to a colour. A run that
    drafted nothing must not congratulate anyone.

    ``skipped`` counts the sentences with a machine-made graph that were left
    alone because ``overwrite`` was off: the only ones the Overwrite hint is
    true of. ``kept`` counts the sentences a person made, contributed or
    verified anything in (the three protected states of the provenance
    convention), which no run replaces, and ``linked`` the ones kept because
    another sentence's graph links into them. ``failures`` are
    ``{'sentence': n, 'reason': str}``, each named with its own reason. A
    notice with failures is ``sticky``: it stays until dismissed, since it is
    the only record of which sentences a run could not draft.
    """
    def s(n):
        return '' if n == 1 else 's'

    held = []
    if kept:
        held.append(f'Kept {kept} sentence{s(kept)} a person had worked on.')
    if linked:
        held.append(f'Kept {linked} sentence{s(linked)} that another sentence links to.')
    failed = [_failure_line(failures)] if failures else []

    def notice(level, title, parts):
        out = {'level': level, 'title': title, 'message': ' '.join(parts)}
        if failures:
            out['sticky'] = True
        return out

    if drafted:
        skipped_line = ([f'Skipped {skipped} sentence{s(skipped)} that already had a graph.']
                        if skipped else [])
        return notice('success', f'Drafted {drafted} sentence{s(drafted)}',
                      skipped_line + held + failed)
    if skipped:
        if skipped == 1:
            subject, them = '1 sentence already has a graph', 'it'
        elif held or failed:
            subject, them = f'{skipped} sentences already have graphs', 'them'
        else:
            subject, them = f'All {skipped} sentences already have graphs', 'them'
        return notice('warning', 'Document not modified',
                      [f"{subject}. Enable 'Overwrite existing graphs' to draft over {them}."]
                      + held + failed)
    if held:
        return notice('warning', 'Document not modified', held + failed)
    if failures:
        return notice('warning', 'Nothing drafted', failed)
    return notice('warning', 'Nothing to draft', ['The document has no sentences in scope.'])


def run_label(name: str, plans: Sequence[dict]) -> str:
    """What a run's write is called in History: ``UMR draft of sentence 3``,
    or ``UMR draft (4 sentences)``."""
    if len(plans) == 1:
        return f"{name} of sentence {plans[0]['sentence'].index}"
    return f'{name} ({len(plans)} sentences)'


def _predicted(frag: dict, prediction: dict) -> dict:
    """``frag`` with what the writer predicted added to its ``provDetail``,
    so accepted as drafted and corrected afterwards stay distinguishable once
    a person has verified the item (``plaid_client.provenance``). A write
    with no provenance stamp is a person's, and records no prediction."""
    if not frag.get(PROV_KEY):
        return frag
    return {**frag, PROV_DETAIL_KEY: {**(frag.get(PROV_DETAIL_KEY) or {}), **prediction}}


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
    it. Each node's ``provDetail`` also records the concept and attributes it
    was drafted with, and each edge's its role.
    """
    progress = progress or DraftProgress(None)
    kept = [plan['sentence'].index for plan in plans
            if plan['sentence'].nodes and not plan['sentence'].redraftable]
    if kept:
        raise ValueError(f'Sentence {kept[0]} has work a draft may not replace.')
    doomed = [pid for plan in plans for node in plan['sentence'].nodes
              for pid in node.piece_ids]
    if doomed:
        progress.report(DraftProgress.WRITE, 0.1, f'Clearing {_count(len(doomed), "anchor")}…')
        client.tokens.bulk_delete(doomed)

    piece_ops: List[dict] = []
    bases: List[Tuple[int, int]] = []
    for plan in plans:
        piece_base = len(piece_ops)
        piece_ops.extend({'token_layer_id': layers.node_layer['id'],
                          'text': layers.text_id, 'begin': begin, 'end': end}
                         for begin, end in plan['pieces'])
        bases.append((piece_base, 0))
    progress.report(DraftProgress.WRITE, 0.3, f'Writing {_count(len(piece_ops), "anchor")}…')
    piece_ids = client.tokens.bulk_create(piece_ops)['ids'] if piece_ops else []
    if len(piece_ids) != len(piece_ops):
        raise RuntimeError(f'The server returned {len(piece_ids)} anchor ids for '
                           f'{len(piece_ops)} anchors.')

    span_ops: List[dict] = []
    for n, plan in enumerate(plans):
        piece_base, _ = bases[n]
        bases[n] = (piece_base, len(span_ops))
        for node in plan['nodes']:
            prediction = {'value': node['concept']}
            attrs = [{'rel': a['rel'], 'value': a['value']}
                     for a in node['meta'].get('attrs') or []]
            if attrs:
                prediction['attrs'] = attrs
            span_ops.append({
                'span_layer_id': layers.concept_layer['id'],
                'tokens': [piece_ids[piece_base + i] for i in node['piece_indexes']],
                'value': node['concept'],
                'metadata': {**_predicted(frag, prediction), UMR_NAMESPACE: node['meta']},
            })
    progress.report(DraftProgress.WRITE, 0.6, f'Writing {_count(len(span_ops), "node")}…')
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
                'metadata': {**_predicted(frag, {'value': edge['role']}),
                             UMR_NAMESPACE: {'order': edge['order']}},
            })
    if edge_ops:
        progress.report(DraftProgress.WRITE, 0.9, f'Writing {_count(len(edge_ops), "relation")}…')
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
    ``overwrite`` is on and its graph is :attr:`Sentence.redraftable`. A
    sentence a person built or confirmed is kept whatever ``overwrite`` says,
    and so is one that another sentence's block writes an edge or triple on
    (the machine-writer contract), as igt's analyzers redraft machine output
    only. With ``overwrite`` off the rest of the sentences with a graph are
    skipped: the ones an overwrite would redraft. A sentence number the
    document does not have is a ValueError."""
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
        skipped=0 if overwrite else len([s for s in with_graph if s.redraftable]),
        kept=len([s for s in with_graph if s.person_made]),
        linked=len([s for s in with_graph if not s.redraftable and not s.person_made]),
        taken=taken)


def finish_draft(client, response_helper, run: DraftRun, plans: Sequence[dict],
                 failures: List[dict], frag: dict, operation: str, writing: str) -> None:
    """Write ``plans`` and send the run's report, or send the report alone when
    there is nothing to write.

    ``failures`` are ``{'sentence': n, 'reason': str}`` for the sentences the
    service could not plan, each also printed to the operator's log here.
    ``operation`` names the write in the history (see :func:`run_label`) and
    ``writing`` is the progress line while it runs. The write, and the report
    after it, cannot be stopped once begun: a stop while the document is half
    written would leave anchors with no nodes, and one after the last write
    would call a finished run stopped. The plans were made from the read in
    :func:`begin_draft`, so nothing is written if the document has moved since.
    """
    drafted = len(plans)
    for failure in failures:
        print(f"Sentence {failure['sentence']} not drafted: {failure['reason']}")

    def complete():
        notice = build_draft_notice(drafted, run.skipped, failures,
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
