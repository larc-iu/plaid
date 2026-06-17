"""FST Morphological Analyzer / Vocab Linker (demo service).

Drives interlinear glossing from a **finite-state transducer**. Given an inflected
word, an HFST analyzer returns e.g. ``kissoja -> kissa+N+Pl+Par``; this service turns
that into real plaid-igt structure:

  * **segment** the word into morphemes (stem + one per inflectional feature),
  * **auto-gloss** each morpheme (PL, PAR, ... Leipzig-style),
  * **link** the stem to a lexicon vocab item (created if missing).

It registers under the ``link-vocab`` task, so it shows up in the IGT editor's
existing **"Auto-link to lexicon"** dialog with a parameter form. The depth is a
run-time toggle: untick *Segment* for plain lemma-based linking.

PLUGGABILITY. The FST is behind a tiny :class:`Analyzer` seam (``analyze(surface)
-> [(analysis, weight)]``). Two backends ship: ``UralicAnalyzer`` (a Giellatekno
model fetched by ``uralicNLP`` — turnkey, dozens of languages) and
``HfstFileAnalyzer`` (any compiled ``.hfst``/``.hfstol`` you point it at). A
foma/pynini backend is just another ``analyze()`` away.

  Setup (one-time, in the repo's mamba ``base`` env):
      pip install hfst uralicNLP
      python -c "from uralicNLP import uralicApi; uralicApi.download('fin')"

  Smoke test (no server needed):
      python igt_link_fst.py --selftest                 # Finnish defaults
      python igt_link_fst.py --selftest --lang sme       # North Sámi
      python igt_link_fst.py --selftest --fst my.hfstol  # bring-your-own

  Run against Plaid (registers on every accessible project; first run prompts
  for an API token -> cached in ./.token):
      python igt_link_fst.py --url http://localhost:8085
      python igt_link_fst.py <projectId> --lang fin
"""

import argparse
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Tuple

from plaid_client import BaseService, TASKS, Param, service_source
from plaid_client.provenance import stamp_inferred, prov_state, MACHINE


# ===========================================================================
# Analyzer seam — any FST in the HFST framework plugs in by implementing this.
# ===========================================================================

class Analyzer(ABC):
    """A morphological analyzer: surface form -> ranked raw analyses."""

    @abstractmethod
    def analyze(self, surface: str) -> List[Tuple[str, float]]:
        """Return ``[(analysis_string, weight), ...]`` — any order; the service
        sorts by weight and takes the best. An empty list means "no analysis"."""
        raise NotImplementedError

    def describe(self) -> str:
        return self.__class__.__name__


class UralicAnalyzer(Analyzer):
    """Giellatekno analyzer for a language code, via ``uralicNLP`` (downloads the
    model on first use). Examples: ``fin`` (Finnish), ``sme`` (North Sámi),
    ``myv`` (Erzya). The analysis strings are Giella-style ``lemma+Tag+Tag``."""

    def __init__(self, lang: str):
        from uralicNLP import uralicApi
        if not uralicApi.is_language_installed(lang):
            print(f"Downloading Giellatekno model for '{lang}' (one-time)…")
            uralicApi.download(lang)
        self._api = uralicApi
        self._lang = lang

    def analyze(self, surface: str) -> List[Tuple[str, float]]:
        return list(self._api.analyze(surface, self._lang) or [])

    def describe(self) -> str:
        return f"uralicNLP:{self._lang}"


class HfstFileAnalyzer(Analyzer):
    """A compiled HFST transducer loaded from a ``.hfst``/``.hfstol`` file — the
    "bring-your-own FST" path (Apertium/GiellaLT release artifacts, your own
    compiled grammar, …)."""

    def __init__(self, path: str):
        import hfst
        stream = hfst.HfstInputStream(path)
        self._t = stream.read()
        stream.close()
        self._path = path

    def analyze(self, surface: str) -> List[Tuple[str, float]]:
        # hfst lookup returns [(output, weight), ...].
        return [(out, float(w)) for out, w in self._t.lookup(surface)]

    def describe(self) -> str:
        return f"hfst:{self._path}"


def make_analyzer(*, lang: Optional[str], fst_path: Optional[str]) -> Analyzer:
    """A local file wins over a language code; otherwise default to Finnish."""
    if fst_path:
        return HfstFileAnalyzer(fst_path)
    return UralicAnalyzer(lang or "fin")


# ===========================================================================
# Analysis-string -> (lemma, pos, features) and feature -> Leipzig gloss.
# ===========================================================================

# Giella/Apertium part-of-speech tags (the first tag after the lemma). Kept off
# the gloss line; the POS instead annotates the lexicon item.
POS_TAGS = {
    "N", "V", "A", "Adv", "Num", "Pron", "CC", "CS", "Po", "Pr", "Adp", "Pref",
    "Interj", "Pcle", "Punct", "PUNCT", "Prop", "ABBR", "Acr", "Symbol", "Det",
}

# Feature tag -> Leipzig-ish gloss. Tuned for Finnish/Giella but easy to extend;
# anything unmapped falls back to the upper-cased tag, so it still glosses.
LEIPZIG = {
    # number
    "Sg": "SG", "Pl": "PL",
    # Finnish cases
    "Nom": "NOM", "Gen": "GEN", "Acc": "ACC", "Par": "PAR", "Ine": "INE",
    "Ela": "ELA", "Ill": "ILL", "Ade": "ADE", "Abl": "ABL", "All": "ALL",
    "Ess": "ESS", "Tra": "TRA", "Ins": "INS", "Abe": "ABE", "Com": "COM",
    "Lat": "LAT",
    # tense / mood / voice / nonfinite
    "Prs": "PRS", "Prt": "PST", "Past": "PST", "Ind": "IND", "Cond": "COND",
    "Imprt": "IMP", "Imp": "IMP", "Pot": "POT", "Opt": "OPT", "Act": "ACT",
    "Pass": "PASS", "Inf": "INF", "PrfPrc": "PTCP", "PrsPrc": "PTCP",
    "Neg": "NEG", "ConNeg": "CNG",
    # person / possessive suffix
    "Sg1": "1SG", "Sg2": "2SG", "Sg3": "3SG", "Pl1": "1PL", "Pl2": "2PL",
    "Pl3": "3PL",
    "PxSg1": "PX.1SG", "PxSg2": "PX.2SG", "PxSg3": "PX.3SG",
    "PxPl1": "PX.1PL", "PxPl2": "PX.2PL", "PxPl3": "PX.3PL", "Px3": "PX.3",
    # comparison / clitics
    "Comp": "CMPR", "Superl": "SUP", "Qst": "Q",
}

# Case-folded indexes so lowercase Apertium tags (`<n>`, `<pl>`) match the same
# entries as Giella's mixed-case (`+N`, `+Pl`), without disturbing Giella keys
# like `PxSg1` that a naive capitalize() would mangle.
_POS_CANON = {t.casefold(): t for t in POS_TAGS}
_LEIPZIG_FOLD = {k.casefold(): v for k, v in LEIPZIG.items()}


def parse_analysis(analysis: str, tag_format: str) -> Optional[Tuple[str, Optional[str], List[str]]]:
    """``'kissa+N+Pl+Par'`` -> ``('kissa', 'N', ['Pl', 'Par'])``.

    ``giella`` splits on ``+`` (lemma first); ``apertium`` reads ``lemma<n><pl>``.
    Diagnostic/derivation sub-tags (containing ``/``) and empties are dropped.
    Returns ``None`` if no lemma can be recovered.
    """
    if tag_format == "apertium":
        i = analysis.find("<")
        lemma = (analysis if i < 0 else analysis[:i]).strip()
        tags = [t.strip(">").strip() for t in analysis[i:].split("<") if t.strip(">")] if i >= 0 else []
    else:  # giella
        parts = [p for p in analysis.split("+")]
        lemma = parts[0].strip() if parts else ""
        tags = [p.strip() for p in parts[1:]]

    tags = [t for t in tags if t and "/" not in t]
    if not lemma:
        return None
    pos = None
    if tags and tags[0].casefold() in _POS_CANON:
        pos, tags = _POS_CANON[tags[0].casefold()], tags[1:]
    features = [t for t in tags if t.casefold() not in _POS_CANON]
    return lemma, pos, features


def gloss_for(tag: str) -> str:
    return _LEIPZIG_FOLD.get(tag.casefold(), tag.upper())


# ===========================================================================
# Service
# ===========================================================================

SUMMARY = """\
Analyzes each word with a **finite-state transducer** and writes the result as
interlinear structure. With *Segment* on, every word is split into morphemes
(stem + one per inflectional feature), each morpheme is **glossed**
(`PL`, `PAR`, … Leipzig-style), and the stem is **linked** to a lexicon entry
(created if missing). Untick *Segment* for plain lemma-based **linking** only.

- **Analyzer language** — a Giellatekno code (`fin`, `sme`, `myv`, …) downloaded
  on demand; or set a local transducer at launch with `--fst`.
- **Tag format** — `giella` (`lemma+N+Pl`) or `apertium` (`lemma<n><pl>`).
- **Overwrite human-edited material** — off by default: words a person has
  already analyzed or whose links/glosses they confirmed are left untouched.
  Machine-made, unverified output is always refreshed.

Everything created carries provenance (`prov`/`provSource`) and renders in
violet until a human confirms it.
"""

SELFTEST_WORDS = ["kissoja", "taloissamme", "juoksen", "koirilleni"]


class FstLinkerService(BaseService):
    def __init__(self):
        super().__init__(
            service_id="igt:fst-analyzer",
            service_name="FST Morphological Analyzer",
            description="Segments, glosses, and links words with a finite-state transducer",
            tasks=[TASKS.LINK_VOCAB],
            summary=SUMMARY,
            parameters=[
                Param.boolean("segment", "Segment into morphemes", default=True,
                              description="Split each word into stem + affix morphemes. "
                                          "Off = lemma-based linking only."),
                Param.boolean("gloss", "Auto-gloss features", default=True,
                              description="Write a gloss (PL, PAR, …) on each affix morpheme."),
                Param.boolean("link", "Link stem to lexicon", default=True,
                              description="Link the stem (or the whole word, when not "
                                          "segmenting) to a lexicon vocab item."),
                Param.string("lang", "Analyzer language code", default="fin",
                             description="Giellatekno code (fin, sme, myv, …). Ignored if a "
                                         "transducer file was set with --fst at launch."),
                Param.enum("tag_format", "Tag format",
                           [("giella", "Giella (lemma+N+Pl)"), ("apertium", "Apertium (lemma<n><pl>)")],
                           default="giella"),
                Param.string("vocab_id", "Lexicon vocab layer id", default="",
                             description="Which linked vocabulary to use as the lexicon. "
                                         "Blank = the project's first."),
                Param.string("gloss_layer", "Gloss span layer name", default="Gloss",
                             description="Name of the morpheme-scoped span layer that holds glosses."),
                Param.boolean("overwrite", "Overwrite human-edited material", default=False,
                              description="Allow replacing analyses/links a human made or confirmed."),
            ],
        )
        # Loaded FSTs cached by (lang, fst_path); analysis is the heavy object.
        self._analyzers: Dict[Tuple[Optional[str], Optional[str]], Analyzer] = {}
        self._default_lang = "fin"
        self._default_fst: Optional[str] = None

    # --- CLI / lifecycle ----------------------------------------------------

    def add_arguments(self, parser: argparse.ArgumentParser) -> None:
        parser.add_argument("--lang", default="fin",
                            help="Default Giellatekno language code (default: fin).")
        parser.add_argument("--fst", default=None,
                            help="Path to a compiled .hfst/.hfstol transducer (overrides --lang).")
        parser.add_argument("--selftest", action="store_true",
                            help="Print analyses for sample words and exit (no server).")

    def setup(self, args) -> None:
        self._default_lang = getattr(args, "lang", "fin")
        self._default_fst = getattr(args, "fst", None)
        # Load the default analyzer eagerly so launch fails fast on a bad model.
        self._get_analyzer(self._default_lang, self._default_fst)

    def _get_analyzer(self, lang: Optional[str], fst_path: Optional[str]) -> Analyzer:
        key = (None if fst_path else (lang or "fin"), fst_path or None)
        if key not in self._analyzers:
            self._analyzers[key] = make_analyzer(lang=lang, fst_path=fst_path)
        return self._analyzers[key]

    def run(self, args=None) -> None:
        # --selftest short-circuits before any client/token bootstrap.
        parsed = self.create_argument_parser().parse_args(args)
        if parsed.selftest:
            self.setup(parsed)
            self._run_selftest(parsed)
            return
        super().run(args)

    def _run_selftest(self, args) -> None:
        analyzer = self._get_analyzer(getattr(args, "lang", "fin"), getattr(args, "fst", None))
        fmt = "apertium" if (getattr(args, "fst", None) and "apertium" in args.fst.lower()) else "giella"
        print(f"\nAnalyzer: {analyzer.describe()}  (tag_format guess: {fmt})\n")
        for w in SELFTEST_WORDS:
            raw = sorted(analyzer.analyze(w), key=lambda r: r[1])
            if not raw:
                print(f"  {w:16} -> (no analysis)")
                continue
            best = raw[0][0]
            parsed = parse_analysis(best, fmt)
            print(f"  {w:16} -> {best}")
            if parsed:
                lemma, pos, feats = parsed
                line = " - ".join([lemma] + [f"-{t}" for t in feats])
                gl = " - ".join([lemma] + [gloss_for(t) for t in feats])
                print(f"  {'':16}    morphs: {line}")
                print(f"  {'':16}    gloss : {gl}   (pos={pos})")
        print()

    # --- request handling ---------------------------------------------------

    def process_request(self, request_data: Dict[str, Any], response_helper) -> None:
        document_id = request_data.get("document_id")
        word_layer_id = request_data.get("word_token_layer_id")
        morpheme_layer_id = request_data.get("morpheme_token_layer_id")
        vocab_ids = request_data.get("vocab_ids") or []

        segment = bool(request_data.get("segment", True))
        do_gloss = bool(request_data.get("gloss", True))
        do_link = bool(request_data.get("link", True))
        lang = request_data.get("lang") or self._default_lang
        tag_format = request_data.get("tag_format", "giella")
        vocab_id = request_data.get("vocab_id") or (vocab_ids[0] if vocab_ids else None)
        gloss_layer_name = request_data.get("gloss_layer", "Gloss")
        overwrite = bool(request_data.get("overwrite", False))

        if not document_id or not word_layer_id:
            response_helper.error("Missing documentId or wordTokenLayerId.")
            return
        if not segment and not do_link:
            response_helper.error("Nothing to do: enable Segment or Link.")
            return
        if do_link and not vocab_id:
            response_helper.error("Linking is on but the project has no lexicon vocab layer. "
                                  "Link a vocabulary to the project, or turn Link off.")
            return

        try:
            analyzer = self._get_analyzer(lang, self._default_fst)
        except Exception as e:
            response_helper.error(f"Could not load the analyzer: {e}")
            return

        response_helper.progress(8, "Fetching document…")
        doc = self.client.documents.get(document_id, include_body=True)

        nav = self._navigate(doc, word_layer_id, morpheme_layer_id, gloss_layer_name)
        if nav.get("error"):
            response_helper.error(nav["error"])
            return
        text_id, body = nav["text_id"], nav["body"]
        words = nav["words"]
        gloss_layer_id = nav["gloss_layer_id"]
        slicer = _cp_slicer(body)

        if segment and not morpheme_layer_id:
            response_helper.error("Segment is on but this document has no morpheme layer.")
            return
        if segment and do_gloss and not gloss_layer_id:
            response_helper.error(f"Segment+gloss is on but no morpheme span layer named "
                                  f"'{gloss_layer_name}' was found.")
            return

        # Lexicon: form -> existing item id (built from the vocab layer's items).
        lexicon: Dict[str, str] = {}
        if do_link:
            response_helper.progress(15, "Loading lexicon…")
            layer = self.client.vocab_layers.get(vocab_id, include_items=True)
            for it in (layer.get("items") or []):
                lexicon.setdefault((it.get("form") or "").casefold(), it["id"])

        response_helper.progress(25, f"Analyzing {len(words)} words with {analyzer.describe()}…")

        plans = []   # per-word write plan
        skipped = 0
        for w in words:
            surface = slicer(w["begin"], w["end"]).strip()
            if not surface:
                continue
            raw = sorted(analyzer.analyze(surface), key=lambda r: r[1])
            if not raw:
                continue
            parsed = parse_analysis(raw[0][0], tag_format)
            if not parsed:
                continue
            eligible = self._eligible(w, segment, overwrite)
            if not eligible:
                skipped += 1
                continue
            plans.append({
                "word": w,
                "lemma": parsed[0],
                "pos": parsed[1],
                "features": parsed[2],
                "analysis": raw[0][0],
                "alternatives": [a for a, _ in raw[1:4]],
            })

        if not plans:
            response_helper.complete({
                "document_id": document_id, "status": "success",
                "words_analyzed": 0, "skipped_protected": skipped,
                "message": "Nothing new to analyze.",
            })
            return

        prov_src = service_source(self.service_id)

        # Everything below mutates: hold the document lock and label the audit log.
        with self.client.documents.locked(document_id):
            with self.client.audit_message(f"FST analysis ({analyzer.describe()})"):
                stats = self._apply(
                    plans=plans, text_id=text_id, prov_src=prov_src,
                    segment=segment, do_gloss=do_gloss, do_link=do_link,
                    morpheme_layer_id=morpheme_layer_id, gloss_layer_id=gloss_layer_id,
                    word_layer_id=word_layer_id, vocab_id=vocab_id, lexicon=lexicon,
                    response_helper=response_helper,
                )

        response_helper.progress(100, "Done.")
        response_helper.complete({
            "document_id": document_id, "status": "success",
            "words_analyzed": len(plans), "skipped_protected": skipped,
            **stats,
        })

    # --- document navigation -----------------------------------------------

    def _navigate(self, doc, word_layer_id, morpheme_layer_id, gloss_layer_name) -> Dict[str, Any]:
        """Pull the pieces the request doesn't hand us straight out of the raw
        include-body document: the text + body, the word tokens, the morpheme
        tokens grouped by word extent, existing gloss spans + vocab links (to
        respect human work), and the gloss span layer id."""
        word_layer = morpheme_layer = gloss_layer = text = None
        for tl in doc.get("text_layers", []):
            for tk in tl.get("token_layers", []):
                if tk.get("id") == word_layer_id:
                    word_layer, text = tk, tl.get("text")
                if tk.get("id") == morpheme_layer_id:
                    morpheme_layer = tk
        if not word_layer or not text:
            return {"error": "Could not locate the word token layer / text in the document."}

        # Gloss span layer: prefer the one named `gloss_layer_name`, else the
        # first morpheme-scoped span layer, else the first span layer present.
        sls = (morpheme_layer or {}).get("span_layers", []) or []
        def _scope(sl):
            return ((sl.get("config") or {}).get("igt") or {}).get("scope")
        gloss_layer = (
            next((sl for sl in sls if sl.get("name") == gloss_layer_name), None)
            or next((sl for sl in sls if _scope(sl) == "Morpheme"), None)
            or (sls[0] if sls else None)
        )
        gloss_layer_id = gloss_layer["id"] if gloss_layer else None

        # Morphemes grouped by parent word via shared (begin,end) extent.
        morphs_by_extent: Dict[Tuple[int, int], List[dict]] = {}
        for m in (morpheme_layer or {}).get("tokens", []):
            morphs_by_extent.setdefault((m["begin"], m["end"]), []).append(m)

        # Existing gloss spans keyed by the (single) token they sit on.
        gloss_by_token: Dict[str, dict] = {}
        for sl in (morpheme_layer or {}).get("span_layers", []):
            for s in sl.get("spans", []):
                toks = s.get("tokens") or []
                if len(toks) == 1:
                    gloss_by_token.setdefault(toks[0], s)

        # Existing single-token vocab links keyed by token id (see derive.js:
        # links live under raw token layers' `vocabs`, not on the vocab layer).
        link_by_token: Dict[str, dict] = {}
        for tl in doc.get("text_layers", []):
            for tk in tl.get("token_layers", []):
                for v in tk.get("vocabs", []) or []:
                    for ln in v.get("vocab_links", []) or []:
                        toks = ln.get("tokens") or []
                        if len(toks) == 1:
                            link_by_token.setdefault(toks[0], ln)

        words = []
        for t in word_layer.get("tokens", []):
            key = (t["begin"], t["end"])
            ms = sorted(morphs_by_extent.get(key, []), key=lambda m: m.get("precedence") or 1)
            words.append({
                "id": t["id"], "begin": t["begin"], "end": t["end"],
                "morphemes": ms,
                "gloss_by_token": gloss_by_token,
                "link_by_token": link_by_token,
            })
        return {
            "text_id": text["id"], "body": text.get("body") or "",
            "words": words, "gloss_layer_id": gloss_layer_id,
        }

    def _eligible(self, w, segment, overwrite) -> bool:
        """Honor the provenance write contract. Eligible = the word carries no
        *human* analysis we'd clobber. A content-free bare morpheme (the freshly
        "healed" default) is NOT analysis, so it stays eligible; a human gloss,
        a human/confirmed link, or a real human split makes it protected."""
        if overwrite:
            return True
        morphs = w["morphemes"]
        gbt, lbt = w["gloss_by_token"], w["link_by_token"]

        # Protected vocab link on the word or any of its morphemes?
        for tid in [w["id"]] + [m["id"] for m in morphs]:
            ln = lbt.get(tid)
            if ln and prov_state(ln.get("metadata")) != MACHINE:
                return False
        if not segment:
            return True  # link-only: only the link state above matters.

        # Protected gloss on any morpheme?
        for m in morphs:
            sp = gbt.get(m["id"])
            if sp and prov_state(sp.get("metadata")) != MACHINE:
                return False
        # A real human segmentation (a person split the word) is protected; a
        # single bare default morpheme is not.
        human_morphs = [m for m in morphs if prov_state(m.get("metadata")) != MACHINE]
        if len(human_morphs) > 1:
            return False
        return True

    # --- writes -------------------------------------------------------------

    def _apply(self, *, plans, text_id, prov_src, segment, do_gloss, do_link,
               morpheme_layer_id, gloss_layer_id, word_layer_id, vocab_id,
               lexicon, response_helper) -> Dict[str, int]:
        client = self.client
        stats = {"morphemes_created": 0, "glosses_created": 0,
                 "links_created": 0, "lexicon_items_created": 0, "removed": 0}

        def meta(extra=None, analysis=None, alts=None):
            detail = {}
            if analysis:
                detail["analysis"] = analysis
            if alts:
                detail["alternatives"] = alts
            m = stamp_inferred(prov_src, detail=detail or None)
            if extra:
                m.update(extra)
            return m

        # 1) Clear prior (eligible) analysis we're about to replace.
        response_helper.progress(45, "Clearing prior machine analysis…")
        span_dels, link_dels, tok_dels = [], [], []
        for p in plans:
            w = p["word"]
            gbt, lbt = w["gloss_by_token"], w["link_by_token"]
            targets = [w["id"]] + [m["id"] for m in w["morphemes"]]
            for tid in targets:
                if tid in lbt:
                    link_dels.append(lbt[tid]["id"])
            if segment:
                for m in w["morphemes"]:
                    if m["id"] in gbt:
                        span_dels.append(gbt[m["id"]]["id"])
                    tok_dels.append(m["id"])
        # spans/links first, then the morpheme tokens they sat on.
        if span_dels:
            client.spans.bulk_delete(_uniq(span_dels))
        if link_dels:
            client.vocab_links.bulk_delete(_uniq(link_dels))
        if tok_dels:
            client.tokens.bulk_delete(_uniq(tok_dels))
        stats["removed"] = len(set(span_dels)) + len(set(link_dels)) + len(set(tok_dels))

        # 2) Find-or-create lexicon items for the lemmas we'll link.
        if do_link:
            response_helper.progress(60, "Reconciling lexicon…")
            for p in plans:
                fold = p["lemma"].casefold()
                if fold in lexicon:
                    continue
                item_meta = {}
                if p["pos"]:
                    item_meta["pos"] = p["pos"]
                created = client.vocab_items.create(
                    vocab_id, p["lemma"], metadata=meta(item_meta))
                lexicon[fold] = _id_of(created)
                stats["lexicon_items_created"] += 1

        # 3) Create morphemes (need their ids before glosses/links reference them).
        morph_ids_by_word: Dict[str, List[str]] = {}
        if segment:
            response_helper.progress(72, "Creating morphemes…")
            morph_body, owners = [], []   # owners[i] = (word_id, precedence, is_stem)
            for p in plans:
                w = p["word"]
                pieces = [(p["lemma"], "stem")] + [("-" + t, "suffix") for t in p["features"]]
                for prec, (form, mtype) in enumerate(pieces, start=1):
                    morph_body.append({
                        "token_layer_id": morpheme_layer_id, "text": text_id,
                        "begin": w["begin"], "end": w["end"], "precedence": prec,
                        "metadata": meta({"form": form, "morphType": mtype}),
                    })
                    owners.append((w["id"], prec == 1))
            # The bulk endpoint returns {"ids": [...]} in input order.
            created = client.tokens.bulk_create(morph_body) if morph_body else {"ids": []}
            new_ids = created.get("ids", []) if isinstance(created, dict) else [_id_of(x) for x in created]
            stats["morphemes_created"] = len(new_ids)
            for (word_id, _is_stem), mid in zip(owners, new_ids):
                morph_ids_by_word.setdefault(word_id, []).append(mid)

        # 4) Glosses + links (phase two — reference the ids minted above).
        response_helper.progress(85, "Writing glosses and links…")
        span_body, link_body = [], []
        for p in plans:
            w = p["word"]
            lemma, feats = p["lemma"], p["features"]
            link_target = None
            if segment:
                mids = morph_ids_by_word.get(w["id"], [])
                if do_gloss and gloss_layer_id and mids:
                    glosses = [lemma] + [gloss_for(t) for t in feats]
                    for mid, g in zip(mids, glosses):
                        span_body.append({
                            "span_layer_id": gloss_layer_id, "tokens": [mid],
                            "value": g,
                            "metadata": meta(analysis=p["analysis"]),
                        })
                if mids:
                    link_target = mids[0]   # the stem
            else:
                link_target = w["id"]       # link-only: the whole word

            if do_link and link_target:
                item_id = lexicon.get(lemma.casefold())
                if item_id:
                    link_body.append({
                        "vocab_item": item_id, "tokens": [link_target],
                        "metadata": meta(analysis=p["analysis"], alts=p["alternatives"]),
                    })
        if span_body:
            client.spans.bulk_create(span_body)
            stats["glosses_created"] = len(span_body)
        if link_body:
            client.vocab_links.bulk_create(link_body)
            stats["links_created"] = len(link_body)
        return stats


# ===========================================================================
# Helpers
# ===========================================================================

def _cp_slicer(body: str):
    """Code-point-correct slicer (offsets are Unicode code points). Python str is
    code-point native, so a plain slice is already correct."""
    return lambda begin, end: body[begin:end]


def _id_of(x: Any) -> str:
    """Pull an id out of a create/bulk-create result, tolerant of shape
    (``{'id'}`` / ``{'body': {'id'}}`` / bare id)."""
    if isinstance(x, str):
        return x
    if isinstance(x, dict):
        if "id" in x:
            return x["id"]
        if isinstance(x.get("body"), dict) and "id" in x["body"]:
            return x["body"]["id"]
    raise ValueError(f"Could not read an id from result: {x!r}")


def _uniq(seq: List[str]) -> List[str]:
    seen, out = set(), []
    for x in seq:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def main():
    FstLinkerService().run()


if __name__ == "__main__":
    main()
