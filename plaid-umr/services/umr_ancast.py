"""
UMR adjudication: two annotators' copies of one text, scored against each other.

Scores one document's UMR annotation against another document of the same
project with AnCast++ (Sun and Xue 2024, `umr4nlp/ancast`), the metric the UMR
community reports inter-annotator agreement in. The usual way the pair comes
about is Plaid's document copy: one text, two annotators, two documents over
the same words.

The report is written on the scored document as METADATA, under
`metadata.umr.adjudication`, and never as annotation. Nothing about a score is
an annotation: an agreement figure is a fact about two documents, it is not
something a later reader should find sitting on a node. The Compare tab reads
the report back.

AnCast reads `.umr` text, so the service renders both documents from Plaid's
storage model to the `.umr` format the app exports. That renderer is a port of
`src/domain/sentenceGraph.js` (`buildDocumentGraph`, `toUmrSentences`) and
`src/domain/format/umrFile.js` plus `penman.js` (`serializeUmrFile`,
`serializePenman`), and `services/tests/test_umr_ancast.py` holds it to the
app's own output over a released corpus, line for line. Both files are read through
`plaid_client.workflows.umr`, the one reading of the storage model that the
drafting services and the assistant share; what is here is the `.umr` writer
and the scoring.

One thing the renderer leaves out on purpose: the gloss lines (`Word Gloss`,
`Morphemes` and the rest of the project's interlinear mapping). AnCast reads
the sentence header, the graph, the alignment and the document level block and
nothing else, so the token block carries the sentence header plus Index and
Words, which is what the format requires, and the project's gloss-line mapping
is not consulted.

    python services/umr_ancast.py --url http://localhost:8085
    python services/umr_ancast.py --url http://localhost:8085 PROJECT_ID

Requirements (on top of plaid-client): ancast (numpy).
"""

import contextlib
import datetime
import importlib.metadata
import logging
import math
import re
from typing import Any, Dict, List, Optional

from plaid_client import BaseService, Param, TASKS
from plaid_client.service import check_unchanged
from plaid_client.workflows.umr import (UMR_NAMESPACE, Graph, group_of, penman_nodes,
                                        read_document, resolve_layers, serialize_penman,
                                        tree_edges)

DEFAULT_SERVICE_ID = 'umr-ancast'

#: The report's shape, so a reader can refuse one it does not understand. 2:
#: a match is an object carrying both concepts and whether it was a leftover.
REPORT_VERSION = 2

SUMMARY = """\
**Adjudicate with AnCast** scores this document's UMR annotation against
another document of the same project: the same text, annotated twice, which is
what Copy document makes.

AnCast++ matches the two annotations node by node and scores the concepts, the
relations and, over the whole document, the temporal, modal and coreference
annotation. Nothing is annotated. The report is written on this document as
metadata and the Compare tab draws it.

- **Document**: which document to score this one against, passed by the Compare
  tab's picker. It must be in the same project and over the same words.
- **Scope**: the sentence graphs together with the document-level annotation,
  or the sentence graphs alone.

A sentence AnCast cannot read is reported as unscored rather than dropped.
"""


# --- from graphs to the sentences the writer takes -------------------------------
# A port of `toUmrSentences` (src/domain/sentenceGraph.js).

def to_umr_sentences(document):
    """The sentence objects `serialize_umr_file` takes, from a document read by
    `plaid_client.workflows.umr` (a port of `toUmrSentences` in
    src/domain/sentenceGraph.js).

    Child order under a node follows the stored `order` across attributes and
    edges, and a re-entrant node is expanded at the first edge reached from the
    root. Nodes the root does not reach (a second fragment) are not written: the
    file has one graph per sentence.
    """
    out = []
    for s in document.sentences:
        root = s.roots[0].var if s.roots else None
        penman = None
        if root:
            nodes = penman_nodes(document, s)
            penman = Graph(root=root, nodes=nodes)
            for parent, index in tree_edges(penman):
                nodes[parent].children[index].inline = True

        alignment = {node.var: node.alignment for node in s.nodes}

        groups = {'temporal': [], 'modal': [], 'coref': []}
        for triple in s.triples:
            bucket = groups.get(triple.group)
            if bucket is None:
                # A group nothing recognizes: the relation decides, rather than
                # the triple going missing from the file.
                bucket = groups[group_of(triple.rel)]
            bucket.append((_name_of(document, triple.source), triple.rel,
                           _name_of(document, triple.target)))
        has_triples = any(groups[name] for name in groups)

        words = [w.text for w in s.words]
        out.append({
            'index': s.index,
            'snt': s.snt or s.index,
            'sentence_text': s.text,
            'meta': s.meta,
            # Index and Words only. AnCast reads none of the gloss lines, and
            # the project's interlinear mapping lives in the app.
            'ilg': [
                {'header': 'Index', 'key': 'index', 'items': [str(i + 1) for i in range(len(words))]},
                {'header': 'Words', 'key': 'words', 'items': words},
            ],
            'words': words,
            'graph': penman,
            'raw_graph': s.raw_graph,
            'raw_alignment': s.raw_alignment,
            'alignment': alignment,
            'doc_graph': ({'var': f's{s.index}s0', **groups} if has_triples else None),
        })
    return out


def _name_of(document, node_id):
    node = document.nodes_by_id.get(node_id)
    return node.var if node else None


# --- the .umr writer -------------------------------------------------------------
# A port of `serializeUmrFile` (src/domain/format/umrFile.js) and
# `serializePenman` (src/domain/format/penman.js).

SEPARATOR = '#' * 80

#: The modern header for the two lines this writer produces. The rest of
#: `MODERN_HEADERS` belongs to gloss lines, which are not written here.
_MODERN_HEADERS = {'index': 'Index', 'words': 'Words'}


def _format_spans(spans) -> str:
    if not spans:
        return '0-0'
    return ','.join(f'{begin}-{end}' for begin, end in spans)


def _serialize_alignment(sentence) -> List[str]:
    alignment = sentence.get('alignment') or {}
    lines = []
    written = set()
    graph = sentence.get('graph')
    if graph and graph.nodes:
        for variable in graph.nodes:
            written.add(variable)
            lines.append(f'{variable}: {_format_spans(alignment.get(variable))}')
    for variable, spans in alignment.items():
        if variable in written:
            continue
        lines.append(f'{variable}: {_format_spans(spans)}')
    return lines


def _serialize_doc_graph(doc_graph) -> List[str]:
    if not doc_graph:
        return []
    groups = [name for name in ('temporal', 'modal', 'coref') if doc_graph.get(name)]
    variable = doc_graph.get('var') or 's0s0'
    if not groups:
        return [f'({variable} / sentence)']
    lines = [f'({variable} / sentence']
    for group_index, name in enumerate(groups):
        triples = [f'({a} {rel} {b})' for a, rel, b in doc_graph[name]]
        last = group_index == len(groups) - 1
        for i, triple in enumerate(triples):
            head = f'    :{name} ({triple}' if i == 0 else f'        {triple}'
            closing = ('))' if last else ')') if i == len(triples) - 1 else ''
            lines.append(head + closing)
    return lines


def _ilg_lines_to_write(sentence):
    """A line with nothing on it is dropped: the standard's grammar requires at
    least one item after the header."""
    return [line for line in (sentence.get('ilg') or []) if line['items']]


def serialize_umr_file(sentences) -> str:
    """Write sentences as a `.umr` file: 80 hashes, the four blocks in order
    with their header comments, one empty line after each block and two after
    the last."""
    out: List[str] = []
    for sentence in sentences or []:
        out.append(SEPARATOR)
        out.extend(sentence.get('meta') or [])
        text = (sentence.get('sentence_text') or '').strip()
        snt = sentence.get('snt') or sentence['index']
        out.append(f'# :: snt{snt}' + (f'\t{text}' if text else ''))
        ilg = _ilg_lines_to_write(sentence)
        width = max([0] + [len(_MODERN_HEADERS.get(line['key'], line['header'])) + 1
                           for line in ilg])
        for line in ilg:
            header = _MODERN_HEADERS.get(line['key'], line['header'])
            out.append(f'{header}:'.ljust(width + 1) + ' '.join(line['items']))
        out.append('')

        # A graph kept as text (one the app's parser could not read) is written
        # back as it was, alignment block included.
        raw_graph = sentence.get('raw_graph')
        out.append('# sentence level graph:')
        if isinstance(raw_graph, str):
            if raw_graph:
                out.extend(raw_graph.split('\n'))
        else:
            graph = serialize_penman(sentence['graph']) if sentence.get('graph') else ''
            if graph:
                out.extend(graph.split('\n'))
        out.append('')

        out.append('# alignment:')
        if isinstance(raw_graph, str):
            if sentence.get('raw_alignment'):
                out.extend(sentence['raw_alignment'].split('\n'))
        else:
            out.extend(_serialize_alignment(sentence))
        out.append('')

        out.append('# document level annotation:')
        out.extend(_serialize_doc_graph(sentence.get('doc_graph')))
        out.append('')
        out.append('')
    return '\n'.join(out) + '\n' if out else ''


def read_umr(raw):
    """One document, read once: its graph and its `.umr` text. The handler needs
    both and a document is read the once, because reading a long one is not
    free."""
    document = read_document(raw, resolve_layers(raw))
    return document, serialize_umr_file(to_umr_sentences(document))


def render_umr(raw) -> str:
    """One document, from Plaid's storage model to `.umr` text."""
    return read_umr(raw)[1]


def words_of(document) -> List[List[str]]:
    """Each sentence's words, for the check that two documents are over one
    text."""
    return [[w.text for w in s.words] for s in document.sentences]


# --- driving ancast --------------------------------------------------------------

#: The blocks of a `.umr` file, as ancast's `evaluate_doc` reads them: split on
#: a blank line between blocks (`io_utils.load_txt`, delimiter `\n\n\n`), empty
#: strings dropped.
BLOCK_DELIMITER = '\n\n\n'


def split_blocks(text: str) -> List[str]:
    return [block for block in (text or '').split(BLOCK_DELIMITER) if block]


#: A node in PENMAN: an opening paren, the variable, a slash, the concept.
_NODE = re.compile(r'\(\s*([^\s/()]+)\s*/\s*([^\s()]+)')


def concepts_of(block: str) -> Dict[str, str]:
    """Every node's concept in one block, by variable, exactly as written.
    ancast keeps a concept as a lower-cased name and a sense number, which does
    not always spell it back the way the annotator did."""
    return dict(_NODE.findall(block or ''))


#: An alignment line whose node takes more than one range, and nothing else. It
#: must not match a sentence header, which carries commas of its own
#: (`# :: snt2  If it rains , Alana won't water the plants .`), so the whole
#: value has to be ranges and the variable may not begin with a hash.
_MULTI_RANGE = re.compile(
    r'^(\s*)([^\s:#]+)\s*:\s*([0-9]+)-[0-9]+(?:\s*,\s*[0-9]+-[0-9]+)*\s*,'
    r'\s*[0-9]+-([0-9]+)\s*$')


def flatten_alignment_ranges(text: str) -> str:
    """Collapse a node's discontiguous alignment to its outer range for
    ancast's reader.

    `ancast.ops.parse_alignment` hands a line's value to
    `Match.transform_alignment`, which splits it on `-` and calls `int` on the
    two halves. A discontiguous anchor, which Plaid writes as `s1a: 1-1,3-3`
    and the format allows, makes that raise, and the exception takes the whole
    run with it. The transformed alignment is only ever read under
    `anchor_with_alignment`, which is off at ancast's defaults and is what this
    service runs with, so the outer span of the anchor stands in and no score
    moves. The `.umr` the app exports is unaffected: this is done to the copy
    handed to the metric.
    """
    lines = []
    for line in (text or '').split('\n'):
        match = _MULTI_RANGE.match(line)
        if match:
            indent, variable, begin, end = match.groups()
            line = f'{indent}{variable}: {begin}-{end}'
        lines.append(line)
    return '\n'.join(lines)


@contextlib.contextmanager
def _quiet_ancast():
    """ancast narrates every document at INFO. The operator wants its warnings,
    not a line per sentence."""
    logger = logging.getLogger('ancast')
    previous = logger.level
    logger.setLevel(logging.WARNING)
    try:
        yield
    finally:
        logger.setLevel(previous)


def _recorder(base):
    """A Match class that keeps every `MatchResolution` it is handed.

    `summarize` is ancast's one per-sentence hook, called once for each
    sentence it scored, in order. The base builds a CSV row there, which costs
    a re-serialization of both graphs and is thrown away here.
    """

    class Recording(base):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            self.resolutions = []

        def summarize(self, match_res):
            self.resolutions.append(match_res)

    return Recording


def _f(value) -> Optional[float]:
    """One score, as the report carries it: a plain float to four places."""
    return None if value is None else round(float(value), 4)


def _sentence_report(match_res, this_concepts=None, other_concepts=None) -> Dict[str, Any]:
    """One sentence's entry, from what the metric resolved.

    `match_list01` maps this document's variables to the other's, and
    `match_list10` the other way. An unmatched node's value is the string
    `NULL` followed by its own variable (`greedy_match_list`), which is also
    what `Match.gname` asserts on, so a `NULL` prefix is the way a node with no
    counterpart is spelled. The keys on both sides are plain variables, taken
    from each sentence's `var2node`, which is what the report carries.

    A match carries both concepts, so a pair that differs in concept reads as
    the disagreement it is, and whether it is a LEFTOVER: `quality_list01` is
    0 for a pair anchored by a concept found once in both graphs and in the
    text, 1 to 5 for one found by mutual best similarity with the neighbours
    counted, and -1 for one `greedy_match_list` made from the nodes left over,
    which pairs a `dog` with a `cat` sooner than leave either alone.
    """
    def is_null(value):
        return str(value).startswith('NULL')

    this_concepts = this_concepts or {}
    other_concepts = other_concepts or {}
    quality = match_res.quality_list01
    matches = [{'this': key, 'other': value,
                'thisConcept': this_concepts.get(key),
                'otherConcept': other_concepts.get(value),
                'leftover': quality.get(key) == -1}
               for key, value in match_res.match_list01.items() if not is_null(value)]
    unmatched = [key for key, value in match_res.match_list01.items() if is_null(value)]
    unmatched_other = [key for key, value in match_res.match_list10.items() if is_null(value)]
    return {
        'index': match_res.umr0.sent_num,
        'concept': _f(match_res.concept_match_fscore),
        'labeled': _f(match_res.lbd_fscore),
        'unlabeled': _f(match_res.ulbd_fscore),
        'weighted': _f(match_res.wlbd_fscore),
        'smatch': _f(match_res.smatch_format_score),
        'matches': matches,
        'unmatched': unmatched,
        'unmatchedOther': unmatched_other,
        'skipped': None,
    }


def _skipped_report(index: int) -> Dict[str, Any]:
    return {'index': index, 'concept': None, 'labeled': None, 'unlabeled': None,
            'weighted': None, 'smatch': None, 'matches': [], 'unmatched': [],
            'unmatchedOther': [],
            'skipped': 'AnCast could not read one of the two graphs.'}


def score_umr(this_text: str, other_text: str, scope: str = 'doc'):
    """Score one `.umr` text against another, in memory.

    Returns ``(scores, sentences)`` in the report's own shape. `this_text` is
    the document being scored (ancast's "pred"), `other_text` the one it is
    scored against (ancast's "gold").
    """
    # Imported here rather than at the top so that reading this module (the
    # release jar's boot smoke test does) costs nothing and says nothing when
    # ancast is not installed.
    from ancast.document import DocumentMatch, SentenceMatch

    this_blocks = split_blocks(flatten_alignment_ranges(this_text))
    other_blocks = split_blocks(flatten_alignment_ranges(other_text))
    doc_scope = scope != 'snt'
    match = _recorder(DocumentMatch if doc_scope else SentenceMatch)(
        **({} if doc_scope else {'format': 'umr'}))

    with _quiet_ancast():
        match.compute_scores(pred_inputs=this_blocks, gold_inputs=other_blocks)

    def group(name, value):
        # A group neither document annotates has no score: ancast divides
        # nothing by nothing and says 0, which reads as total disagreement.
        if not (match.doc_annotations_test.get(name) or match.doc_annotations_gold.get(name)):
            return None
        return _f(value)

    scores = {
        'sentence': _f(match.sent_fscore),
        'modal': group('modal', match.modal_fscore) if doc_scope else None,
        'temporal': group('temporal', match.temporal_fscore) if doc_scope else None,
        'coref': group('coref', match.coref_fscore) if doc_scope else None,
        'comprehensive': _f(match.comp_fscore) if doc_scope else None,
    }

    # ancast numbers a block from 1 as it walks them and skips a sentence whose
    # graph it cannot read, saying so only in its log. A skipped sentence is
    # reported as skipped rather than going missing from the list.
    def report_of(m):
        i = m.umr0.sent_num - 1
        return _sentence_report(
            m,
            concepts_of(this_blocks[i]) if i < len(this_blocks) else None,
            concepts_of(other_blocks[i]) if i < len(other_blocks) else None)

    scored = {r['index']: r for r in (report_of(m) for m in match.resolutions)}
    sentences = [scored.get(i + 1) or _skipped_report(i + 1) for i in range(len(this_blocks))]
    return scores, sentences


# --- the report ------------------------------------------------------------------

def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def ancast_version() -> str:
    try:
        return f"ancast {importlib.metadata.version('ancast')}"
    except Exception:
        return 'ancast'


def build_report(scores, sentences, against, scope: str, at: Optional[str] = None):
    """The whole report, as it is stored under `metadata.umr.adjudication`."""
    return {
        'version': REPORT_VERSION,
        'tool': ancast_version(),
        'against': {'id': against['id'], 'name': against['name']},
        'at': at or _now(),
        'scope': 'snt' if scope == 'snt' else 'doc',
        'scores': scores,
        'sentences': sentences,
    }


def build_notice(report, scored: int, skipped: int):
    """What the run dialog says when it finishes. The service owns the wording
    and the severity, and the app maps `level` to a colour."""
    def s(n):
        return '' if n == 1 else 's'

    name = report['against']['name']
    scores = report['scores']
    if not scored:
        return {'level': 'warning', 'title': 'Nothing scored',
                'message': f'AnCast could not read a graph in any of the '
                           f'{skipped} sentence{s(skipped)}.'}
    # In whole percents, rounded as the Compare tab rounds them (JavaScript's
    # Math.round, half up). Python's round() takes a half to the even side,
    # so 0.825 would read 82% here and 83% on the tab.
    def pct(x):
        return f'{math.floor(x * 100 + 0.5)}%'

    parts = [f"Sentence graphs {pct(scores['sentence'])}"]
    if scores['comprehensive'] is not None:
        parts.append(f"comprehensive {pct(scores['comprehensive'])}")
    tail = f'Scored {scored} sentence{s(scored)}.'
    if skipped:
        tail += f' AnCast could not read {skipped} sentence{s(skipped)}.'
    return {'level': 'success', 'title': f'{", ".join(parts)} against {name}',
            'message': tail}


# --- resolving the other document ------------------------------------------------

def resolve_against(client, project_id, document_id, against):
    """Which document to score against: an id first, then an exact name among
    the project's documents.

    Refuses rather than guessing. A name that two documents share is a refusal
    and not a choice, because the wrong one would be scored and the report would
    name the right one.
    """
    wanted = str(against or '').strip()
    if not wanted:
        raise ValueError('Name the document to score this one against.')
    if wanted == document_id:
        raise ValueError('A document cannot be scored against itself. '
                         'Pick the other annotator\'s copy.')
    if not project_id:
        return wanted
    entries = client.projects.list_documents(project_id) or []
    for entry in entries:
        if entry.get('id') == wanted:
            return wanted
    named = [entry for entry in entries if entry.get('name') == wanted]
    if len(named) > 1:
        raise ValueError(f'{len(named)} documents in this project are called "{wanted}". '
                         'Name the one to score against by its id.')
    if not named:
        raise ValueError(f'This project has no document called "{wanted}".')
    if named[0].get('id') == document_id:
        raise ValueError('A document cannot be scored against itself. '
                         'Pick the other annotator\'s copy.')
    return named[0]['id']


def check_same_words(this_words, other_words, this_name, other_name) -> None:
    """The two documents must be over one text, the way `planImport` refuses an
    attach onto different words. Scoring two annotations of different texts
    would produce a number, and the number would mean nothing."""
    if len(this_words) != len(other_words):
        raise ValueError(f'"{this_name}" has {len(this_words)} sentences and '
                         f'"{other_name}" {len(other_words)}. '
                         'The two must be annotations of one text.')
    for i, (mine, theirs) in enumerate(zip(this_words, other_words)):
        if mine != theirs:
            raise ValueError(f'Sentence {i + 1} differs: "{this_name}" has '
                             f'"{" ".join(mine)}", "{other_name}" has "{" ".join(theirs)}". '
                             'The two must be annotations of one text.')


# --- progress --------------------------------------------------------------------

class ScoreProgress:
    """A fixed percentage budget over the phases, so the bar moves for the same
    reason on every document:

        2-30    reading both documents
        30-85   rendering and scoring
        85-100  writing the report

    `report` is a CANCELLATION CHECKPOINT (ResponseHelper.progress raises), so
    every call in the write phase sits inside `critical()`.
    """

    READ, SCORE, WRITE = (2, 30), (30, 85), (85, 100)

    def __init__(self, helper=None):
        self._helper = helper

    @staticmethod
    def _percent(phase, fraction):
        low, high = phase
        return int(low + (high - low) * min(max(fraction, 0.0), 1.0))

    def report(self, phase, fraction, message):
        if self._helper:
            self._helper.progress(self._percent(phase, fraction), message)


# --- the service -----------------------------------------------------------------

class UmrAncastService(BaseService):
    """Scores one document's UMR against another's with AnCast++ and writes the
    report on the scored document as metadata.

    Built on the shared BaseService SDK (client bootstrap, registration, the
    single-flight lock, the CLI loop). The document to score against arrives in
    the request rather than as a parameter: the Compare tab owns the picker, and
    a text box in the run dialog would be a second and worse way to say the same
    thing.
    """

    def __init__(self):
        super().__init__(
            service_id=DEFAULT_SERVICE_ID,
            service_name='AnCast adjudication',
            description='Scores this document\'s UMR against another annotator\'s copy with '
                        'the AnCast++ metric',
            tasks=[TASKS.COMPARE],
            summary=SUMMARY,
            parameters=[
                Param.enum('scope', 'Scope',
                           [('doc', 'Sentence graphs and the document-level annotation'),
                            ('snt', 'Sentence graphs only')],
                           default='doc',
                           description='Score the temporal, modal and coreference annotation '
                                       'as well as the sentence graphs, or the graphs alone.'),
            ],
        )

    def process_request(self, request_data: Dict[str, Any], response_helper) -> None:
        document_id = request_data.get('document_id')
        if not document_id:
            response_helper.error('Missing required parameter: documentId')
            return
        project_id = request_data.get('project_id')
        scope = 'snt' if (request_data.get('scope') or 'doc').strip() == 'snt' else 'doc'

        progress = ScoreProgress(response_helper)
        progress.report(ScoreProgress.READ, 0.0, 'Reading the document…')
        document = self.client.documents.get(document_id, include_body=True)
        read_version = document.get('version')
        this_name = document.get('name') or 'this document'

        against_id = resolve_against(self.client, project_id, document_id,
                                     request_data.get('against'))
        progress.report(ScoreProgress.READ, 0.5, 'Reading the other document…')
        other = self.client.documents.get(against_id, include_body=True)
        other_name = other.get('name') or against_id
        if other.get('id') == document_id:
            raise ValueError('A document cannot be scored against itself. '
                             'Pick the other annotator\'s copy.')

        this_graph, this_text = read_umr(document)
        other_graph, other_text = read_umr(other)
        check_same_words(words_of(this_graph), words_of(other_graph), this_name, other_name)
        progress.report(ScoreProgress.READ, 1.0, 'Reading the other document…')

        progress.report(ScoreProgress.SCORE, 0.0, f'Scoring against {other_name}…')
        scores, sentences = score_umr(this_text, other_text, scope)
        skipped = len([s for s in sentences if s['skipped']])
        scored = len(sentences) - skipped

        report = build_report(scores, sentences, {'id': against_id, 'name': other_name}, scope)
        notice = build_notice(report, scored, skipped)

        # Everything from here must finish once begun. The final report is inside
        # the same block, so a checkpoint after the write cannot throw a finished
        # run away and call it stopped.
        progress.report(ScoreProgress.WRITE, 0.0, 'Writing the report…')
        with response_helper.critical():
            with self.client.operation(f'AnCast adjudication against {other_name}'):
                with self.client.documents.locked(document_id):
                    # The scores describe the document as it was read. If it has
                    # moved since, the report would be a claim about a state
                    # that is gone.
                    check_unchanged(self.client, document_id, read_version)
                    self._write(document_id, report)

            response_helper.progress(100, notice['title'])
            response_helper.complete({
                'document_id': document_id, 'status': 'success',
                'against': report['against'], 'scope': scope,
                'scores': report['scores'],
                'sentences': len(sentences), 'sentences_scored': scored,
                'sentences_skipped': skipped,
                'notice': notice,
            })

    def _write(self, document_id, report) -> None:
        """The report, under the document's `umr` metadata namespace. One op
        sets that one key, so whatever else the namespace holds stays."""
        self.client.documents.patch_metadata(
            document_id, [{'op': 'set', 'path': [UMR_NAMESPACE, 'adjudication'], 'value': report}])


def main():
    UmrAncastService().run()


if __name__ == '__main__':
    # CLI (handled by BaseService.run):
    #   python umr_ancast.py                       → every accessible project
    #   python umr_ancast.py PROJECT_ID            → one project
    #   --url URL                                  → Plaid API URL (default :8080)
    main()
