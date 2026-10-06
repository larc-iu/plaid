import contextlib
import json
import stanza
from plaid_client import (BaseService, TASKS, Param, ROLES, find_by_role,
                          stamp_inferred, is_protected, service_source)
from plaid_client.service import (batch_body_budget, locked_for_writes, machine_detail,
                                  partly_written, progress_heartbeat, requester_message,
                                  service_version)
from plaid_client.workflows.messages import setup_incomplete
from plaid_client.workflows.requester import Requester, requester_of


#: This file's version, stamped as provDetail.version (the service's own
#: ``self.version``, read here because the parse runs outside the service).
VERSION = service_version(__file__)


def prov_fragment(language, requester=Requester()):
    """Provenance fragment merged into every syntactic word, span and
    relation this service creates (never sentence or word tokens, which are
    substrate): marks it machine-made + unverified until a
    human edits or confirms it, and records the producing model, this file's
    version and the language in provDetail. (Stanza's pipeline output carries
    no per-prediction probabilities, so there is no provProb; a producer that has real
    probabilities would add `prob=` here and put its top-k distribution in
    the detail map.) See the manual, "Provenance". The detail also names who
    asked for the run (``requester``, see plaid_client.workflows.requester)."""
    return stamp_inferred(
        service_source('stanza-parser'),
        detail=requester.detail(machine_detail(VERSION, model=f'stanza=={stanza.__version__}',
                                               language=language)),
    )


# Stanza ships UD models for many languages; offer a common subset. (value, label)
STANZA_LANGUAGES = [
    ('en', 'English'), ('de', 'German'), ('fr', 'French'), ('es', 'Spanish'),
    ('it', 'Italian'), ('pt', 'Portuguese'), ('nl', 'Dutch'), ('ru', 'Russian'),
    ('zh', 'Chinese'), ('ja', 'Japanese'), ('ar', 'Arabic'), ('ko', 'Korean'),
]

PARSER_SUMMARY = """\
Runs the [Stanza](https://stanfordnlp.github.io/stanza/) neural pipeline —
tokenization, POS tagging, lemmatization, and dependency parsing — and writes
the result into the project's sentence / word / morpheme layers plus the UD
annotation spans (Form, Lemma, UPOS, XPOS, Features) and dependency relations.

Two modes, picked automatically:

- **Untokenized document**: tokenize from scratch and build the whole
  hierarchy. Re-running replaces the document's existing tokens and
  annotations — across ALL apps sharing the project.
- **Already-tokenized document** (e.g. a project shared with IGT): the
  existing sentences and words are KEPT, and Stanza re-parses PER SENTENCE — a
  sentence is refreshed only if it has no human-made or human-verified UD
  annotations, so sentences you've reviewed or edited are left exactly as they
  are. Clicking Parse again thus refreshes the machine-only and not-yet-parsed
  sentences without disturbing your work. Other apps' annotations are
  untouched. A sentence that has no words yet is tokenized on its own and
  parsed. (Trade-off: multiword tokens aren't split in this mode.)

Options:

- **Language** selects which Stanza models to use. The first parse in a given
  language downloads its models (one-time) and is slower.
- **Overwrite human-edited annotations**: by default, sentences carrying
  human-made or human-verified annotations are left untouched. Enable this to
  re-parse them too, discarding that work. (In a from-scratch re-tokenize it
  also lets the parse clear annotations that may belong to other apps sharing
  the project.)

The syntactic words and the annotations this service creates carry
provenance metadata (`prov`/`provSource`), so editors render them distinctly
until a human verifies them by editing or confirming. Sentence and word
tokens are not marked.

While parsing, the document is locked so a concurrent editor can't race the
rewrite; if someone else holds the lock, the parse is refused rather than
clobbering their work.
"""

class PipelineProvider:
    """Lazily build and cache one Stanza pipeline per language.

    The pipelines are not thread-safe, so callers must build + drive them under
    a single-flight lock (BaseService.handle_service_request provides one). Each
    distinct language used adds one cached pipeline (and a one-time model
    download)."""

    def __init__(self, processors='tokenize,pos,lemma,depparse'):
        self.processors = processors
        self._cache = {}

    def get(self, language, pretokenized=False):
        # Pretokenized pipelines honor caller-supplied sentence/word splits
        # (used by the substrate-preserving parse mode). Cached separately:
        # tokenize_pretokenized is a pipeline-construction option.
        key = (language, pretokenized)
        pipe = self._cache.get(key)
        if pipe is None:
            print(f"Loading Stanza pipeline for '{language}' (pretokenized={pretokenized})…", flush=True)
            pipe = stanza.Pipeline(language, processors=self.processors,
                                   tokenize_pretokenized=pretokenized)
            self._cache[key] = pipe
        return pipe


def span_layer_by_ud_config(layers, key, fallback_name=None):
    for layer in layers:
        if layer.get("config", {}).get("ud", {}).get(key) is True:
            return layer
    if fallback_name:
        return next((layer for layer in layers if layer.get("name") == fallback_name), None)
    return None


def relation_layer_by_ud_config(span_layer, key):
    """The relation layer carrying this `ud` flag, or None. By flag ONLY: Lemma
    holds two relation layers (the tree's, and the enhanced graph's), so a
    guess by position could hand the parser the enhanced layer and have it
    write a whole tree into it."""
    if not span_layer:
        return None
    for relation_layer in span_layer.get("relation_layers") or []:
        if relation_layer.get("config", {}).get("ud", {}).get(key) is True:
            return relation_layer
    return None


def is_suppressor(relation):
    """An enhanced-layer row saying the enhanced graph leaves out the basic
    relation it lies over (plaid-ud src/domain/enhancedGraph.js). It carries no
    provenance, which reads as a person's work, but it is a note about a
    relation and not an annotation of these words: it protects nothing. A
    parse strands none: it deletes a sentence's syntactic words, and the
    server deletes every relation on their lemma spans with them, suppressors
    included."""
    return (relation.get("metadata") or {}).get("suppress") is True


def make_bulk_token(token_layer_id, text, begin, end, metadata=None):
    op = {
        "token_layer_id": token_layer_id,
        "text": text,
        "begin": begin,
        "end": end,
    }
    if metadata:
        op["metadata"] = metadata
    return op


def make_span_token(span_layer_id, tokens, value, prov, metadata=None):
    # Every span this service creates is machine-made: the provenance
    # fragment is stamped unconditionally, with any caller metadata merged
    # over it.
    base = {
        "span_layer_id": span_layer_id,
        "tokens": tokens,
        "value": value,
        "metadata": {**prov, **(metadata or {})},
    }
    return base


def count_protected_annotations(token_layers):
    """Count human-made or human-verified annotations under the given token
    layers (write-contract guard). Returns (total, breakdown) where breakdown
    maps a human-readable label to a count, so the refusal can NAME what is
    in the way — on shared projects the annotations often belong to another
    app and are invisible in the UD editor.

    Tokens themselves are deliberately NOT counted: hand-tokenize-then-parse
    is the normal flow, and the contract protects annotation content, not
    substrate segmentation.
    """
    breakdown = {}

    def bump(label):
        breakdown[label] = breakdown.get(label, 0) + 1

    for token_layer in token_layers or []:
        tl_name = token_layer.get("name", "?")
        for span_layer in token_layer.get("span_layers", []) or []:
            label = f"{tl_name}/{span_layer.get('name', '?')}"
            for span in span_layer.get("spans", []) or []:
                if is_protected(span.get("metadata")):
                    bump(label)
            for relation_layer in span_layer.get("relation_layers", []) or []:
                rlabel = f"{label}/{relation_layer.get('name', '?')}"
                for relation in relation_layer.get("relations", []) or []:
                    if is_suppressor(relation):
                        continue
                    if is_protected(relation.get("metadata")):
                        bump(rlabel)
        for vocab in token_layer.get("vocabs", []) or []:
            for link in vocab.get("vocab_links", []) or []:
                if is_protected(link.get("metadata")):
                    bump(f"{tl_name} vocab links")
    return sum(breakdown.values()), breakdown


def format_protected_error(total, breakdown, scope):
    top = sorted(breakdown.items(), key=lambda kv: -kv[1])
    listed = ", ".join(f"{label}: {n}" for label, n in top[:6])
    if len(top) > 6:
        listed += ", …"
    return (
        f"{total} human-made or human-verified annotation(s) exist {scope} "
        f"({listed}). Re-run with 'Overwrite human-edited annotations' enabled "
        f"to replace them — only if losing them is really what you want. "
        f"(Annotations from parses made before provenance stamping existed "
        f"also count as human-made.)"
    )


def build_parse_notice(parsed, skipped):
    """Author the toast the editor shows when a parse finishes. The service owns
    ALL of this wording; the editor only maps `level` ('success' | 'warning') to
    a colour. Headline (`title`) states the outcome; the body (`message`) stays
    terse. Three cases:

    - parsed > 0: work happened (a from-scratch parse, or a selective re-parse
      of the machine-only sentences); note any human-annotated sentences kept.
    - parsed == 0, skipped > 0: nothing changed because every sentence with
      tokens already carries human-made/verified annotations (unstamped ones
      included). Point at the Overwrite lever.
    - parsed == 0, skipped == 0: nothing to work on at all.
    """
    def s(n):
        return "" if n == 1 else "s"

    if parsed > 0:
        return {
            "level": "success",
            "title": f"Parsed {parsed} sentence{s(parsed)}",
            "message": (f"Kept {skipped} sentence{s(skipped)} with existing annotations."
                        if skipped else ""),
        }
    if skipped > 0:
        subject = ("1 sentence already carries" if skipped == 1
                   else f"All {skipped} sentences already carry")
        return {
            "level": "warning",
            "title": "Document not modified",
            "message": (f"{subject} human-made or verified annotations. Enable 'Overwrite "
                        f"human-edited annotations' to re-parse."),
        }
    return {
        "level": "warning",
        "title": "Nothing to parse",
        "message": "The parser found no sentences to parse in this document.",
    }


def _token_id(tok):
    """span/link `tokens` and relation endpoints come back as id strings;
    tolerate the occasional {id: ...} object shape too."""
    return tok.get("id") if isinstance(tok, dict) else tok


def morpheme_sentence_index(sent_groups, morphemes):
    """Map each syntactic-word (morpheme) token id to the index of its sentence
    in `sent_groups`, by character containment (the sentence layer partitions
    the text, so each morpheme falls in exactly one sentence)."""
    m2s = {}
    for m in morphemes or []:
        for idx, (sent, _ws) in enumerate(sent_groups):
            if sent["begin"] <= m["begin"] and m["end"] <= sent["end"]:
                m2s[m["id"]] = idx
                break
    return m2s


def _sentence_of_tokens(tokens, morph_to_sent):
    for tok in tokens or []:
        sidx = morph_to_sent.get(_token_id(tok))
        if sidx is not None:
            return sidx
    return None


def protected_sentence_indexes(morpheme_layer, lemma_layer, morph_to_sent):
    """Indexes (into sent_groups) of sentences carrying ANY human-made or
    human-verified UD annotation — a span on the syntactic-word layer, a
    dependency relation, or a vocab link. A selective re-parse leaves these
    sentences untouched. Scope matches the substrate-preserving blast radius
    (UD's own syntactic-word subtree); other apps' sibling layers are never
    touched here, so they don't gate anything."""
    protected = set()
    lemma_layer_id = lemma_layer.get("id") if lemma_layer else None
    lemma_span_to_sent = {}  # lemma span id -> sentence idx (relation endpoints)

    for span_layer in morpheme_layer.get("span_layers", []) or []:
        is_lemma = span_layer.get("id") == lemma_layer_id
        for span in span_layer.get("spans", []) or []:
            sidx = _sentence_of_tokens(span.get("tokens"), morph_to_sent)
            if is_lemma and sidx is not None:
                lemma_span_to_sent[span.get("id")] = sidx
            if sidx is not None and is_protected(span.get("metadata")):
                protected.add(sidx)

    for span_layer in morpheme_layer.get("span_layers", []) or []:
        for relation_layer in span_layer.get("relation_layers", []) or []:
            for rel in relation_layer.get("relations", []) or []:
                if is_suppressor(rel) or not is_protected(rel.get("metadata")):
                    continue
                for endpoint in (rel.get("source"), rel.get("target")):
                    sidx = lemma_span_to_sent.get(endpoint)
                    if sidx is not None:
                        protected.add(sidx)

    for vocab in morpheme_layer.get("vocabs", []) or []:
        for link in vocab.get("vocab_links", []) or []:
            if not is_protected(link.get("metadata")):
                continue
            sidx = _sentence_of_tokens(link.get("tokens"), morph_to_sent)
            if sidx is not None:
                protected.add(sidx)

    return protected


class ParseProgress:
    """Progress reporting and cancellation for one parse.

    `parse_document` is also callable from a script, where there is no request
    to report to, so the whole facility folds into a no-op rather than making
    every call site check for a helper. Percentages are a fixed budget over the
    phases below, so the bar moves for the same reason on every document:

        2      acquiring the document lock (the caller reports this one)
        2-10   fetching the document and resolving its layers
        10-20  loading the language's models (a one-time download, first time)
        20-60  parsing
        60-100 writing

    `report` is a CANCELLATION CHECKPOINT (ResponseHelper.progress raises), so
    every call inside the write phase must sit inside `critical()`.
    """

    FETCH, LOAD, PARSE, WRITE = (2, 10), (10, 20), (20, 60), (60, 100)

    def __init__(self, helper=None):
        self._helper = helper

    def report(self, phase, fraction, message):
        """Report `message` at `fraction` (0..1) through `phase`."""
        if not self._helper:
            return
        low, high = phase
        percent = int(low + (high - low) * min(max(fraction, 0.0), 1.0))
        self._helper.progress(percent, message)

    def critical(self):
        """The writes: a stretch that must finish once begun."""
        return self._helper.critical() if self._helper else contextlib.nullcontext()

    def heartbeat(self, phase, fraction, message):
        """Keep saying `message` through one blocking call that reports
        nothing of its own. A model download and a whole-document parse are
        both single calls that can outlast the requester's patience with
        silence, and neither can be broken into steps."""
        if not self._helper:
            return contextlib.nullcontext()
        low, high = phase
        percent = int(low + (high - low) * min(max(fraction, 0.0), 1.0))
        return progress_heartbeat(self._helper, percent, message)


# How many sentences to hand Stanza at once when re-parsing an already
# tokenized document. Small enough that a long document reports often and can
# be stopped between groups, large enough that the per-call overhead stays lost
# in the parse itself.
SENTENCE_GROUP = 25


# What one ref beside a body costs on the wire, `{"at": [...], "op": n,
# "index": k}` with its separators, rounded up.
REF_BYTES = 64


class UdLayers:
    """The layers a parse writes its annotations into (any may be absent)."""

    def __init__(self, form, lemma, upos, xpos, features, dependency):
        self.form, self.lemma = form, lemma
        # Queued in this order, each layer as one bulk create.
        self.span_layers = [layer for layer in (form, lemma, upos, xpos, features) if layer]
        self.upos, self.xpos, self.features = upos, xpos, features
        self.dependency = dependency if lemma else None


class _Slot:
    """An id a write names before it exists: the k-th syntactic word
    ('morpheme') or lemma span ('lemma') of the same sentence. It becomes a
    batch ref when the sentence is queued."""

    __slots__ = ("kind", "k")

    def __init__(self, kind, k):
        self.kind, self.k = kind, k


def _json_bytes(value):
    """The length of ``value`` as the client sends it (a slot goes out as the
    null its ref fills)."""
    return len(json.dumps(value, default=lambda _slot: None))


class SentenceWrites:
    """Everything a parse writes for one sentence: the old syntactic words it
    replaces (substrate-preserving mode), its word tokens (full mode), its
    syntactic words, their annotation spans and its dependency relations.
    A sentence's parse goes in one batch, so each sentence is left with its
    old parse or the whole new one."""

    def __init__(self):
        self.deletes = []
        self.words = []
        self.morphemes = []
        self._rows = []  # parallel to morphemes: (Stanza row, word substring)
        self.spans = {}  # span layer id -> [span op]
        self.relations = []
        self._slots = 0

    def add_morpheme(self, op, row, word_substring):
        self.morphemes.append(op)
        self._rows.append((row, word_substring))

    def plan_annotations(self, sentence_data, layers, frag):
        """The spans on this sentence's syntactic words and the relations
        between their lemma spans."""
        # Rows a dependency relation will touch: its target (the row carrying
        # the DEPREL) and its source (the row that one names as HEAD). Each
        # needs a Lemma span for the relation to hang off, even where the
        # parse produced no lemma at all. Stanza drops a processor whose model
        # the language lacks and says so in a warning only, so a pipeline can
        # return DEPREL with the lemma column empty throughout, and every tree
        # in the document was then dropped in silence. The null-valued span is
        # the one the editor leaves behind when a lemma is cleared, and it
        # exports as `_` again. This mirrors ConlluDocument.importFromConllu,
        # which carries the same rule.
        needs_lemma = set()
        for td in sentence_data:
            if isinstance(td["id"], tuple) or not td.get("deprel"):
                continue
            needs_lemma.add(td["id"])
            head = td.get("head")
            if head and head > 0:
                needs_lemma.add(head)

        def span(layer, k, value):
            self._slots += 1
            self.spans.setdefault(layer["id"], []).append(
                make_span_token(layer["id"], [_Slot("morpheme", k)], value, frag))

        lemma_of_row = {}  # row id -> index of its lemma span in this sentence
        for k, (row, word_substring) in enumerate(self._rows):
            form = row.get("text")
            # A Form span is only needed when the surface form differs from the
            # morpheme's substring (i.e. real MWT components).
            if layers.form and form and form != word_substring:
                span(layers.form, k, form)
            lemma = row.get("lemma")
            if layers.lemma and (lemma or row["id"] in needs_lemma):
                lemma_of_row[row["id"]] = len(self.spans.get(layers.lemma["id"], []))
                span(layers.lemma, k, lemma or None)
            if layers.upos and row.get("upos"):
                span(layers.upos, k, row["upos"])
            if layers.xpos and row.get("xpos"):
                span(layers.xpos, k, row["xpos"])
            if layers.features and row.get("feats"):
                for value in row["feats"].split("|"):
                    if value:
                        span(layers.features, k, value)

        if not layers.dependency:
            return
        for td in sentence_data:
            if isinstance(td["id"], tuple) or not td.get("deprel"):
                continue
            target = lemma_of_row.get(td["id"])
            head = td.get("head")
            if target is None:
                continue
            # The root points at itself.
            source = target if head == 0 else lemma_of_row.get(head) if head else None
            if source is None:
                continue
            self._slots += 2
            self.relations.append({
                "relation_layer_id": layers.dependency["id"],
                "source": _Slot("lemma", source),
                "target": _Slot("lemma", target),
                "value": td["deprel"],
                "metadata": dict(frag),
            })

    def word_bytes(self):
        return _json_bytes(self.words)

    def parse_bytes(self):
        return (_json_bytes([self.deletes, self.morphemes, self.spans, self.relations])
                + REF_BYTES * self._slots)


def _resolved(op, refs):
    """``op`` with each slot in it replaced by the batch ref ``refs`` holds for
    it."""
    def one(value):
        return refs[(value.kind, value.k)] if isinstance(value, _Slot) else value

    return {key: ([one(v) for v in value] if isinstance(value, list) else one(value))
            for key, value in op.items()}


def queue_sentences(batch, deletes, sentence_ops, word_units, parse_units, layers):
    """Queue one batch of a parse, top down (sentences, words, syntactic
    words, spans, relations), since a child without its parent is a 400 and
    the server runs a batch's ops in order. Each span names its syntactic
    word, and each relation its lemma spans, by a ref to the id an earlier op
    of the same batch creates."""
    deletes = list(deletes) + [d for unit in parse_units for d in unit.deletes]
    if deletes:
        batch.tokens.bulk_delete(deletes)
    if sentence_ops:
        batch.tokens.bulk_create(sentence_ops)
    words = [w for unit in word_units for w in unit.words]
    if words:
        batch.tokens.bulk_create(words)

    refs = [{} for _ in parse_units]  # per unit: (kind, k) -> ref

    def create(resource, kind, ops_of):
        owned = [(i, op) for i, unit in enumerate(parse_units) for op in ops_of(unit)]
        if not owned:
            return
        resource.bulk_create([_resolved(op, refs[i]) for i, op in owned])
        counts = [0] * len(parse_units)
        for n, (i, _op) in enumerate(owned):
            if kind:
                refs[i][(kind, counts[i])] = batch.ref(-1, n)
            counts[i] += 1

    create(batch.tokens, "morpheme", lambda unit: unit.morphemes)
    for layer in layers.span_layers:
        create(batch.spans, "lemma" if layer is layers.lemma else None,
               lambda unit, layer_id=layer["id"]: unit.spans.get(layer_id, []))
    create(batch.relations, None, lambda unit: unit.relations)


def write_parse(client, head_deletes, sentence_ops, units, layers, progress, log):
    """Write a planned parse in as few batches as the server's body cap allows.

    The whole parse in one request passes the cap (10 MB by default) at a few
    thousand words, so the unit is a group of sentences: one batch holds the
    delete of those sentences' old syntactic words, their new ones, their
    spans and their relations. A failure leaves every sentence with its old
    parse or its whole new one. In a from-scratch parse the sentence layer is
    a partition, which the server takes only whole, so the first batch carries
    the old tokens' delete and every sentence, and the words of each sentence
    come before any of its parse. A failure there leaves words with no parse,
    which the next run fills in without changing them."""
    budget = batch_body_budget(client)
    items = []  # (kind, unit index, bytes), in the order they must land
    # Substrate-preserving mode makes words only for a sentence that had
    # none, and they go in the batch that parses it, so the sentence is left
    # as it was or whole.
    joined = not (head_deletes or sentence_ops)
    if not joined:
        items.append(("head", None, _json_bytes([head_deletes, sentence_ops])))
        items += [("words", i, unit.word_bytes()) for i, unit in enumerate(units) if unit.words]
    items += [("parse", i, unit.parse_bytes() + (unit.word_bytes() if joined and unit.words else 0))
              for i, unit in enumerate(units)]

    batches, current, size = [], [], 0
    for item in items:
        if current and size + item[2] > budget:
            batches.append(current)
            current, size = [], 0
        current.append(item)
        size += item[2]
    if current:
        batches.append(current)

    total = len(units)
    written = 0
    head_written = False
    worded = 0  # sentences whose words stand, in a from-scratch parse
    try:
        for group in batches:
            head = any(kind == "head" for kind, _, _ in group)
            word_units = [units[i] for kind, i, _ in group
                          if kind == "words" or (joined and kind == "parse")]
            parse_units = [units[i] for kind, i, _ in group if kind == "parse"]
            if parse_units and len(batches) == 1:
                message = f"Writing {total} sentence{'' if total == 1 else 's'}…"
            elif parse_units:
                message = (f"Writing sentences {written + 1} to {written + len(parse_units)} "
                           f"of {total}…")
            else:
                message = "Writing the words…"
            progress.report(ParseProgress.WRITE, written / max(total, 1), message)
            log(f"  {message} ({sum(b for _, _, b in group)} bytes estimated)")
            with client.batched() as batch:
                queue_sentences(batch, head_deletes if head else [],
                                sentence_ops if head else [], word_units, parse_units, layers)
            written += len(parse_units)
            head_written = head_written or head
            worded += sum(1 for kind, _, _ in group if kind == "words")
    except Exception as error:
        if written:
            raise partly_written(written, total, "parsed", error) from error
        if head_written:
            # The new sentences stand, and some of their words, none parsed.
            raise RuntimeError(
                f"The {len(sentence_ops)} sentences were written, and the words of {worded} of them, "
                f"none parsed. Parse again to finish. {requester_message(error)}") from error
        raise


def sentence_words(tokenizer, body, begin, end):
    """The surface words Stanza finds in ``body[begin:end]``, as
    ``{begin, end}`` in the body's offsets. A multiword token is one word
    over its whole surface, as the full parse writes it. Whatever sentences
    Stanza splits the stretch into, it stays the one sentence the document
    has."""
    words = []
    for sentence_data in tokenizer(body[begin:end]).to_dict():
        i = 0
        while i < len(sentence_data):
            td = sentence_data[i]
            wb, we = td["start_char"] + begin, td["end_char"] + begin
            if begin <= wb < we <= end:
                words.append({"begin": wb, "end": we})
            if isinstance(td["id"], tuple):
                i += 1 + td["id"][1] - td["id"][0] + 1
            else:
                i += 1
    return words


def parse_document(pipeline_provider, client, document_id, language='en', overwrite=False,
                   helper=None, requester=Requester()):
    """Parse a document with Stanza and write UD annotations into Plaid.

    Two modes, chosen by what already exists:

    - FULL REPLACE (untokenized document): tokenize from scratch and create
      the three-layer hierarchy (sentences > words > syntactic words) plus
      the UD annotation spans and dependency relations. The sentence reset
      cascade-deletes EVERYTHING under the text layer — other apps' layers
      included — so the provenance guard walks the whole tree.
    - SUBSTRATE-PRESERVING (sentence + word tokens already exist, e.g. a
      project shared with another app): keep the existing tokenization and
      re-parse PER SENTENCE — only sentences with no human-made/verified UD
      annotation are refreshed (Stanza runs pretokenized over their words,
      replacing UD's syntactic-word tokens + spans/relations for just those
      sentences); sentences a human has touched are left untouched. Limitation:
      pretokenized Stanza does not split multiword tokens, so each word gets
      exactly one syntactic word (annotators can still split by hand).

    Provenance write contract: every syntactic word, span and relation created
    here is stamped machine-made (prov_fragment). Sentence and word tokens are
    substrate and are not stamped. A re-parse replaces machine-made UNVERIFIED material but
    never human-made/verified work: substrate-preserving mode skips sentences
    that carry any (unless `overwrite`); a from-scratch re-tokenize refuses
    outright if such annotations would be lost (unless `overwrite`). Returns a
    summary dict {mode, parsed_sentences, skipped_sentences}."""
    frag = prov_fragment(language, requester)
    progress = ParseProgress(helper)

    def log(msg):
        # Force-flush so the next-line-after-hang shows whatever the last
        # successful step was, even if Python's stdout is block-buffered.
        print(msg, flush=True)

    log(f"Starting parse for document {document_id}")

    # Resolve layers FIRST — the parse mode depends on what exists.
    log("Fetching document with layers…")
    progress.report(ParseProgress.FETCH, 0.0, "Reading the document…")
    full_document = client.documents.get(document_id, include_body=True)
    log("  …document fetched")
    # Resolve the substrate by its cross-app role tag (config.plaid.role),
    # never by position: find_by_role returns None rather than guessing, so
    # a missing/mistagged baseline fails loudly instead of parsing the wrong
    # text layer. The parse runs on (and offsets into) THIS baseline body —
    # parsing one string while offsetting into another would corrupt tokens.
    text_layers = full_document["text_layers"]
    text_layer = find_by_role(text_layers, ROLES.BASELINE)
    if not text_layer:
        raise setup_incomplete("no baseline-role text layer")
    text_id = text_layer["text"]["id"]
    body = text_layer["text"]["body"]
    if not (body or "").strip():
        raise RuntimeError("The document has no text.")

    # Substrate token layers are bound by their shared role (config.plaid.role),
    # NOT by the per-app ud.* flags. UD's "Morphemes" layer carries role
    # "syntactic-word" (it holds CoNLL-U syntactic words), not "morpheme".
    token_layers = text_layer.get("token_layers", [])
    sentence_layer = find_by_role(token_layers, ROLES.SENTENCE)
    word_layer = find_by_role(token_layers, ROLES.WORD)
    morpheme_layer = find_by_role(token_layers, ROLES.SYNTACTIC_WORD)

    if not (sentence_layer and word_layer and morpheme_layer):
        raise setup_incomplete("no sentence, word or syntactic-word token layer")

    span_layers = morpheme_layer.get("span_layers", [])
    form_layer = span_layer_by_ud_config(span_layers, "form", "Form")
    lemma_layer = span_layer_by_ud_config(span_layers, "lemma", "Lemma")
    upos_layer = span_layer_by_ud_config(span_layers, "upos", "UPOS")
    xpos_layer = span_layer_by_ud_config(span_layers, "xpos", "XPOS")
    features_layer = span_layer_by_ud_config(span_layers, "features", "Features")

    existing_sentences = sorted(sentence_layer.get("tokens") or [], key=lambda t: t["begin"])
    existing_words = sorted(word_layer.get("tokens") or [], key=lambda t: (t["begin"], t["end"]))
    existing_morphemes = morpheme_layer.get("tokens", []) or []
    log(f"Existing tokens: {len(existing_sentences)} sentences, "
        f"{len(existing_words)} words, {len(existing_morphemes)} syntactic words")
    progress.report(ParseProgress.FETCH, 1.0, "Reading the document…")

    preserve = bool(existing_sentences and existing_words)

    if preserve:
        # ----- SUBSTRATE-PRESERVING mode (sentence-selective) -----------
        # Re-parse only sentences that carry NO human-made/verified UD
        # annotation; sentences a human has reviewed/edited are left exactly
        # as they are. This is the "click Parse again" path — it refreshes
        # the machine-only and not-yet-parsed sentences without disturbing
        # your work. `overwrite` re-parses every sentence regardless.

        # Group the existing words under their containing sentences (the
        # sentence layer is partitioning, so containment is well-defined);
        # keep the sentence object alongside for per-sentence decisions.
        sent_groups = []  # [(sentence_token, [word_tokens])]
        for sent in existing_sentences:
            ws = [w for w in existing_words
                  if sent["begin"] <= w["begin"] and w["end"] <= sent["end"]]
            sent_groups.append((sent, ws))
        grouped_count = sum(len(ws) for _, ws in sent_groups)
        if grouped_count != len(existing_words):
            log(f"  WARNING: {len(existing_words) - grouped_count} word token(s) "
                f"fall outside the sentence partition; they get no syntactic word")

        morph_to_sent = morpheme_sentence_index(sent_groups, existing_morphemes)
        protected_idxs = protected_sentence_indexes(morpheme_layer, lemma_layer, morph_to_sent)

        # A sentence with text and no words (a from-scratch parse that
        # stopped after writing the sentences) is tokenized here, on its
        # own, and its words are written with its parse. Left out, it was
        # skipped by every later Parse, which reported success.
        unworded = [idx for idx, (sent, ws) in enumerate(sent_groups)
                    if not ws and body[sent["begin"]:sent["end"]].strip()]
        new_words = set()
        if unworded:
            log(f"  {len(unworded)} sentence(s) have no words; tokenizing them")
            progress.report(ParseProgress.LOAD, 0.0, f"Loading the {language} models…")
            with progress.heartbeat(ParseProgress.LOAD, 0.0, f"Loading the {language} models…"):
                tokenizer = pipeline_provider.get(language)
            for n, idx in enumerate(unworded):
                progress.report(ParseProgress.PARSE, n / len(unworded),
                                f"Finding the words of sentence {n + 1} of {len(unworded)}…")
                sent = sent_groups[idx][0]
                ws = sentence_words(tokenizer, body, sent["begin"], sent["end"])
                sent_groups[idx] = (sent, ws)
                new_words.add(idx)

        # Sentences to (re)parse: those with words and — unless overwrite —
        # no human annotations. Carry the original index for clear errors.
        reparse = [(idx, sent, ws) for idx, (sent, ws) in enumerate(sent_groups)
                   if ws and (overwrite or idx not in protected_idxs)]
        reparse_idxs = {idx for idx, _, _ in reparse}
        skipped_idxs = protected_idxs - reparse_idxs
        log(f"Sentence-selective parse: {len(reparse)} sentence(s) to (re)parse; "
            f"{len(skipped_idxs)} with human annotations "
            + ("re-parsed anyway (overwrite on)" if overwrite else "left untouched"))

        if not reparse:
            log("Nothing to (re)parse — every sentence with words has human annotations.")
            return {"mode": "preserve", "parsed_sentences": 0,
                    "skipped_sentences": len(skipped_idxs)}

        log("Preserving existing tokenization; parsing pretokenized…")
        # The first parse in a language downloads its models, which is the
        # longest silent stretch this service has. Name it before it starts.
        progress.report(ParseProgress.LOAD, 0.0, f"Loading the {language} models…")
        with progress.heartbeat(ParseProgress.LOAD, 0.0, f"Loading the {language} models…"):
            pipeline = pipeline_provider.get(language, pretokenized=True)

        # Parse in groups rather than handing Stanza every sentence at
        # once: the bar then moves through a long document, and `report`
        # is a cancellation checkpoint, so a stop lands between groups:
        # before any write, leaving the document untouched.
        sentences_data = []
        total = len(reparse)
        for start in range(0, total, SENTENCE_GROUP):
            group = reparse[start:start + SENTENCE_GROUP]
            progress.report(ParseProgress.PARSE, start / total,
                            f"Parsing sentence {start + 1} of {total}…")
            stanza_doc = pipeline([[body[w["begin"]:w["end"]] for w in ws]
                                   for _, _, ws in group])
            sentences_data.extend(stanza_doc.to_dict())

        # The syntactic-word tokens of the RE-PARSED sentences go (which
        # cascades their UD spans/relations); skipped sentences keep
        # theirs. PLANNED here and carried out in the write phase below,
        # each sentence's delete in the batch that writes its new parse, so
        # a stop during the parse leaves the document exactly as it was.
        r_of_orig = {orig_idx: r_idx for r_idx, (orig_idx, _, _) in enumerate(reparse)}
        units = [SentenceWrites() for _ in reparse]
        for m in existing_morphemes:
            r_idx = r_of_orig.get(morph_to_sent.get(m["id"]))
            if r_idx is not None:
                units[r_idx].deletes.append(m["id"])
        head_deletes = []

        sentence_ops = []  # substrate preserved
        # `r_idx` is the index INTO `sentences_data` (the re-parsed
        # subset), so the shared span/relation code below stays consistent.
        for r_idx, ((orig_idx, sent, ws), sentence_data) in enumerate(zip(reparse, sentences_data)):
            rows = [td for td in sentence_data if not isinstance(td["id"], tuple)]
            if len(rows) != len(ws):
                # A misalignment would hang annotations on the wrong
                # words — fail loudly rather than guess.
                raise RuntimeError(
                    f"Pretokenized parse returned {len(rows)} words for a "
                    f"{len(ws)}-word sentence (original index {orig_idx}); aborting")
            if orig_idx in new_words:
                units[r_idx].words = [make_bulk_token(word_layer["id"], text_id, w["begin"], w["end"])
                                      for w in ws]
            for w, row in zip(ws, rows):
                op = make_bulk_token(morpheme_layer["id"], text_id,
                                     w["begin"], w["end"], metadata=dict(frag))
                op["precedence"] = 0
                units[r_idx].add_morpheme(op, row, body[w["begin"]:w["end"]])
        parse_summary = {"mode": "preserve", "parsed_sentences": len(reparse),
                         "skipped_sentences": len(skipped_idxs)}
    else:
        # ----- FULL-REPLACE mode -----------------------------------------
        # The sentence cascade destroys EVERYTHING under the text layer —
        # other apps' layers included — so the guard walks the whole tree.
        protected, breakdown = count_protected_annotations(token_layers)
        if protected and not overwrite:
            raise RuntimeError(format_protected_error(
                protected, breakdown,
                "on this document (they may belong to other apps sharing the project)"))
        if protected:
            log(f"Overwrite enabled: replacing {protected} protected annotation(s)")

        log("Tokenizing + parsing from scratch…")
        progress.report(ParseProgress.LOAD, 0.0, f"Loading the {language} models…")
        with progress.heartbeat(ParseProgress.LOAD, 0.0, f"Loading the {language} models…"):
            pipeline = pipeline_provider.get(language)
        # Stanza decides the sentence boundaries here, so the body cannot
        # be split into groups without changing where the sentences fall.
        # This is one call and one quiet stretch; the requester's elapsed
        # clock is what carries it, so say what is happening first.
        progress.report(ParseProgress.PARSE, 0.0,
                        f"Parsing {len(body)} characters…")
        with progress.heartbeat(ParseProgress.PARSE, 0.0, f"Parsing {len(body)} characters…"):
            stanza_doc = pipeline(body)
        sentences_data = stanza_doc.to_dict()
        log(f"Parsed {len(sentences_data)} sentences")
        progress.report(ParseProgress.PARSE, 1.0,
                        f"Parsed {len(sentences_data)} sentences…")
        parse_summary = {"mode": "full", "parsed_sentences": len(sentences_data),
                         "skipped_sentences": 0}

        # Reset: plan the delete of pre-existing tokens, leaning on
        # server-side cascade for the normal case. Deleting sentences
        # cascades to their words + morphemes server-side in one shot. The
        # lower elif branches only kick in for half-parsed states (sentences
        # absent but lower layers left over from a botched mid-flight
        # parse). Doing this top-down rather than bottom-up matters a lot
        # for perf: an explicit bottom-up cycle for a 285-word doc ran ~30s
        # server-side (each word delete runs constraint queries
        # individually), while a single-sentence cascade collapses that into
        # one server-side transaction. (preserve=False means at most one
        # branch fires.) Carried out in the write phase below.
        if existing_sentences:
            head_deletes = [t["id"] for t in existing_sentences]
            log(f"  Will delete {len(head_deletes)} sentences (cascades to words + morphemes)")
        elif existing_words:
            head_deletes = [t["id"] for t in existing_words]
            log(f"  Will delete {len(head_deletes)} orphan words (no sentences to cascade from)")
        elif existing_morphemes:
            head_deletes = [t["id"] for t in existing_morphemes]
            log(f"  Will delete {len(head_deletes)} orphan morphemes")
        else:
            head_deletes = []

        # 1. Sentence tokens: a gap-free partition of [0, len(body)). Sentence i
        #    runs from its first token to the start of sentence i+1, so inter-
        #    sentence whitespace stays with the preceding sentence; sentence 0
        #    starts at 0 and the last sentence ends at len(body).
        n_sents = len(stanza_doc.sentences)
        starts = [0 if i == 0 else sent.tokens[0].start_char
                  for i, sent in enumerate(stanza_doc.sentences)]
        sentence_ops = []
        for i in range(n_sents):
            begin = starts[i]
            end = starts[i + 1] if i + 1 < n_sents else len(body)
            op = make_bulk_token(sentence_layer["id"], text_id, begin, end)
            # Preserve the Stanza-recovered sentence text on the sentence token so
            # the exporter can round-trip it (e.g. when surface forms differ from
            # the body slice — contractions, normalized punctuation). Sentence
            # and word tokens are substrate and carry no provenance stamp: the
            # run's service-run operation names what made them.
            op["metadata"] = {"text": stanza_doc.sentences[i].text}
            sentence_ops.append(op)

        # 2/3. Word and morpheme tokens. Each surface token is a word; each
        #      integer-id syntactic word is a morpheme that inhabits the FULL
        #      width of its word (multiword-token components share the extent).
        units = [SentenceWrites() for _ in sentences_data]
        for sent_idx, sentence_data in enumerate(sentences_data):
            unit = units[sent_idx]
            i = 0
            while i < len(sentence_data):
                td = sentence_data[i]
                if isinstance(td["id"], tuple):
                    start_id, end_id = td["id"]
                    count = end_id - start_id + 1
                    wb, we = td["start_char"], td["end_char"]
                    # Persist the MWT surface form on the word token's
                    # metadata so the exporter can round-trip it. (1:1 words
                    # leave metadata clean; the body substring is canonical.)
                    # Unstamped, as substrate.
                    word_meta = {}
                    if td.get("text") and td["text"] != body[wb:we]:
                        word_meta["form"] = td["text"]
                    if td.get("misc"):
                        word_meta["misc"] = td["misc"]
                    unit.words.append(make_bulk_token(
                        word_layer["id"], text_id, wb, we, metadata=word_meta
                    ))
                    members = sentence_data[i + 1:i + 1 + count]
                    for prec, member in enumerate(members):
                        op = make_bulk_token(morpheme_layer["id"], text_id, wb, we,
                                             metadata=dict(frag))
                        op["precedence"] = prec
                        unit.add_morpheme(op, member, body[wb:we])
                    i += 1 + count
                else:
                    wb, we = td["start_char"], td["end_char"]
                    unit.words.append(make_bulk_token(word_layer["id"], text_id, wb, we))
                    op = make_bulk_token(morpheme_layer["id"], text_id, wb, we,
                                         metadata=dict(frag))
                    op["precedence"] = 0
                    unit.add_morpheme(op, td, body[wb:we])
                    i += 1

    # ----- the writes ---------------------------------------------------
    # One stretch that must finish once begun. A stop asked for while the
    # document was being read or parsed has already landed, before anything
    # was touched; one that arrives from here on is held off until the
    # document is whole again. The caller's final report belongs inside a
    # critical block too: a checkpoint after the last write would throw a
    # finished parse away and call it stopped.
    layers = UdLayers(form_layer, lemma_layer, upos_layer, xpos_layer, features_layer,
                      relation_layer_by_ud_config(lemma_layer, "dependency"))
    for unit, sentence_data in zip(units, sentences_data):
        unit.plan_annotations(sentence_data, layers, frag)
    log(f"Planned {len(sentence_ops)} sentences, "
        f"{sum(len(u.words) for u in units)} words, "
        f"{sum(len(u.morphemes) for u in units)} syntactic words")
    with progress.critical():
        write_parse(client, head_deletes, sentence_ops, units, layers, progress, log)
        log(f"Successfully parsed document {document_id}")
    return parse_summary


class StanzaParserService(BaseService):
    """Stanza-based UD parser served on every accessible project.

    Built on the shared `BaseService` SDK (client/token bootstrap, registration,
    the single-flight processing lock, and the CLI loop). Per-request user args
    (`language`, `overwrite`) are declared in the parameter schema below and read
    back from `request_data` in `process_request`. Audit attribution comes from
    the named API token the service authenticates with (mint one under
    Profile → API Tokens), so the rows it writes are attributable to the machine.
    """

    def __init__(self):
        super().__init__(
            service_id='stanza-parser',
            service_name='Stanza parser',
            description=('Provides document parsing using Stanza pipeline with '
                         'tokenization, POS tagging, lemmatization, and dependency parsing'),
            tasks=[TASKS.PARSE],
            summary=PARSER_SUMMARY,
            parameters=[
                Param.enum('language', 'Language', STANZA_LANGUAGES, default='en',
                           description='Language models Stanza uses for parsing.'),
                Param.boolean('overwrite', 'Overwrite human-edited annotations', default=False,
                              description='Re-parse sentences even where a human created or '
                                          'verified annotations (discarding them). When off, '
                                          'those sentences are left untouched.'),
            ],
        )
        self.pipeline_provider = None

    def setup(self, args):
        # Pipelines are built lazily per requested language and cached; preload
        # the default so the common case is warm at startup.
        print("Loading Stanza pipeline (en)…")
        self.pipeline_provider = PipelineProvider(processors='tokenize,pos,lemma,depparse')
        self.pipeline_provider.get('en')

    def process_request(self, request_data, response_helper):
        # `BaseService.handle_service_request` already wraps this in a
        # non-blocking single-flight lock — only one parse runs at a time across
        # every served project, which is what the shared (not thread-safe) Stanza
        # pipelines need — and reports any exception via response_helper.error.
        # So this just does the work; a second concurrent request is rejected
        # with "try again later" rather than queued (parsing is CPU-bound).
        print(f"Received service request: {request_data}")
        document_id = request_data.get('document_id')
        # User-controlled arguments (declared in the parameter schema above; the
        # client delivers request keys to Python as snake_case).
        language = request_data.get('language', 'en')
        overwrite = bool(request_data.get('overwrite', False))
        requester = requester_of(self.client, request_data)

        # The parse deletes + recreates tokens / spans / relations, so a human
        # editing the same document — or another service — would race the
        # rewrite. Hold plaid-core's server-enforced document lock for the
        # duration: writes by another user are rejected with 423 while we hold
        # it, and if someone else already holds it `locked` raises and we refuse
        # rather than clobber their work.
        response_helper.progress(2, "Starting…")
        # Group every write this parse makes into ONE labeled audit-log entry (each
        # op keeps its own description underneath).
        # `parse_document` reports the rest of the way and is a cancellation
        # checkpoint at every group of sentences, so a stop lands before the
        # writes begin and leaves the document untouched.
        with self.client.operation(requester.label(f"Stanza UD parse ({language})"),
                                   kind='service-run', ref=service_source(self.service_id)):
            with locked_for_writes(self.client, document_id):
                summary = parse_document(self.pipeline_provider, self.client, document_id,
                                         language=language, overwrite=overwrite,
                                         helper=response_helper, requester=requester)

        # parse_document returns a summary dict; author the user-facing notice
        # here (the service owns ALL the wording — the editor only maps `level`
        # to a colour) and report what it actually did.
        notice = build_parse_notice(summary.get("parsed_sentences", 0),
                                    summary.get("skipped_sentences", 0))
        # Everything is written by now, so a stop has nothing left to prevent:
        # reporting it outside a critical block would raise here and hand back
        # `stopped: true` over a fully parsed document.
        with response_helper.critical():
            response_helper.progress(100, notice["title"])
            # Outbound keys are snake_case (already so in `summary`): the client's
            # snake→kebab transform on send + the JS client's kebab→camel on receive
            # deliver them to the UI as camelCase. `notice` rides along so the editor
            # shows the service's wording verbatim.
            response_helper.complete({"document_id": document_id, "status": "success",
                                      "notice": notice, **summary})


if __name__ == '__main__':
    # CLI (handled by BaseService.run):
    #   python ud_parse_stanza.py                → serve ALL accessible projects (existing + future)
    #   python ud_parse_stanza.py --all          → serve ALL accessible projects (existing + future)
    #   python ud_parse_stanza.py PROJECT_ID     → serve one project
    #   --url URL                                → Plaid API URL (default :8080)
    StanzaParserService().run()
