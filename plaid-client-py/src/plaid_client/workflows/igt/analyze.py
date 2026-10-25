"""The request preamble and the write tail every igt ``analyze`` service
shares, so each service holds only its model loop::

    request = read_analysis_request(self.client, request_data, response_helper)
    if request is None:
        return
    with begin_analysis(self.client, response_helper, request, fetch_percent=3) as run:
        if run is None or not run.choose_targets():
            return
        plans, replaced = ...  # the model's analyses of run.targets
        finish_analysis(self.client, response_helper, run, plans, service_id=self.service_id,
                        label='PolyGloss analysis', stamp_detail=..., replaced=replaced)

:func:`begin_analysis` holds the document from the read the run plans from
through the last write (Luke's ruling R15), and the result
:func:`finish_analysis` leaves is sent once the document is let go
(:func:`plaid_client.service.held_run`).
"""

import contextlib
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple

from plaid_client.provenance import service_source
from plaid_client.service import PhasedProgress, Refusal, held_run, HeldRun
from plaid_client.workflows.requester import Requester, requester_of

from .derive import derive, field_layer_id, read_skip_word_ids, select_targets
from .write import analysis_result, write_analyses


class AnalysisProgress(PhasedProgress):
    """The write's stretch of the bar, the same in every analyze service. A
    service's own phases are declared on a subclass."""

    WRITE = (88, 99)


@dataclass
class AnalysisRequest:
    """An analyze request, read and checked before anything is fetched.
    ``language`` and ``metalanguage`` are None for a service that does not
    ask for them."""
    request_data: Dict[str, Any]
    document_id: str
    project_id: Optional[str]
    requester: Requester
    word_layer_id: str
    morph_layer_id: str
    sent_layer_id: str
    gloss_field: str
    translation_field: Optional[str]
    overwrite: bool
    language: Optional[str] = None
    metalanguage: Optional[str] = None

    @property
    def layers(self) -> Tuple[str, str, str]:
        """The (word, morpheme, sentence) token layer ids, as :func:`derive` takes them."""
        return self.word_layer_id, self.morph_layer_id, self.sent_layer_id


def read_analysis_request(client, request_data: Dict[str, Any], response_helper, *,
                          project: bool = False, language: bool = False) -> Optional[AnalysisRequest]:
    """The request's ids, fields and overwrite, or None after refusing it.

    The document and the three token layers are required, and the project
    too with ``project`` (a service that reads the project's other
    documents). With ``language`` the request's Language is required and its
    Metalanguage read. The fields come from the request, never from a name:
    the dialog fills the gloss field from its stored Lexicon field, and one
    left out is an error. The translation is context, read only when one is
    named. The parameters are as BaseService coerced them."""
    document_id = request_data.get('document_id')
    project_id = request_data.get('project_id')
    requester = requester_of(client, request_data)
    word_layer_id = request_data.get('word_token_layer_id')
    morph_layer_id = request_data.get('morpheme_token_layer_id')
    sent_layer_id = request_data.get('sentence_token_layer_id')
    required = [('documentId', document_id)]
    if project:
        required.append(('projectId', project_id))
    required += [('wordTokenLayerId', word_layer_id), ('morphemeTokenLayerId', morph_layer_id),
                 ('sentenceTokenLayerId', sent_layer_id)]
    for key, val in required:
        if not val:
            response_helper.error(f'Missing required parameter: {key}')
            return None
    lang = metalang = None
    if language:
        lang = request_data['language'].strip()
        if not lang:
            response_helper.error('Missing required option: Language')
            return None
        metalang = request_data['metalanguage'].strip()
    gloss_field = request_data['gloss_field'].strip()
    if not gloss_field:
        response_helper.error('Choose the gloss field.')
        return None
    return AnalysisRequest(
        request_data=request_data, document_id=document_id, project_id=project_id, requester=requester,
        word_layer_id=word_layer_id, morph_layer_id=morph_layer_id, sent_layer_id=sent_layer_id,
        gloss_field=gloss_field, translation_field=request_data['translation_field'].strip() or None,
        overwrite=request_data['overwrite'], language=lang, metalanguage=metalang)


@dataclass
class AnalysisRun:
    """One analyze run, read under the document lock: the document derived
    (:func:`derive`), and once :meth:`choose_targets` has run the sentences
    holding a word the run may write and the words left alone.
    ``translation_missing`` is the translation field the request named and
    the document lacks: the translation is context only, so a run goes on
    without it, and says so rather than analyzing a little worse without a
    word."""
    request: AnalysisRequest
    held: HeldRun
    doc: Dict[str, Any]
    sentences: List[dict]
    gloss_layer_id: Optional[str]
    translation_missing: Optional[str]
    targets: List[tuple] = field(default_factory=list)
    skipped: Dict[str, int] = field(default_factory=dict)

    def choose_targets(self) -> bool:
        """Choose the words the run may write (the write contract,
        :func:`select_targets`), and say whether there are any. With none the
        run's result is the empty one, sent once the document is let go."""
        self.targets, self.skipped = select_targets(
            self.sentences, self.request.overwrite,
            skip_word_ids=read_skip_word_ids(self.request.request_data))
        self.skipped['unaligned'] = 0
        if not self.targets:
            self.held.result = analysis_result(self.request.document_id, len(self.sentences), 0, self.skipped,
                                               translation_missing=self.translation_missing)
            return False
        return True


@contextlib.contextmanager
def begin_analysis(client, response_helper, request: AnalysisRequest, *,
                   fetch_percent: int) -> Iterator[Optional[AnalysisRun]]:
    """Hold the document, fetch it (reported at ``fetch_percent``) and derive
    it. Yields the :class:`AnalysisRun`, or None once a document the request
    cannot be run on is refused (a layer or the gloss field missing). What the
    body leaves as the run's result or refusal is sent once the document is
    free again."""
    with held_run(client, response_helper, request.document_id) as held:
        response_helper.progress(fetch_percent, 'Fetching document…')
        doc = client.documents.get(request.document_id, include_body=True)
        try:
            sentences, gloss_layer_id = derive(doc, *request.layers, gloss_field=request.gloss_field,
                                               translation_field=request.translation_field)
        except Refusal as e:
            held.refusal = str(e)
            yield None
            return
        translation_field = request.translation_field
        translation_missing = (translation_field if translation_field and not field_layer_id(
            doc, request.sent_layer_id, translation_field, 'Sentence') else None)
        yield AnalysisRun(request=request, held=held, doc=doc, sentences=sentences,
                          gloss_layer_id=gloss_layer_id, translation_missing=translation_missing)


def finish_analysis(client, response_helper, run: AnalysisRun, plans: Sequence[dict], *,
                    service_id: str, label: str, stamp_detail: Dict[str, Any], replaced: int,
                    **extra) -> None:
    """Write ``plans`` as one operation labelled ``"<label> (<n> words)"``
    with who asked, stamped as ``service_id``'s with ``stamp_detail``, and
    leave the result on the run. ``extra`` goes to :func:`analysis_result`
    (``failed``, ``not_asked``, a service's own counts). The writes cannot be
    stopped once begun: a stop halfway would leave words half analyzed."""
    progress = AnalysisProgress(response_helper)
    response_helper.progress(88, 'Writing analyses…')
    source = service_source(service_id)
    request = run.request
    with response_helper.critical():
        with client.operation(request.requester.label(f'{label} ({len(plans)} words)'),
                              kind='service-run', ref=source):
            def wrote(done, total):
                progress.count(AnalysisProgress.WRITE, done, total,
                               f'Writing analyses ({done}/{total} batches)…')

            written = write_analyses(client, plans, run.gloss_layer_id, request.morph_layer_id,
                                     source, stamp_detail, on_progress=wrote)
    run.held.result = analysis_result(request.document_id, len(run.sentences), len(run.targets), run.skipped,
                                      written=written, replaced=replaced,
                                      translation_missing=run.translation_missing, **extra)
