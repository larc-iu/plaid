"""Which layer is which in a UMR project.

The substrate (a baseline text with sentence, word and, when the project has
IGT's, morpheme token layers) is found by the cross-app ``config.plaid.role``.
The four layers UMR owns are found by a flag under ``config.umr``::

    Text (role baseline)
    ├─ Sentences (role sentence)          shared substrate
    │  └─ Words (role word)               shared substrate
    │     └─ Morphemes (role morpheme)    IGT's, read when present
    └─ UMR nodes (umr.nodes)              ROOT token layer, one token per
       │                                   contiguous anchor piece
       └─ UMR concepts (umr.concepts)     span layer, one span per graph node
          ├─ UMR relations (umr.relations)           sentence-level edges
          └─ UMR document graph (umr.documentGraph)  temporal, modal, coref

This is the Python side of ``plaid-umr/src/utils/umrLayerUtils.js``
(``getUmrLayerInfo``), and it resolves the same set from the same tags, so a
service and the app disagree about nothing. Both a project and a document
response carry ``text_layers`` with the whole tree, so one resolver reads
either; only a document carries the tokens and spans.

The morpheme layer is optional and every other one is required: a project
missing any of them is not set up for UMR, and resolving raises rather than
guessing, so a mistagged project fails loudly instead of writing somewhere
unexpected.
"""

from dataclasses import dataclass, field as dc_field
from typing import Any, Dict, List, Optional

from plaid_client.roles import ROLES, find_by_role

#: The app's private config namespace.
UMR_NAMESPACE = 'umr'

#: The flags on the four layers UMR owns, under ``config.umr``.
NODES, CONCEPTS, RELATIONS, DOCUMENT_GRAPH = 'nodes', 'concepts', 'relations', 'documentGraph'

#: What a missing layer is called on screen (the app's own labels).
_LABELS = {
    'text_layer': 'Text layer',
    'sentence_layer': 'Sentence layer',
    'word_layer': 'Word layer',
    'node_layer': 'UMR node layer',
    'concept_layer': 'UMR concept layer',
    'relation_layer': 'UMR relation layer',
    'document_graph_layer': 'UMR document graph layer',
}

#: Every layer but the morphemes, which are IGT's and read when present.
REQUIRED = tuple(_LABELS)


def umr_config(entity) -> dict:
    """The ``umr`` namespace of an entity's ``config``, or ``{}``."""
    return ((entity or {}).get('config') or {}).get(UMR_NAMESPACE) or {}


def umr_metadata(entity) -> dict:
    """The ``umr`` namespace of an entity's ``metadata``, or ``{}``. The flat
    provenance keys sit BESIDE it, never inside it."""
    return ((entity or {}).get('metadata') or {}).get(UMR_NAMESPACE) or {}


def find_flagged(layers, flag: str):
    """The first layer carrying ``config.umr.<flag>``, or None."""
    for layer in layers or []:
        if umr_config(layer).get(flag) is True:
            return layer
    return None


def owns_umr(layer) -> bool:
    """Whether the layer belongs to UMR at all, which is what a ``config.umr``
    namespace says whatever it holds. Read as presence rather than as contents,
    the way the app reads it (an empty ``config.umr`` object is truthy in JS)."""
    return ((layer or {}).get('config') or {}).get(UMR_NAMESPACE) is not None


@dataclass
class GlossLayer:
    """Another app's annotation layer over the substrate, which a gloss line can
    read. IGT's fields say their scope (``config.igt.scope``) and writing system
    (``config.igt.lang``); a layer that says nothing takes the scope of the token
    layer it hangs off. UMR's own layers are never gloss lines."""
    id: str
    name: str
    scope: str                      # 'sentence', 'word' or 'morpheme'
    lang: Optional[str] = None
    layer: dict = dc_field(default_factory=dict)


@dataclass
class UmrLayers:
    """The layers of one project, as found in one project or document response."""
    text_layer: dict
    sentence_layer: dict
    word_layer: dict
    node_layer: dict
    concept_layer: dict
    relation_layer: dict
    document_graph_layer: dict
    morpheme_layer: Optional[dict] = None
    gloss_layers: List[GlossLayer] = dc_field(default_factory=list)

    @property
    def text_id(self) -> Optional[str]:
        return ((self.text_layer or {}).get('text') or {}).get('id')

    @property
    def body(self) -> str:
        return ((self.text_layer or {}).get('text') or {}).get('body') or ''

    @property
    def morpheme_layer_id(self) -> Optional[str]:
        return (self.morpheme_layer or {}).get('id')

    def read_layer_ids(self) -> List[str]:
        """The layers a document read has to name for ``?layers=``. A project
        may hold layers UMR never parses (UD's columns, where the two share a
        project), and a layer carries its content only when it is named."""
        ids = [self.text_layer['id'], self.sentence_layer['id'], self.word_layer['id'],
               self.morpheme_layer_id, self.node_layer['id'], self.concept_layer['id'],
               self.relation_layer['id'], self.document_graph_layer['id']]
        ids += [g.id for g in self.gloss_layers]
        return [i for i in dict.fromkeys(ids) if i]


def gloss_layers_of(sentence_layer, word_layer, morpheme_layer) -> List[GlossLayer]:
    out: List[GlossLayer] = []
    for token_layer, default_scope in ((sentence_layer, 'sentence'), (word_layer, 'word'),
                                       (morpheme_layer, 'morpheme')):
        for layer in (token_layer or {}).get('span_layers') or []:
            if owns_umr(layer):
                continue
            igt = ((layer.get('config') or {}).get('igt') or {})
            declared = str(igt.get('scope') or '').lower()
            out.append(GlossLayer(
                id=layer['id'], name=layer.get('name') or '',
                scope='word' if declared == 'token' else (declared or default_scope),
                lang=igt.get('lang') or None, layer=layer))
    return out


def resolve_layers(raw) -> UmrLayers:
    """The UMR layers of a project or document response.

    Raises ``ValueError`` naming every layer that is missing, so a half-made
    project says which piece a maintainer has left to finish rather than failing
    somewhere deeper with an id of None.
    """
    text_layers = (raw or {}).get('text_layers') or []
    text_layer = find_by_role(text_layers, ROLES.BASELINE) or (text_layers[0] if text_layers else None)
    token_layers = (text_layer or {}).get('token_layers') or []
    node_layer = find_flagged(token_layers, NODES)
    concept_layer = find_flagged((node_layer or {}).get('span_layers'), CONCEPTS)
    relation_layers = (concept_layer or {}).get('relation_layers')
    found: Dict[str, Any] = {
        'text_layer': text_layer,
        'sentence_layer': find_by_role(token_layers, ROLES.SENTENCE),
        'word_layer': find_by_role(token_layers, ROLES.WORD),
        'node_layer': node_layer,
        'concept_layer': concept_layer,
        'relation_layer': find_flagged(relation_layers, RELATIONS),
        'document_graph_layer': find_flagged(relation_layers, DOCUMENT_GRAPH),
    }
    missing = [_LABELS[key] for key in REQUIRED if not found[key]]
    if missing:
        raise ValueError('This project is not set up for UMR: it is missing the '
                         + ', '.join(missing) + '. A maintainer can finish setting it up on '
                         'the project page.')
    morpheme_layer = find_by_role(token_layers, ROLES.MORPHEME)
    return UmrLayers(morpheme_layer=morpheme_layer,
                     gloss_layers=gloss_layers_of(found['sentence_layer'], found['word_layer'],
                                                  morpheme_layer),
                     **found)


def gloss_values(raw, layers: UmrLayers) -> Dict[str, Dict[str, str]]:
    """``{layer id: {first token id: value}}`` over the gloss layers: a span's
    value read by the first token of the span, which is how the app reads one.

    Read from the document response rather than from ``layers``, because a
    document read may have been asked for a different set of layers than the
    project was resolved from.
    """
    out: Dict[str, Dict[str, str]] = {}
    wanted = {g.id for g in layers.gloss_layers}
    for text_layer in (raw or {}).get('text_layers') or []:
        for token_layer in text_layer.get('token_layers') or []:
            for span_layer in token_layer.get('span_layers') or []:
                if span_layer['id'] not in wanted:
                    continue
                values: Dict[str, str] = {}
                for span in span_layer.get('spans') or []:
                    first = (span.get('tokens') or [None])[0]
                    if first is not None and span.get('value') not in (None, ''):
                        values[first] = str(span['value'])
                out[span_layer['id']] = values
    return out


def project_language(project) -> str:
    """The project's language as a BCP-47 tag, from ``config.umr.language``."""
    tag = umr_config(project).get('language')
    return tag.strip() if isinstance(tag, str) else ''
