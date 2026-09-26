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

A gloss is a line the project's gloss-line mapping (`config.umr.ilg`, or the
one proposed from the layers' names, as the canvas reads it) files as a word
or morpheme gloss. A gloss in the project's language is read first whatever
its scope, then the lexical morpheme's gloss before the word's. A part of
speech, a category or a note never names a node.

In a segmented word the concept comes from its LEXICAL morpheme: never an
affix, a clitic or a zero morph (`∅`), and of the rest the first with a morph
type (a stem or root), else the first whose gloss has a lexical part. An
affix's entry or gloss never names the word (`m-` 3.POSS + `hii` blood is
`hii`, not `m`). A link on the word itself comes first.

A compound (a word of two stems or more, a stem being a morpheme typed as one
or, untyped, glossed as a word) with no link of its own is named by the entry
whose headword is the word as written, spaces and hyphens aside (`harbuu`,
`har buu` and `har-buu` are one spelling), when the lexicon has one:
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
morpheme of its own stays (`house-PL-1SG.POSS` is plural) unless the word also
carries a person that is not a possessor's, whose number it is (`1-see-PL`,
Georgian v-xedav-t, is not a plural event). A free possessive
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
elects the root and `null` removes a default. A relation UMR does not have, a
role that is not an attribute, or a value the validator refuses is refused
when the table is read, before anything is written.

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
from typing import Any, Dict, List, Optional

from plaid_client import BaseService, TASKS, stamp_inferred, service_source
from plaid_client.workflows.umr import (DraftProgress, begin_draft, draft_params, finish_draft,
                                        next_variable, unknown_relation_problem)
from plaid_client.workflows.igt.glossing import (GLOSS_ABBREVIATIONS, PERSON_NUMBER,
                                                 gloss_morphemes, is_bound_type, is_zero_morph,
                                                 lexical_flags)
from plaid_client.workflows.umr.inventory import attribute_value_problem
from plaid_client.workflows.umr.layers import lexical_gloss_layers

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

#: What a morpheme's gloss is cut into morphemes and parts on, and the case
#: rule that says which part is a word, are plaid-igt's
#: (`plaid_client.workflows.igt.glossing`), so a part IGT sets in small caps is
#: one read here as an abbreviation.
_LETTER = re.compile(r'[^\W\d_]', re.UNICODE)


def _known(table) -> frozenset:
    """The abbreviations the lenient reading knows: the Leipzig list, less a
    default the language table removed, plus what it added."""
    return (GLOSS_ABBREVIATIONS - set(ABBREVIATIONS)) | set(table)


def _keys(part: str) -> List[str]:
    """The table keys a grammatical part stands for: a person and number
    written as one (`3SG`, `3sg`) is two."""
    m = PERSON_NUMBER.match(part)
    return [m.group(1), m.group(2)] if m else [part]


#: The one-word entries a language table may map an abbreviation to.
_MARKERS = (('root',), ('possessive',))


def _table_entry(key: str, value) -> tuple:
    """One entry of a language table, refused unless the skeleton can write
    it: a marker, or a UMR attribute and a value the validator takes. What a
    table maps to is written as an attribute, so a relation UMR does not have
    (`:definite`, `:polarityy`), a role that points at a node (`:manner`,
    `:ARG0`), and a value outside the attribute's set (`:refer-number
    plurall`) or empty are refused here, as the app and the assistant refuse
    them."""
    if not (isinstance(value, list) and value and all(isinstance(v, str) for v in value)):
        raise ValueError(f'Abbreviation {key!r} must map to a list of strings or null.')
    entry = tuple(value)
    if entry in _MARKERS:
        return entry
    if len(entry) != 2:
        raise ValueError(f'Abbreviation {key!r} must map to a relation and a value, '
                         '["root"] or ["possessive"].')
    rel = entry[0]
    if not rel.startswith(':'):
        raise ValueError(f'Abbreviation {key!r}: the relation {rel!r} must start with a colon.')
    problem = unknown_relation_problem(rel) or attribute_value_problem(rel, entry[1])
    if problem:
        raise ValueError(f'Abbreviation {key!r}: {problem}')
    return entry


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
        else:
            table[key.upper()] = _table_entry(key, value)
    return table


def read_glosses(glosses: List[str], table) -> List[Dict[str, Any]]:
    """The glosses of one word (its own and its morphemes'), each read into
    what it says: the lexical part (the first part that is not grammatical),
    the attributes its abbreviations stand for, whether one of them marks
    tense or aspect, and whether one marks possession. Which part is a word is
    plaid-igt's rule (`lexical_flags`), read over the word as one unit: a
    lower-case abbreviation counts beside a grammatical part of the SAME
    morpheme (`sbj:3.pfv`), never because another morpheme is grammatical,
    and when that leaves the word with no lexical part the case rule stands
    (`pass.PST` is `pass`).

    `marked` runs beside `attrs`: whether the morpheme an attribute came from
    also carries a person or a possessive, which is what makes its person and
    number maybe another participant's (`own_attrs`). In `house-PL-1SG.POSS`
    the plural is on a morpheme of its own and is not marked. `agreement` is
    whether some morpheme carries a person with no possessive (`1-see-PL`),
    which makes a number on another morpheme that person's too."""
    cut = [gloss_morphemes(str(g or '').strip()) for g in glosses]
    flags = lexical_flags([m for morphemes in cut for m in morphemes], _known(table))
    flags_at = iter(flags)
    out = []
    for morphemes in cut:
        lexical = None
        attrs: List[tuple] = []
        marked: List[bool] = []
        eventive = possessive = agreement = False
        for parts in morphemes:
            found: List[tuple] = []
            person = owner = False
            for part, is_lexical in zip(parts, next(flags_at)):
                if is_lexical:
                    if lexical is None:
                        lexical = part
                    continue
                for k in _keys(part):
                    what = table.get(k.upper())
                    if what == ('root',):
                        eventive = True
                    elif what == ('possessive',):
                        possessive = owner = True
                    elif what:
                        found.append(what)
                        if what[0] == ':refer-person':
                            person = True
                        if what[0] == ':aspect':
                            eventive = True
            attrs.extend(found)
            marked.extend((person or owner) for _ in found)
            agreement = agreement or (person and not owner)
        out.append({'lexical': lexical, 'attrs': attrs, 'marked': marked,
                    'eventive': eventive, 'possessive': possessive, 'agreement': agreement})
    return out


def read_gloss(gloss: str, table) -> Dict[str, Any]:
    """One gloss read as a word's only one (`read_glosses`)."""
    return read_glosses([gloss], table)[0]


#: The attributes that describe a participant, which a gloss may give for
#: another one than the node (agreement, a possessor).
_PARTICIPANT = (':refer-person', ':refer-number')


def own_attrs(read: Dict[str, Any], lexical_home: bool,
              agreement: Optional[bool] = None) -> List[tuple]:
    """The attributes of one read gloss that belong on the node. `lexical_home`
    is whether the gloss is the word's own or its lexical morpheme's. A person
    or a number on a morpheme that carries a person or a possessive is another
    participant's (a possessor, an agreeing subject) when that morpheme is not
    the node's own or the gloss has a lexical part, so it is left out. Where
    the gloss is the node's own and has no lexical part (a free pronoun,
    `3SG.POSS`), the node is that participant and keeps them. A number on a
    morpheme of its own is the node's (the `PL` of `house-PL-1SG.POSS`),
    unless the word also carries an agreement person (`1-see-PL`), whose
    number it then is. `agreement` is whether the word does, over all its
    glosses, and defaults to this gloss's own."""
    if agreement is None:
        agreement = read['agreement']
    foreign_here = not lexical_home or bool(read['lexical'])
    return [(rel, value) for (rel, value), marked in zip(read['attrs'], read['marked'])
            if not (foreign_here and rel in _PARTICIPANT
                    and (marked or (agreement and rel == ':refer-number')))]


def is_bound(morph_type: Optional[str]) -> bool:
    """An affix or a clitic, by IGT's morph type (`is_bound_type`): never the
    morpheme that names a word."""
    return is_bound_type(morph_type)


def is_zero(form: str) -> bool:
    """A zero morph (`is_zero_morph`, U+2205 and not the digit 0), or a form
    emptied by hand: nothing a word could be named after."""
    return is_zero_morph(form) or not (form or '').strip()


def _candidates(morphemes):
    """The morphemes that could name a word: never an affix, a clitic or a
    zero morph."""
    return [m for m in morphemes if not is_bound(m.morph_type) and not is_zero(m.text)]


def _glossed_as_word(m, reads_by_morpheme) -> bool:
    return any(r['lexical'] for r in reads_by_morpheme.get(m.id, []))


def lexical_morpheme(morphemes, reads_by_morpheme, links, headwords):
    """The morpheme a segmented word takes its concept from, or None. Never
    an affix, a clitic or a zero morph. Of the rest, the first whose morph type
    is set (a stem or root), else the first whose gloss has a lexical part,
    then the first linked to an entry."""
    rest = _candidates(morphemes)
    typed = next((m for m in rest if m.morph_type), None)
    if typed:
        return typed
    for m in rest:
        if _glossed_as_word(m, reads_by_morpheme):
            return m
    return next((m for m in rest
                 if any(e in headwords for e in links.get(m.id, []))), None)


def stems_of(morphemes, reads_by_morpheme):
    """The stems of a segmented word, by `lexical_morpheme`'s rule: a morpheme
    typed as a stem or root, or with no type and a lexical gloss. An untyped
    morpheme glossed `3.POS` is not one."""
    return [m for m in _candidates(morphemes)
            if m.morph_type or _glossed_as_word(m, reads_by_morpheme)]


def _joined(text: str) -> str:
    """A spelling with the joins between its parts taken out, so that
    `harbuu`, `har buu` and `har-buu` are one key."""
    return re.sub(r'[-=~_]', '', concept_from(text))


def listed_forms(headwords: Dict[str, str]) -> Dict[str, str]:
    """Every headword by its spelling with the joins taken out, so that a word
    written `harbuu`, `har buu` or `har-buu` finds the entry `har buu`."""
    out: Dict[str, str] = {}
    for form in headwords.values():
        key = _joined(form)
        if key:
            out.setdefault(key, form)
    return out


def compound_headword(word, morphemes, listed: Dict[str, str],
                      reads_by_morpheme) -> Optional[str]:
    """The headword that names a compound as a whole: the entry spelled as the
    word is, joins aside, when the word has two stems or more (`stems_of`).
    None for a word of one stem, whose stem already names it, and for a
    compound the lexicon does not list. `listed` is `listed_forms` of the
    headwords."""
    if len(stems_of(morphemes, reads_by_morpheme)) < 2:
        return None
    return listed.get(_joined(word.text))


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
        # Every gloss of the word with the morpheme it glosses (None for the
        # word), in the order of `gloss_layers`, which is the order a concept
        # is looked for. They are read together, as one word.
        glossed: List[tuple] = []
        for layer in gloss_layers:
            of = values.get(layer.id) or {}
            if layer.scope == 'word':
                if of.get(word.id):
                    glossed.append((None, of[word.id]))
            elif layer.scope == 'morpheme':
                glossed.extend((m.id, of[m.id]) for m in morphemes if of.get(m.id))
        in_order = list(zip([mid for mid, _ in glossed],
                            read_glosses([value for _, value in glossed], table)))
        word_reads = [r for mid, r in in_order if mid is None]
        by_morpheme: Dict[str, List[Dict[str, Any]]] = {}
        for mid, r in in_order:
            if mid is not None:
                by_morpheme.setdefault(mid, []).append(r)
        home = lexical_morpheme(morphemes, by_morpheme, links, headwords) if morphemes else None
        # The word's own link, then a compound's headword, then the lexical
        # morpheme's link, then the lexical part of a gloss.
        entry = next((e for e in links.get(word.id, []) if e in headwords), None)
        named = headwords[entry] if entry else compound_headword(word, morphemes, listed,
                                                                  by_morpheme)
        if not named and home:
            entry = next((e for e in links.get(home.id, []) if e in headwords), None)
            named = headwords[entry] if entry else None
        lexical = next((r['lexical'] for mid, r in in_order
                        if r['lexical'] and (mid is None or (home and mid == home.id))), None)
        concept = concept_from(named) if named else concept_from(lexical or '')
        if not concept:
            continue
        # Word glosses, then each morpheme's in order: the lexical morpheme's
        # and the word's are the node's own.
        placed = [(r, True) for r in word_reads]
        for m in morphemes:
            placed.extend((r, m is home) for r in by_morpheme.get(m.id, []))
        agreement = any(r['agreement'] for r, _ in placed)
        attrs = []
        seen = set()
        for r, own in placed:
            for rel, value in own_attrs(r, own, agreement):
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
            parameters=draft_params(),
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
        run = begin_draft(self.client, request_data, response_helper)
        if run is None:
            return

        # The project's vocabularies, for the headword a linked word takes,
        # and its gloss-line mapping, for which layers are glosses.
        headwords: Dict[str, str] = {}
        project = None
        if run.project_id:
            run.progress.report(DraftProgress.READ, 0.5, 'Reading the vocabularies…')
            try:
                project = self.client.projects.get(run.project_id)
                vocabularies = [self.client.vocab_layers.get(v['id'], include_items=True)
                                for v in (project.get('vocabs') or []) if v.get('id')]
                headwords = headwords_of(vocabularies)
            except Exception as exc:
                print(f'Could not read the vocabularies: {exc}')
        links = links_by_token(run.layers)
        listed = listed_forms(headwords)
        glosses = lexical_gloss_layers(project, run.layers)
        run.progress.report(DraftProgress.READ, 1.0, 'Reading the document…')

        plans = []
        failures = []
        for sentence in run.targets:
            pieces, nodes, edges = plan_sentence(sentence, glosses, run.document.gloss,
                                                 links, headwords, self.abbreviations, run.taken,
                                                 listed)
            if not nodes:
                failures.append({'sentence': sentence.index,
                                 'reason': 'no word has a vocabulary link or a gloss'})
                continue
            plans.append({'sentence': sentence, 'pieces': pieces, 'nodes': nodes,
                          'edges': edges})

        frag = stamp_inferred(service_source(self.service_id), detail={'method': 'glosses'})
        finish_draft(self.client, response_helper, run, plans, failures, frag,
                     operation=f'UMR skeleton from glosses ({len(plans)} sentences)',
                     writing=f'Writing {len(plans)} skeletons…')


def main():
    UmrBootstrapService().run()


if __name__ == '__main__':
    main()
