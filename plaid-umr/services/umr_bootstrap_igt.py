"""
UMR skeleton from glosses: a first graph from the project's own interlinear
annotation, with no model.

For every sentence it makes one node per word that the project already says
something about: a word linked to a vocabulary entry takes the entry's
HEADWORD as its concept (UMR's stage 0, "use the lemma as is"), and a word
with a gloss but no link takes the lexical part of its gloss. A headword of
several words is joined with hyphens, UMR's multi-word concept (`take-out`).
Grammatical gloss abbreviations (Leipzig rules, plus whatever a language adds)
become the attributes they stand for: `3SG` is `:refer-person 3rd
:refer-number singular`, `NEG` is `:polarity -`, `HAB` is `:aspect habitual`.
The word whose glosses carry tense or aspect is marked as the sentence's root,
else the first node is.

In a segmented word the concept comes from its LEXICAL morpheme: never an
affix, a clitic or a zero morph (`∅`), and of the rest the first with a morph
type (a stem or root), else the first whose gloss has a lexical part. An
affix's entry or gloss never names the word (`m-` 3.POSS + `hii` blood is
`hii`, not `m`). A link on the word itself comes first.

A compound (a word of two stems or more) with no link of its own is named by
the entry whose headword is the word as written, when the lexicon has one:
Lamkang `har buu` 'chicken coop' is `har-buu`, where its first stem alone
would make it `har` 'fowl'. Without such an entry it takes the FIRST stem, a
default and not a claim about the head, which is on the left in some
languages and on the right in others. The annotator renames it.

A person and number describe the node only when the gloss is the node's own:
a gloss that carries a person or marks possession (`POSS`) on another morpheme
than the lexical one or beside a lexical part (`m-` 3.POSS + `hii` blood,
`sbj:3`, `go.3SG`) is agreement with or the possessor of another participant,
and that participant would need a node and an edge. The person and number of
that morpheme are dropped rather than put on the wrong node, and a number on a
morpheme of its own stays (`house-PL-1SG.POSS` is plural). A free possessive
pronoun is the exception that proves it: a word glossed `3SG.POSS` and nothing
else IS the possessor, so its node keeps them.

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

The storage model -- which layer is which, how a document reads back as
sentence graphs, the variable rule, the three-pass write and what a run reports
-- is `plaid_client.workflows.umr`, shared with the drafting service and with
the assistant in plaid-agent. What is here is the gloss table and how a gloss
becomes a concept.

Requirements (on top of plaid-client): none.
"""

import argparse
import json
import re
import unicodedata
from typing import Any, Dict, List, Optional

from plaid_client import BaseService, TASKS, Param, stamp_inferred, service_source
from plaid_client.service import check_unchanged
from plaid_client.workflows.umr import (DraftProgress, build_draft_notice, gloss_values,
                                        next_variable, read_document, resolve_layers,
                                        write_graphs)

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
#: value, `('root',)` for a tense or aspect marker that says the word is the
#: sentence's event, or `('possessive',)` for a marker that says the gloss's
#: person and number are a possessor's. Leipzig Glossing Rules abbreviations,
#: upper case, and Lamkang's `POS` beside `POSS`. Only values the validator
#: accepts, so nothing written here is an error the annotator has to clean up.
#: An `:aspect` attribute elects the root as `('root',)` does.
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
    'POSS': ('possessive',),
    'POS': ('possessive',),
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
#: What a gloss is cut into morphemes on: `dog-PL`, `3SG=go`, `go out`.
_MORPHEME_CUT = re.compile(r'[\-=~<>\s]+')
#: What one morpheme's gloss is cut into parts on, the Leipzig separators for
#: one form that means several things: `bark.PRS`, `sbj:3.pfv`, `hit;PST`,
#: `sing\PST`.
_PART_CUT = re.compile(r'[.:;\\]+')
_LETTER = re.compile(r'[^\W\d_]', re.UNICODE)


def _has_capital(part: str) -> bool:
    """Whether a part has a capital (upper or title case) letter. A script
    with no letter case (水, पानी, ماء) has none, so its words are never read
    as abbreviations, as in `isLexicalPart` in plaid-igt."""
    return any(unicodedata.category(c) in ('Lu', 'Lt') for c in part)

#: Leipzig abbreviations that stand for no attribute here but are grammatical
#: all the same, so that written in lower case inside a compound gloss
#: (`sbj:3.pfv`, `obj:3`) they are not taken for the word. Single letters
#: (A, S, P, M, F, N) are left out: in lower case they are too often a word.
GRAMMATICAL = frozenset('''
    ABL ABS ACC ADJ ADV AGR ALL ANTIP APPL ART AUX BEN CAUS CLF COM COMP COND
    COP CVB DAT DECL DEF DEM DET DIST DISTR DUR ERG EXCL FOC GEN INCL IND INDF
    INF INS INTR LOC NMLZ NOM OBJ OBL PASS PRED PROH PROX PTCP PURP QUOT RECP
    REFL REL RES SBJ SBJV TOP TR VOC
'''.split())


def _keys(part: str, table, lenient: bool) -> Optional[List[str]]:
    """The abbreviations one part of a gloss stands for, [] for a grammatical
    part that stands for nothing, None for a word. The case rule: a part in
    upper case, with no letter (`3`) or a person and number in either case
    (`3SG`, `3sg`, never a word), is grammatical; a part with a lower case
    letter, or with letters of a script that has no case, is a word.
    `lenient` is the one exception, a compound gloss that also has a part
    grammatical by that rule (`sbj:3.pfv`, `go.3SG.pfv`): there a known
    abbreviation in lower case is grammatical too."""
    m = _PERSON_NUMBER.match(part.upper())
    if m:
        return [m.group(1), m.group(2)]
    if part.upper() in table and (part.upper() == part or not _LETTER.search(part)):
        return [part]
    if part.upper() == part and _has_capital(part):
        return []
    if lenient and len(part) > 1 and (part.upper() in table or part.upper() in GRAMMATICAL):
        return [part]
    return None


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
    part that is not grammatical), the attributes its abbreviations stand
    for, whether one of them marks tense or aspect, and whether one marks
    possession. Each morpheme's gloss is read on its own, so a lower-case
    abbreviation counts only beside a grammatical part of the SAME morpheme
    (`sbj:3.pfv`), never because another morpheme is grammatical.

    `marked` runs beside `attrs`: whether the morpheme an attribute came from
    also carries a person or a possessive, which is what makes its person and
    number maybe another participant's (`own_attrs`). In `house-PL-1SG.POSS`
    the plural is on a morpheme of its own and is not marked."""
    lexical = None
    attrs: List[tuple] = []
    marked: List[bool] = []
    eventive = False
    possessive = False
    for morpheme in _MORPHEME_CUT.split(str(gloss or '').strip()):
        parts = [p for p in _PART_CUT.split(morpheme) if p]
        lenient = len(parts) > 1 and any(_keys(p, table, False) is not None for p in parts)
        found: List[tuple] = []
        participant = False
        for part in parts:
            keys = _keys(part, table, lenient)
            if keys is None:
                if lexical is None and _LETTER.search(part):
                    lexical = part
                continue
            for k in keys:
                what = table.get(k.upper())
                if what == ('root',):
                    eventive = True
                elif what == ('possessive',):
                    possessive = participant = True
                elif what:
                    found.append(what)
                    if what[0] == ':refer-person':
                        participant = True
                    if what[0] == ':aspect':
                        eventive = True
        attrs.extend(found)
        marked.extend(participant for _ in found)
    return {'lexical': lexical, 'attrs': attrs, 'marked': marked, 'eventive': eventive,
            'possessive': possessive}


#: The attributes that describe a participant, which a gloss may give for
#: another one than the node (agreement, a possessor).
_PARTICIPANT = (':refer-person', ':refer-number')


def own_attrs(read: Dict[str, Any], lexical_home: bool) -> List[tuple]:
    """The attributes of one read gloss that belong on the node. `lexical_home`
    is whether the gloss is the word's own or its lexical morpheme's. A person
    or a number on a morpheme that carries a person or a possessive is another
    participant's (a possessor, an agreeing subject) when that morpheme is not
    the node's own or the gloss has a lexical part, so it is left out. Where
    the gloss is the node's own and has no lexical part (a free pronoun,
    `3SG.POSS`), the node is that participant and keeps them. A number on a
    morpheme of its own (the `PL` of `house-PL-1SG.POSS`) is the node's."""
    foreign_here = not lexical_home or bool(read['lexical'])
    return [(rel, value) for (rel, value), marked in zip(read['attrs'], read['marked'])
            if not (foreign_here and marked and rel in _PARTICIPANT)]


def is_bound(morph_type: Optional[str]) -> bool:
    """An affix or a clitic, by IGT's morph type (FLEx's names): never the
    morpheme that names a word. As `isBoundType` in plaid-igt."""
    t = (morph_type or '').lower()
    return 'clitic' in t or t.endswith('fix')


#: A zero morph as IGT writes it (`Alt+0` types U+2205), or a form emptied by
#: hand: nothing a word could be named after. The digit 0 is a real form (a
#: numeral), as `isZeroMorph` in plaid-igt has it.
_ZERO_FORMS = {'', '\u2205'}


def is_zero(form: str) -> bool:
    return (form or '').strip() in _ZERO_FORMS


def lexical_morpheme(morphemes, reads_by_morpheme, links, headwords):
    """The morpheme a segmented word takes its concept from, or None. Never
    an affix, a clitic or a zero morph. Of the rest, the first whose morph type
    is set (a stem or root), else the first whose gloss has a lexical part,
    then the first linked to an entry."""
    rest = [m for m in morphemes if not is_bound(m.morph_type) and not is_zero(m.text)]
    typed = next((m for m in rest if m.morph_type), None)
    if typed:
        return typed
    for m in rest:
        if any(r['lexical'] for r in reads_by_morpheme.get(m.id, [])):
            return m
    return next((m for m in rest
                 if any(e in headwords for e in links.get(m.id, []))), None)


def listed_forms(headwords: Dict[str, str]) -> Dict[str, str]:
    """Every headword by the concept it makes, so that a word written `har
    buu` or `har-buu` finds the entry `har buu`."""
    out: Dict[str, str] = {}
    for form in headwords.values():
        key = concept_from(form)
        if key:
            out.setdefault(key, form)
    return out


def compound_headword(word, morphemes, listed: Dict[str, str]) -> Optional[str]:
    """The headword that names a compound as a whole: the entry whose form is
    the word as written, when the word has two stems or more. None for a word
    of one stem, whose stem already names it, and for a compound the lexicon
    does not list. `listed` is `listed_forms` of the headwords."""
    stems = [m for m in morphemes if not is_bound(m.morph_type) and not is_zero(m.text)]
    if len(stems) < 2:
        return None
    return listed.get(concept_from(word.text))


def concept_from(text: str) -> str:
    """A concept from a headword or a lexical gloss: lower case, spaces as
    hyphens, nothing a PENMAN reader would choke on."""
    out = re.sub(r'\s+', '-', str(text or '').strip().lower())
    out = re.sub(r'[()":#\s/]', '', out)
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


def links_by_token(layers) -> Dict[str, List[str]]:
    """Entry ids by the word or morpheme token linked to them."""
    out: Dict[str, List[str]] = {}
    for layer in (layers.word_layer, layers.morpheme_layer):
        for vocab in (layer or {}).get('vocabs') or []:
            for link in vocab.get('vocab_links') or []:
                item = (link.get('vocab_item') or {}).get('id')
                if not item:
                    continue
                for token in link.get('tokens') or []:
                    out.setdefault(token, []).append(item)
    return out


def plan_sentence(sentence, gloss_layers, values, links, headwords, table, taken, listed=None):
    """One sentence's skeleton as writes: ``(pieces, nodes, edges)``, the shape
    `write_graphs` takes. Edges are always []. `listed` is `listed_forms` of
    the headwords, made once per run by a caller planning many sentences."""
    if listed is None:
        listed = listed_forms(headwords)
    pieces = []
    nodes = []
    root_at = None
    for word in sentence.words:
        if not _LETTER.search(word.text) and not re.search(r'\d', word.text):
            continue
        morphemes = sentence.morphemes_of(word)
        word_reads = []
        by_morpheme: Dict[str, List[Dict[str, Any]]] = {}
        for layer in gloss_layers:
            of = values.get(layer.id) or {}
            if layer.scope == 'word':
                value = of.get(word.id)
                if value:
                    word_reads.append(read_gloss(value, table))
            elif layer.scope == 'morpheme':
                for m in morphemes:
                    value = of.get(m.id)
                    if value:
                        by_morpheme.setdefault(m.id, []).append(read_gloss(value, table))
        home = lexical_morpheme(morphemes, by_morpheme, links, headwords) if morphemes else None
        home_reads = by_morpheme.get(home.id, []) if home else []
        # The word's own link, then a compound's headword, then the lexical
        # morpheme's link, then the lexical part of a gloss.
        entry = next((e for e in links.get(word.id, []) if e in headwords), None)
        named = headwords[entry] if entry else compound_headword(word, morphemes, listed)
        if not named and home:
            entry = next((e for e in links.get(home.id, []) if e in headwords), None)
            named = headwords[entry] if entry else None
        lexical = next((r['lexical'] for r in home_reads + word_reads if r['lexical']), None)
        concept = concept_from(named) if named else concept_from(lexical or '')
        if not concept:
            continue
        # Word glosses, then each morpheme's in order: the lexical morpheme's
        # and the word's are the node's own.
        placed = [(r, True) for r in word_reads]
        for m in morphemes:
            placed.extend((r, m is home) for r in by_morpheme.get(m.id, []))
        attrs = []
        seen = set()
        for r, own in placed:
            for rel, value in own_attrs(r, own):
                if rel not in seen:
                    seen.add(rel)
                    attrs.append({'rel': rel, 'value': value, 'order': len(attrs)})
        read = [r for r, _ in placed]
        var = next_variable(sentence.index, concept, taken)
        taken.add(var)
        if root_at is None and any(r['eventive'] for r in read):
            root_at = len(nodes)
        pieces.append((word.begin, word.end))
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
                              description='Write over sentences whose graph is machine-made, '
                                          'discarding those graphs. A sentence a person built '
                                          'or confirmed is kept either way, and so is every '
                                          'sentence with a graph when this is off. What is '
                                          'kept is counted in the report.'),
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
        raw = self.client.documents.get(document_id, include_body=True)
        read_version = raw.get('version')
        layers = resolve_layers(raw)
        document = read_document(raw, layers, gloss=gloss_values(raw, layers))
        sentences = document.sentences

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
        links = links_by_token(layers)
        listed = listed_forms(headwords)

        in_scope = sentences
        if scope == 'sentence':
            in_scope = [s for s in sentences if s.index == wanted]
            if not in_scope:
                raise ValueError(f'The document has no sentence {wanted}.')
        # With `overwrite` on, a sentence is KEPT and counted when a person
        # built or confirmed any node, edge or document-level triple of it, or
        # when another sentence's block writes an edge or triple on its nodes
        # (the machine-writer contract, `Sentence.redraftable`): the tick
        # redrafts machine graphs only, as igt's analyzers do.
        with_graph = [s for s in in_scope if s.words and s.nodes]
        kept = len([s for s in with_graph if s.person_made]) if overwrite else 0
        linked = (len([s for s in with_graph if not s.redraftable and not s.person_made])
                  if overwrite else 0)
        skipped = len(with_graph) if not overwrite else 0
        targets = [s for s in in_scope
                   if s.words and (not s.nodes or (overwrite and s.redraftable))]
        progress.report(DraftProgress.READ, 1.0, 'Reading the document…')

        taken = document.taken_variables
        if overwrite:
            for s in targets:
                for node in s.nodes:
                    taken.discard(node.var)
        plans = []
        failures = []
        for sentence in targets:
            pieces, nodes, edges = plan_sentence(sentence, layers.gloss_layers, document.gloss,
                                                 links, headwords, self.abbreviations, taken,
                                                 listed)
            if not nodes:
                failures.append({'sentence': sentence.index,
                                 'reason': 'no word has a vocabulary link or a gloss'})
                continue
            plans.append({'sentence': sentence, 'pieces': pieces, 'nodes': nodes,
                          'edges': edges})

        drafted = len(plans)
        first_error = failures[0]['reason'] if failures else None
        if not plans:
            notice = build_draft_notice(0, skipped, len(failures), first_error, kept=kept, linked=linked)
            response_helper.progress(100, notice['title'])
            response_helper.complete({'document_id': document_id, 'status': 'success',
                                      'sentences': len(sentences), 'drafted': 0,
                                      'skipped': skipped, 'kept': kept, 'linked': linked, 'failed': len(failures),
                                      'sentences_failed': failures, 'notice': notice})
            return

        frag = stamp_inferred(service_source(self.service_id), detail={'method': 'glosses'})
        progress.report(DraftProgress.WRITE, 0.0, f'Writing {drafted} skeletons…')
        with response_helper.critical():
            with self.client.operation(f'UMR skeleton from glosses ({drafted} sentences)'):
                with self.client.documents.locked(document_id):
                    check_unchanged(self.client, document_id, read_version)
                    write_graphs(self.client, layers, plans, frag, progress)
            notice = build_draft_notice(drafted, skipped, len(failures), first_error, kept=kept, linked=linked)
            response_helper.progress(100, notice['title'])
            response_helper.complete({'document_id': document_id, 'status': 'success',
                                      'sentences': len(sentences), 'drafted': drafted,
                                      'skipped': skipped, 'kept': kept, 'linked': linked, 'failed': len(failures),
                                      'sentences_failed': failures, 'notice': notice})

def main():
    UmrBootstrapService().run()


if __name__ == '__main__':
    main()
