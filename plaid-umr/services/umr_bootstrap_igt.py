"""
UMR skeleton from glosses: a first graph from the project's own interlinear
annotation, with no model.

For every sentence it makes one node per word that the project already says
something about: a word linked to a vocabulary entry takes the entry's
HEADWORD as its concept (UMR's stage 0, "use the lemma as is"), and a word
with a gloss but no link takes the lexical part of its gloss. Grammatical
gloss abbreviations (Leipzig rules, plus whatever a language adds) become
the attributes they stand for: `3SG` is `:refer-person 3rd :refer-number
singular`, `NEG` is `:polarity -`, `HAB` is `:aspect habitual`. The word
whose glosses carry tense or aspect is marked as the sentence's root, else
the first node is.

It draws NO edges. A role is a claim about who did what, and glosses do not
say; the annotator connects the nodes on the canvas, where a node with its
concept, anchor and attributes already in place is most of the typing saved.
Everything it writes is stamped machine-made.

The language-specific half (Buchholz et al. 2024 wrote such heuristics for
Arapaho) is a table: `--abbreviations table.json` adds or overrides gloss
abbreviations, `{"ABBR": [":relation", "value"], "TAM": ["root"], "X": null}`,
where `["root"]` marks an abbreviation as a tense or aspect marker that
elects the root and `null` removes a default.

    python services/umr_bootstrap_igt.py --url http://localhost:8085
    python services/umr_bootstrap_igt.py --url ... --abbreviations arapaho.json

Requirements (on top of plaid-client): none.
"""

import argparse
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional

from plaid_client import BaseService, TASKS, Param, stamp_inferred, service_source
from plaid_client.service import check_unchanged

# The draft service's readers and writer: the same layers, the same anchors,
# the same three-pass write. One reading of the storage model for both.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from umr_draft_llm import (DraftProgress, UMR_NAMESPACE, build_draft_notice,  # noqa: E402
                           gloss_layers_of, next_variable, read_sentences, resolve_layers,
                           taken_variables)

DEFAULT_SERVICE_ID = 'umr-bootstrap-igt'

SUMMARY = """\
**Skeleton from glosses** writes a first graph for each sentence from the
project's own annotation, with no model: one node per word that is linked to a
vocabulary entry or carries a gloss, anchored to the word, with the entry's
headword or the gloss's lexical part as its concept and the grammatical gloss
abbreviations as attributes (`3SG`, `NEG`, `HAB`). The word whose glosses
carry tense or aspect is the root. No relations are drawn: those are yours to
add on the canvas.

- **Scope**: the whole document, or one sentence by its number.
- **Sentence**: which sentence, when the scope is one sentence.
- **Overwrite existing graphs**: off by default, so a sentence that already
  has nodes is left alone and counted.

Everything it writes is stamped machine-made and shows as unverified until a
person edits or confirms it.
"""

#: What a grammatical gloss abbreviation stands for: an attribute and its
#: value, or `('root',)` for a tense or aspect marker that says the word is
#: the sentence's event. Leipzig Glossing Rules abbreviations, upper case.
#: Only values the validator accepts, so nothing written here is an error the
#: annotator has to clean up.
ABBREVIATIONS: Dict[str, Optional[tuple]] = {
    'SG': (':refer-number', 'singular'),
    'PL': (':refer-number', 'plural'),
    'DU': (':refer-number', 'dual'),
    'TRI': (':refer-number', 'trial'),
    'PAUC': (':refer-number', 'paucal'),
    'NSG': (':refer-number', 'non-singular'),
    '1': (':refer-person', '1st'),
    '2': (':refer-person', '2nd'),
    '3': (':refer-person', '3rd'),
    '4': (':refer-person', '4th'),
    'NEG': (':polarity', '-'),
    'IMP': (':mode', 'imperative'),
    'Q': (':mode', 'interrogative'),
    'INT': (':mode', 'interrogative'),
    'HAB': (':aspect', 'habitual'),
    'PFV': (':aspect', 'perfective'),
    'IPFV': (':aspect', 'imperfective'),
    'PST': ('root',),
    'PRS': ('root',),
    'FUT': ('root',),
    'NPST': ('root',),
    'PROG': ('root',),
    'PRF': ('root',),
    'COMPL': ('root',),
    'IRR': ('root',),
    'REAL': ('root',),
}

#: A person and number written as one abbreviation: `3SG`, `1PL`, `2DU`.
_PERSON_NUMBER = re.compile(r'^([1-4])(SG|PL|DU|TRI|PAUC|NSG)$')
#: What a gloss is cut on: `bark.PRS`, `dog-PL`, `3SG=go`, `see:PST`.
_GLOSS_CUT = re.compile(r'[.\-=:~<>\s]+')
_LETTER = re.compile(r'[^\W\d_]', re.UNICODE)


def load_abbreviations(path: Optional[str]) -> Dict[str, Optional[tuple]]:
    """The default table, with a language's JSON laid over it."""
    table = dict(ABBREVIATIONS)
    if not path:
        return table
    with open(path, encoding='utf-8') as f:
        extra = json.load(f)
    if not isinstance(extra, dict):
        raise ValueError('The abbreviations file must hold one JSON object.')
    for key, value in extra.items():
        if value is None:
            table.pop(key.upper(), None)
        elif isinstance(value, list) and value and all(isinstance(v, str) for v in value):
            table[key.upper()] = tuple(value)
        else:
            raise ValueError(f'Abbreviation {key!r} must map to a list of strings or null.')
    return table


def read_gloss(gloss: str, table) -> Dict[str, Any]:
    """One gloss value read into what it says: the lexical part (the first
    piece that is not an abbreviation), the attributes its abbreviations
    stand for, and whether one of them marks tense or aspect."""
    lexical = None
    attrs: List[tuple] = []
    eventive = False
    for piece in _GLOSS_CUT.split(str(gloss or '').strip()):
        if not piece:
            continue
        m = _PERSON_NUMBER.match(piece)
        keys = [m.group(1), m.group(2)] if m else [piece]
        known = [k for k in keys if k.upper() in table and (k.upper() == k or not _LETTER.search(k))]
        if m or (known and len(known) == len(keys)):
            for k in keys:
                what = table.get(k.upper())
                if what == ('root',):
                    eventive = True
                elif what:
                    attrs.append(what)
            continue
        # An upper-case piece is grammatical whether or not the table knows
        # it; a piece with a lower-case letter is a word.
        if piece.upper() == piece and _LETTER.search(piece):
            continue
        if lexical is None and _LETTER.search(piece):
            lexical = piece
    return {'lexical': lexical, 'attrs': attrs, 'eventive': eventive}


def concept_from(text: str) -> str:
    """A concept from a headword or a lexical gloss: lower case, spaces as
    hyphens, nothing a PENMAN reader would choke on."""
    out = re.sub(r'\s+', '-', str(text or '').strip().lower())
    out = re.sub(r'[()"\s/]', '', out)
    return out


def headwords_of(vocabularies) -> Dict[str, str]:
    """Every entry's headword form by entry id: an entry's own form, or the
    form at the top of a sense's parent chain (src/domain/vocabLexicon.js)."""
    out = {}
    for vocab in vocabularies or []:
        items = vocab.get('items') or []
        by_id = {it['id']: it for it in items if it.get('id')}
        for it in items:
            cur, seen = it, set()
            while cur and cur['id'] not in seen:
                seen.add(cur['id'])
                parent = (cur.get('metadata') or {}).get('parent')
                up = by_id.get(parent) if parent else None
                if not up:
                    break
                cur = up
            out[it['id']] = (cur or it).get('form') or it.get('form') or ''
    return out


def links_by_token(info) -> Dict[str, List[str]]:
    """Entry ids by the word or morpheme token linked to them."""
    out: Dict[str, List[str]] = {}
    for layer in (info['word_layer'], info['morpheme_layer']):
        for vocab in (layer or {}).get('vocabs') or []:
            for link in vocab.get('vocab_links') or []:
                item = (link.get('vocab_item') or {}).get('id')
                if not item:
                    continue
                for token in link.get('tokens') or []:
                    out.setdefault(token, []).append(item)
    return out


def plan_sentence(sentence, gloss_layers, links, headwords, table, taken):
    """One sentence's skeleton as writes: ``(pieces, nodes, edges)``, in the
    draft service's shape, so the same writer takes it. Edges are always []."""
    pieces = []
    nodes = []
    root_at = None
    for word in sentence['words']:
        if not _LETTER.search(word['text']) and not re.search(r'\d', word['text']):
            continue
        morphemes = [m for m in sentence['morphemes']
                     if word['begin'] <= m['begin'] and m['end'] <= word['end']]
        tokens = [word['id']] + [m['id'] for m in morphemes]
        entry = next((e for t in tokens for e in links.get(t, []) if e in headwords), None)
        glosses = []
        for layer in gloss_layers:
            if layer['scope'] == 'word':
                value = layer['values'].get(word['id'])
                if value:
                    glosses.append(value)
            elif layer['scope'] == 'morpheme':
                glosses.extend(v for v in (layer['values'].get(m['id']) for m in morphemes) if v)
        read = [read_gloss(g, table) for g in glosses]
        lexical = next((r['lexical'] for r in read if r['lexical']), None)
        concept = concept_from(headwords[entry]) if entry else concept_from(lexical or '')
        if not concept:
            continue
        attrs = []
        seen = set()
        for r in read:
            for rel, value in r['attrs']:
                if rel not in seen:
                    seen.add(rel)
                    attrs.append({'rel': rel, 'value': value, 'order': len(attrs)})
        var = next_variable(sentence['index'], concept, taken)
        taken.add(var)
        if root_at is None and any(r['eventive'] for r in read):
            root_at = len(nodes)
        pieces.append((word['begin'], word['end']))
        nodes.append({'concept': concept, 'meta': {'var': var, 'attrs': attrs},
                      'piece_indexes': [len(pieces) - 1]})
    if nodes:
        nodes[root_at or 0]['meta']['root'] = True
    return pieces, nodes, []


class UmrBootstrapService(BaseService):
    """A skeleton graph per sentence from the project's glosses and links."""

    def __init__(self):
        super().__init__(
            service_id=DEFAULT_SERVICE_ID,
            service_name='UMR skeleton from glosses',
            description='Writes a first graph per sentence from the vocabulary links and '
                        'glosses the project already has: anchored nodes with concepts '
                        'and attributes, no relations, no model.',
            tasks=[TASKS.DRAFT_GRAPH],
            summary=SUMMARY,
            parameters=[
                Param.enum('scope', 'Scope',
                           [('document', 'The whole document'), ('sentence', 'One sentence')],
                           default='document',
                           description='Every sentence, or one sentence by its number.'),
                Param.number('sentence', 'Sentence', default=1, min=1,
                             description='Which sentence, when the scope is one sentence.'),
                Param.boolean('overwrite', 'Overwrite existing graphs', default=False,
                              description='Write over sentences that already have nodes, '
                                          'discarding those graphs. When off, they are left '
                                          'untouched and counted.'),
            ],
        )
        self.abbreviations = dict(ABBREVIATIONS)

    # -- CLI --
    def add_arguments(self, parser: argparse.ArgumentParser) -> None:
        parser.add_argument('--abbreviations', default=None,
                            help='A JSON object of gloss abbreviations to add or remove, '
                                 'for a language whose glosses go beyond the Leipzig rules.')

    def setup(self, args) -> None:
        self.abbreviations = load_abbreviations(getattr(args, 'abbreviations', None))

    # -- request --
    def process_request(self, request_data: Dict[str, Any], response_helper) -> None:
        document_id = request_data.get('document_id')
        if not document_id:
            response_helper.error('Missing required parameter: documentId')
            return
        project_id = request_data.get('project_id')
        scope = (request_data.get('scope') or 'document').strip()
        overwrite = bool(request_data.get('overwrite', False))
        try:
            wanted = int(request_data.get('sentence') or 1)
        except (TypeError, ValueError):
            wanted = 1

        progress = DraftProgress(response_helper)
        progress.report(DraftProgress.READ, 0.0, 'Reading the document…')
        document = self.client.documents.get(document_id, include_body=True)
        read_version = document.get('version')
        info = resolve_layers(document)
        sentences = read_sentences(info)
        gloss_layers = gloss_layers_of(info)

        # The project's vocabularies, for the headword a linked word takes.
        headwords: Dict[str, str] = {}
        if project_id:
            progress.report(DraftProgress.READ, 0.5, 'Reading the vocabularies…')
            try:
                project = self.client.projects.get(project_id)
                vocabularies = [self.client.vocab_layers.get(v['id'], include_items=True)
                                for v in (project.get('vocabs') or []) if v.get('id')]
                headwords = headwords_of(vocabularies)
            except Exception as exc:
                print(f'Could not read the vocabularies: {exc}')
        links = links_by_token(info)

        in_scope = sentences
        if scope == 'sentence':
            in_scope = [s for s in sentences if s['index'] == wanted]
            if not in_scope:
                raise ValueError(f'The document has no sentence {wanted}.')
        targets = [s for s in in_scope if s['words'] and (overwrite or not s['nodes'])]
        skipped = len([s for s in in_scope if s['words'] and s['nodes']]) if not overwrite else 0
        progress.report(DraftProgress.READ, 1.0, 'Reading the document…')

        taken = taken_variables(info)
        if overwrite:
            for s in targets:
                for node in s['nodes']:
                    taken.discard(node['var'])
        plans = []
        failures = []
        for sentence in targets:
            pieces, nodes, edges = plan_sentence(sentence, gloss_layers, links, headwords,
                                                 self.abbreviations, taken)
            if not nodes:
                failures.append({'sentence': sentence['index'],
                                 'reason': 'no word has a vocabulary link or a gloss'})
                continue
            plans.append({'sentence': sentence, 'pieces': pieces, 'nodes': nodes,
                          'edges': edges})

        drafted = len(plans)
        first_error = failures[0]['reason'] if failures else None
        if not plans:
            notice = build_draft_notice(0, skipped, len(failures), first_error)
            response_helper.progress(100, notice['title'])
            response_helper.complete({'document_id': document_id, 'status': 'success',
                                      'sentences': len(sentences), 'drafted': 0,
                                      'skipped': skipped, 'failed': len(failures),
                                      'sentences_failed': failures, 'notice': notice})
            return

        frag = stamp_inferred(service_source(self.service_id), detail={'method': 'glosses'})
        progress.report(DraftProgress.WRITE, 0.0, f'Writing {drafted} skeletons…')
        doomed = [pid for plan in plans if overwrite
                  for node in plan['sentence']['nodes'] for pid in node['piece_ids']]
        with response_helper.critical():
            with self.client.operation(f'UMR skeleton from glosses ({drafted} sentences)'):
                with self.client.documents.locked(document_id):
                    check_unchanged(self.client, document_id, read_version)
                    self._write(info, plans, doomed, frag, progress)
            notice = build_draft_notice(drafted, skipped, len(failures), first_error)
            response_helper.progress(100, notice['title'])
            response_helper.complete({'document_id': document_id, 'status': 'success',
                                      'sentences': len(sentences), 'drafted': drafted,
                                      'skipped': skipped, 'failed': len(failures),
                                      'sentences_failed': failures, 'notice': notice})

    # The draft service's writer, unchanged: anchors, then nodes, then edges.
    def _write(self, info, plans, doomed, frag, progress) -> None:
        from umr_draft_llm import UmrDraftService
        UmrDraftService._write(self, info, plans, doomed, frag, progress)


def main():
    UmrBootstrapService().run()


if __name__ == '__main__':
    main()
