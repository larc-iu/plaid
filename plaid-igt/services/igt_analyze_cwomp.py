"""
CWoMP analysis service

Proposes a morpheme segmentation and morpheme glosses for the words of a
document with CWoMP (Alper, Rice, Shandilya, Palmer and Levin, EMNLP 2026,
https://cwomp.github.io), trained on the project's own analyses. Serves the
`analyze` task.

The method: a dual encoder (LaBSE, trained contrastively) puts each word in
its sentence and each (form, gloss) morpheme of a lexicon in one space, and a
small decoder spells a word's analysis by picking lexicon entries one at a
time. It never invents a morpheme: everything it writes is an entry it was
trained on or one the project has confirmed since, which a run adds to the
lexicon without retraining (the paper's mutable lexicon).

Two commands:

  python igt_analyze_cwomp.py train PROJECT_ID --url URL
      Reads every sentence of the project whose words a person analyzed or
      verified completely, holds out about a tenth, trains CWoMP's encoder and
      decoder with its own scripts (the paper's settings), and fits one
      temperature on the held-out sentences so that the probabilities it
      writes are calibrated. The model goes under --home/PROJECT_ID.

  python igt_analyze_cwomp.py [PROJECT_ID ...] --url URL
      Serves the analyze task on those projects, each with its own model.
      A project with no model refuses with a message saying how to train one.

What it writes is what every analyze service writes (the morpheme chain, a
gloss span per morpheme, all stamped machine-made), through
`plaid_client.workflows.igt.write_analyses`, plus `provProb` on each morpheme
and its gloss: the decoder's calibrated probability for that entry given the
ones before it. A model whose held-out data was too small to calibrate writes
no `provProb`. The write contract is PolyGloss's, see that service.

It also links each morpheme it writes to the vocab item people linked that
entry to, when they always linked it to the same one (`Confirmed`). An entry
is a form with its gloss, so the link names the sense, where the built-in link
step can only go by the form. Entries people never linked, or linked to
different items, get no link, and Auto-analyze's link step handles them.
It never creates an item.

Beyond the paper: CWoMP's code reads `=` as `-` and drops it, so clitics lose
their side. Here a clitic's form carries a mark the code does not split on
(U+207C) in training and in the lexicon, so a proclitic, an enclitic and an
affix of the same form are different entries, and the boundary comes back as
`=` with the clitic's type.

CWoMP's code is not part of Plaid (its repository has no license yet). Clone
it at the pinned commit, make its environment, and run this file with that
environment's Python, with plaid-client installed into it:

  git clone https://github.com/morrisalp/CWoMP.git ~/.cache/plaid/cwomp/repo
  cd ~/.cache/plaid/cwomp/repo && git checkout f095281 && uv sync
  uv pip install --python .venv/bin/python -e <plaid>/plaid-client-py
  .venv/bin/python <plaid>/plaid-igt/services/igt_analyze_cwomp.py ...

A GPU is assumed for training. Analysis runs on a CPU too, more slowly.
"""

import argparse
import csv
import datetime as dt
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from plaid_client import BaseService, TASKS, Param, service_source
from plaid_client.provenance import (
    prov_state, read_confidence_threshold, HUMAN, PROV_SOURCE_KEY, VERIFIED)
from plaid_client.roles import ROLES, find_by_role
from plaid_client.service import PhasedProgress, held_run
from plaid_client.workflows.requester import requester_of
from plaid_client.workflows.igt import (
    derive, field_layer_id, select_targets, write_analyses, analysis_result, ANALYZE_REQUEST_FIELDS,
    read_skip_word_ids, project_entry_types, morph_type, gloss_of,
)
from plaid_client.workflows.igt.glossing import is_clitic

CWOMP_COMMIT = 'f095281'
DEFAULT_HOME = Path.home() / '.cache' / 'plaid' / 'cwomp'
LANGUAGE = 'Project'  # the language name CWoMP's scripts are run with
LANGUAGE_CODE = 'prj'
DEV_SHARE = 0.1
MIN_SENTENCES = 10
# Below this many held-out decisions one temperature is noise, and the model
# writes no probabilities rather than uncalibrated ones.
MIN_CALIBRATION_STEPS = 50
# The paper's settings (appendix A.1): encoder batch 128, decoder batch 32,
# 100 epochs each, 1000 for a corpus as small as Gitksan's 31 sentences.
TINY_CORPUS = 100
LEXICON_REFRESH_S = 15 * 60
MIN_ALTERNATIVE_PROB = 0.01

# Characters CWoMP's code splits a word on, and what they become inside a
# form or gloss so that they stay one piece. A clitic's form carries CLITIC on
# the side of its host.
CLITIC = '\u207c'  # superscript equals
INNER = {'-': '\u2010', '=': '\u2e40', ' ': '\u2423'}
OUTER = {v: k for k, v in INNER.items()}

SUMMARY = """\
**CWoMP** (Alper et al. 2026) proposes a morpheme **segmentation** and
**glosses** for every word, by picking entries from a lexicon of morphemes
learned from this project's own analyses. It never proposes a morpheme the
project has not used, and every morpheme it writes carries its confidence.
A morpheme whose form and gloss people always linked to one lexicon entry is
linked to it.
Morphemes confirmed after training are used without retraining.

- **Gloss field**: the morpheme-scope field that receives the glosses.
- **Translation field**: the sentence-scope field holding the free translation.
- **Overwrite human-edited annotations**: by default the service only writes
  words that have no analysis yet or whose analysis is entirely machine-made
  and unverified, other than one copied from a previous analysis.

The model is trained on the service's machine. Everything it writes is stamped
machine-made and shows as unverified until a person confirms it.
"""


# --- the lexicon's spelling ----------------------------------------------------

# Any other whitespace (a no-break or thin space, a tab) goes to a private-use
# character of its own, which str.split() leaves alone and decoding reverses.
SPACE_BASE = 0xF0000


def encode_piece(s: str) -> str:
    """A form or gloss as one unit CWoMP's code will not split."""
    return ''.join(INNER.get(c) or (chr(SPACE_BASE + ord(c)) if c.isspace() else c) for c in s)


def decode_piece(s: str) -> str:
    return ''.join(OUTER.get(c) or (chr(ord(c) - SPACE_BASE) if SPACE_BASE <= ord(c) < SPACE_BASE + 0x10000
                                    else c) for c in s)


def encode_form(form: str, morph_type: Optional[str]) -> str:
    """A morpheme's form as a lexicon entry: a proclitic marked after, an
    enclitic before, anything else as it is."""
    f = encode_piece(form)
    t = (morph_type or '').lower()
    if is_clitic(t) and 'pro' in t:
        return f + CLITIC
    if is_clitic(t):
        return CLITIC + f
    return f


def decode_form(entry_form: str) -> Tuple[str, Optional[str]]:
    """-> (form, morph type or None)."""
    if entry_form.endswith(CLITIC) and len(entry_form) > 1:
        return decode_piece(entry_form[:-1]), 'proclitic'
    if entry_form.startswith(CLITIC) and len(entry_form) > 1:
        return decode_piece(entry_form[1:]), 'enclitic'
    return decode_piece(entry_form), None


def joiners_for(types: List[Optional[str]]) -> List[str]:
    return ['=' if types[i] == 'proclitic' or types[i + 1] == 'enclitic' else '-'
            for i in range(len(types) - 1)]


# --- reading a project's analyses ---------------------------------------------

def igt_layers(project) -> Tuple[str, str, str]:
    """The project's (word, morpheme, sentence) token layer ids."""
    for tl in project.get('text_layers') or []:
        tls = tl.get('token_layers') or []
        w, m, s = (find_by_role(tls, r) for r in (ROLES.WORD, ROLES.MORPHEME, ROLES.SENTENCE))
        if w and m and s:
            return w['id'], m['id'], s['id']
    raise ValueError('This project has no IGT word, morpheme and sentence layers.')


def trusted_analysis(w, gloss_layer_id, entry_types=None) -> Optional[List[Tuple[str, str]]]:
    """A word's morphemes as lexicon entries [(form, gloss)] when a person made
    or verified every piece of its analysis and every morpheme has a gloss,
    else None. A word nobody segmented counts when its one morpheme has a
    person's gloss: the word is then its own form. `entry_types` is
    `project_entry_types`, for the type a linked morpheme goes by."""
    out = []
    for m in w['morphs']:
        meta = m.get('metadata') or {}
        if not m.get('virtual') and prov_state(meta) not in (HUMAN, VERIFIED):
            return None
        sp = gloss_of(w, m, gloss_layer_id)
        if sp is None or prov_state(sp.get('metadata')) not in (HUMAN, VERIFIED):
            return None
        form = meta.get('form') or w['surface']
        out.append((encode_form(form, morph_type(w, m, entry_types)),
                    encode_piece(sp['value'].strip())))
    return out or None


def person_link(w, m, own_source=None) -> Optional[str]:
    """The vocab item a person linked morpheme `m` to, or None (no link, a
    machine's or a contributor's unreviewed link, or links to two items).
    A confirmed link this service proposed does not count: a person
    confirming a whole word confirms it unread, and counting it would let
    the service's own guesses vote for themselves."""
    items = set()
    for link in w['morph_links'].get(m['id'], []):
        meta = link.get('metadata') or {}
        state = prov_state(meta)
        if state == HUMAN or (state == VERIFIED and meta.get(PROV_SOURCE_KEY) != own_source):
            v = link.get('vocab_item')
            items.add(v.get('id') if isinstance(v, dict) else v)
    items.discard(None)
    return items.pop() if len(items) == 1 else None


class Confirmed:
    """What the project's people have confirmed: every (form, gloss) entry
    of a trusted analysis, and the vocab items they linked each entry's
    morphemes to. A morpheme CWoMP picks is one of these entries, so when
    people always linked it to one item, that item is the link to propose:
    the entry already names the sense, which a link by form alone cannot."""

    def __init__(self, own_source=None, entry_types=None):
        self.own_source = own_source
        #: project_entry_types, for the type a linked morpheme goes by.
        self.entry_types = entry_types or {}
        self.entries = set()
        self.links: Dict[Tuple[str, str], Counter] = {}

    def add_word(self, w, gloss_layer_id) -> None:
        a = trusted_analysis(w, gloss_layer_id, self.entry_types)
        if not a:
            return
        self.entries.update(a)
        for m, entry in zip(w['morphs'], a):
            item = person_link(w, m, self.own_source)
            if item:
                self.links.setdefault(entry, Counter())[item] += 1

    def merged(self, other: 'Confirmed') -> 'Confirmed':
        out = Confirmed(self.own_source, self.entry_types)
        out.entries = self.entries | other.entries
        for src in (self.links, other.links):
            for entry, c in src.items():
                out.links.setdefault(entry, Counter()).update(c)
        return out

    def keep_items(self, live: set) -> None:
        """Forget links to items that no longer exist."""
        for entry, c in list(self.links.items()):
            kept = Counter({i: n for i, n in c.items() if i in live})
            if kept:
                self.links[entry] = kept
            else:
                del self.links[entry]

    def link_for(self, entry) -> Optional[str]:
        """The one item people linked this entry to, or None when they never
        linked it or linked it to different items."""
        c = self.links.get(entry)
        return next(iter(c)) if c and len(c) == 1 else None


def sentence_record(s, gloss_layer_id, entry_types=None) -> Optional[dict]:
    """A sentence as CWoMP training data, when every word is trusted."""
    if not s['words']:
        return None
    words, segs, glosses = [], [], []
    for w in s['words']:
        a = trusted_analysis(w, gloss_layer_id, entry_types)
        if a is None:
            return None
        words.append(encode_piece(w['surface']))
        segs.append('-'.join(f for f, _ in a))
        glosses.append('-'.join(g for _, g in a))
    return {'id': s['id'], 't': ' '.join(words), 'm': ' '.join(segs), 'g': ' '.join(glosses),
            'l': ' '.join((s['translation'] or '').split())}


def is_dev(sentence_id: str) -> bool:
    h = int(hashlib.sha256(sentence_id.encode()).hexdigest()[:8], 16)
    return h / 0xFFFFFFFF < DEV_SHARE


def read_project(client, project_id, gloss_field, translation_field, log=print, own_source=None):
    """-> (training records, Confirmed) over every document. `own_source` is
    the service's provSource, whose links Confirmed leaves out."""
    project = client.projects.get(project_id)
    layers = igt_layers(project)
    entry_types = project_entry_types(client, project)
    records, confirmed = [], Confirmed(own_source, entry_types)
    docs = client.projects.list_documents(project_id) or []
    for n, d in enumerate(docs):
        log(f'Reading document {n + 1} of {len(docs)}: {d.get("name") or d["id"]}')
        doc = client.documents.get(d['id'], include_body=True)
        sentences, gloss_layer_id = derive(doc, *layers, gloss_field=gloss_field,
                                           translation_field=translation_field)
        for s in sentences:
            for w in s['words']:
                confirmed.add_word(w, gloss_layer_id)
            r = sentence_record(s, gloss_layer_id, entry_types)
            if r:
                records.append(r)
    return records, confirmed


def write_split(path: Path, records: List[dict]) -> None:
    """SIGMORPHON 2023 lines, which CWoMP's DataFile reads."""
    chunks = []
    for r in records:
        lines = [f'\\t {r["t"]}', f'\\m {r["m"]}', f'\\g {r["g"]}']
        if r['l']:
            lines.append(f'\\l {r["l"]}')
        chunks.append('\n'.join(lines))
    path.write_text('\n\n'.join(chunks) + '\n', encoding='utf-8')


# --- the model -----------------------------------------------------------------

def cwomp_src(repo: Path) -> Path:
    src = repo / 'src'
    if not (src / 'models' / 'pointer.py').exists():
        raise SystemExit(f'No CWoMP checkout at {repo}. See the top of this file for how to make one.')
    if str(src) not in sys.path:
        sys.path.insert(0, str(src))
    return src


class CwompModel:
    """One project's trained CWoMP: its encoder, its decoder, the lexicon it
    was trained on, and the temperature that calibrates it."""

    def __init__(self, model_dir: Path, repo: Path, device=None):
        self.dir = model_dir
        self.manifest = json.loads((model_dir / 'model.json').read_text())
        self.repo = repo
        self.device_name = device
        self.loaded_mtime = (model_dir / 'model.json').stat().st_mtime
        cwomp_src(repo)
        import torch
        from sentence_transformers import SentenceTransformer
        from models.pointer import PointerNetwork
        self.torch = torch
        self.device = torch.device(device or ('cuda' if torch.cuda.is_available() else 'cpu'))
        settings = self.manifest['settings']
        self.use_spaces = settings['use_spaces']
        self.use_transcript = settings['use_transcript']
        self.use_translation = settings['use_translation']
        self.encoder = SentenceTransformer(str(model_dir / self.manifest['encoder']), device=str(self.device))
        self.encoder.eval()
        ckpt = torch.load(model_dir / self.manifest['decoder'], map_location=self.device)
        self.decoder = PointerNetwork(
            embedding_dim=ckpt['embedding_dim'], vocab_size=ckpt.get('vocab_size', 0),
            num_blocks=ckpt.get('num_blocks', ckpt.get('num_decoder_blocks', 2)),
            num_heads=ckpt['num_heads'], dim_feedforward=ckpt['dim_feedforward'],
            dropout=ckpt['dropout']).to(self.device)
        self.decoder.load_state_dict(ckpt['model_state_dict'])
        self.decoder.eval()
        with torch.no_grad():
            self.bos = self.encoder.encode('[BOS]', convert_to_tensor=True, show_progress_bar=False)
            self.eos = self.encoder.encode('[EOS]', convert_to_tensor=True, show_progress_bar=False)
        self.temperature = self.manifest.get('temperature')  # None: not calibrated
        self.trained = read_lexicon(model_dir / 'lexicon.csv')
        self._embedded: Dict[Tuple[str, str], object] = {}
        self.lexicon: List[Tuple[str, str]] = []
        self.vocab = None
        self.set_lexicon(set(self.trained))

    def describe(self) -> dict:
        return {'model': f'cwomp@{CWOMP_COMMIT}', 'trainedAt': self.manifest['trained_at']}

    def passage(self, entry: Tuple[str, str]) -> str:
        from retrieval_utils import format_passage
        return format_passage({'morpheme': entry[0], 'gloss': entry[1]}, self.use_spaces)

    def query(self, word: str, transcript: str, translation: str) -> str:
        from retrieval_utils import format_query
        return format_query(word, transcript, translation, self.use_translation,
                            self.use_transcript, self.use_spaces)

    def set_lexicon(self, entries) -> None:
        """The entries the decoder picks from: the trained lexicon plus whatever
        the project has confirmed since. New entries are embedded once."""
        torch = self.torch
        lexicon = sorted(set(entries) | set(self.trained))
        new = [e for e in lexicon if e not in self._embedded]
        if new:
            with torch.no_grad():
                embs = self.encoder.encode([self.passage(e) for e in new], convert_to_tensor=True,
                                           batch_size=64, show_progress_bar=False)
            for e, v in zip(new, embs):
                self._embedded[e] = v
        self.lexicon = lexicon
        self.same_form: Dict[str, List[int]] = {}
        for i, (form, _) in enumerate(lexicon):
            self.same_form.setdefault(form, []).append(i)
        self.vocab = torch.cat([torch.stack([self._embedded[e] for e in lexicon]),
                                self.eos.unsqueeze(0)]).to(self.device)

    def encode_queries(self, queries: List[str]):
        with self.torch.no_grad():
            return self.encoder.encode(queries, convert_to_tensor=True, batch_size=32,
                                       show_progress_bar=False)

    def step_logits(self, query_emb, indices: List[int]):
        """The decoder's logits after BOS and each of `indices`, teacher-forced:
        (len(indices) + 1, vocab)."""
        torch = self.torch
        ar = torch.stack([self.bos] + [self.vocab[i] for i in indices]).unsqueeze(0)
        with torch.no_grad():
            return self.decoder(ar, query_emb.unsqueeze(0), self.vocab)[0]

    def analyze(self, query_emb, max_length=20, num_beams=5):
        """-> [(form entry, gloss entry, probability or None)] for the best beam."""
        return [(d['form'], d['gloss'], d['prob'])
                for d in self.analyze_full(query_emb, max_length, num_beams)]

    def analyze_full(self, query_emb, max_length=20, num_beams=5, max_alternatives=5):
        """-> [{form, gloss, prob, alternatives}] for the best beam, where
        `alternatives` is {gloss entry: probability} over the entries of the
        same form at that step (the chosen one included, at most
        `max_alternatives`), empty when uncalibrated or when no other entry
        shares the form."""
        torch = self.torch
        eos_idx = len(self.lexicon)
        with torch.no_grad():
            beams = self.decoder.generate(vocab_embeddings=self.vocab, word_embedding=query_emb.unsqueeze(0),
                                          bos_embedding=self.bos, eos_idx=eos_idx,
                                          max_length=max_length, num_beams=num_beams)
        best = max(beams, key=lambda b: b[1])[0]
        chosen = [i for i in best if i != eos_idx]
        if not chosen:
            return []
        out = [{'form': self.lexicon[i][0], 'gloss': self.lexicon[i][1], 'prob': None,
                'form_prob': None, 'alternatives': {}} for i in chosen]
        if self.temperature:
            logits = self.step_logits(query_emb, chosen)[:len(chosen)] / self.temperature
            p = torch.softmax(logits, dim=-1)
            for k, i in enumerate(chosen):
                out[k]['prob'] = float(p[k, i])
                same = self.same_form.get(self.lexicon[i][0], [])
                # The form is right whichever of its entries is: their sum.
                out[k]['form_prob'] = min(1.0, float(sum(p[k, j] for j in same))) if same else out[k]['prob']
                if len(same) > 1:
                    ranked = sorted(same, key=lambda j: -float(p[k, j]))[:max_alternatives]
                    out[k]['alternatives'] = {self.lexicon[j][1]: float(p[k, j]) for j in ranked}
        return out


def alternatives_detail(picked: dict, confirmed: 'Confirmed') -> Optional[dict]:
    """What a gloss span records of the alternatives the model weighed: the
    convention's `valueProbs` (shown in igt's Alt+Down list), and
    `valueLinks`, one {value, item, prob} per alternative a person linked
    to an item, so that picking one moves the morpheme's link along with
    it."""
    # An alternative under 1% is noise in a list a person reads ("model 0%").
    alts = {g: p for g, p in picked['alternatives'].items()
            if p >= MIN_ALTERNATIVE_PROB or g == picked['gloss']}
    if len(alts) < 2:
        return None
    detail = {'valueProbs': {decode_piece(g): round(p, 4) for g, p in alts.items()}}
    links = [{'value': decode_piece(g), 'item': confirmed.link_for((picked['form'], g)), 'prob': round(p, 4)}
             for g, p in alts.items()]
    links = [x for x in links if x['item']]
    if links:
        detail['valueLinks'] = links
    return detail


def read_lexicon(path: Path) -> List[Tuple[str, str]]:
    with open(path, encoding='utf-8') as f:
        return [(r['morpheme'], r['gloss']) for r in csv.DictReader(f)]


# --- training ------------------------------------------------------------------

def run_step(python, script, overrides, cwd, log):
    cmd = [python, f'src/{script}', *overrides]
    log('$ ' + ' '.join(cmd))
    # Their scripts import each other from src/, which a PYTHONSAFEPATH
    # shell leaves off the path.
    env = {**os.environ, 'PYTHONPATH': str(Path(cwd) / 'src')}
    proc = subprocess.run(cmd, cwd=cwd, env=env)
    if proc.returncode != 0:
        raise SystemExit(f'{script} failed (exit {proc.returncode}).')


def calibrate(model: CwompModel, dev_records: List[dict], log) -> dict:
    """Fit one temperature on the held-out sentences' gold analyses (the
    decoder's own lexicon only, as trained), and measure how well the
    probabilities of its predicted analyses match how often they are right,
    before and after."""
    torch = model.torch
    index = {e: i for i, e in enumerate(model.lexicon)}
    eos_idx = len(model.lexicon)
    items = []
    for r in dev_records:
        for word, seg, gloss in zip(r['t'].split(), r['m'].split(), r['g'].split()):
            gold = list(zip(seg.split('-'), gloss.split('-')))
            if all(g in index for g in gold):
                items.append((model.query(word, r['t'], r['l']), [index[g] for g in gold]))
    steps = sum(len(g) + 1 for _, g in items)
    if steps < MIN_CALIBRATION_STEPS:
        log(f'Only {steps} held-out decisions: too few to calibrate, so the model writes no probabilities.')
        return {'temperature': None, 'held_out_words': len(items), 'held_out_steps': steps}
    embs = model.encode_queries([q for q, _ in items])
    rows, targets = [], []
    for emb, gold in zip(embs, items):
        logits = model.step_logits(emb, gold[1])
        rows.append(logits.float().cpu())
        targets.extend(gold[1] + [eos_idx])
    logits = torch.cat(rows)
    target = torch.tensor(targets)
    log_t = torch.zeros(1, requires_grad=True)
    opt = torch.optim.LBFGS([log_t], lr=0.1, max_iter=200)

    def nll():
        opt.zero_grad()
        loss = torch.nn.functional.cross_entropy(logits / log_t.exp(), target)
        loss.backward()
        return loss
    before = float(torch.nn.functional.cross_entropy(logits, target))
    opt.step(nll)
    temperature = float(log_t.exp())
    after = float(torch.nn.functional.cross_entropy(logits / temperature, target))

    # How the probabilities of PREDICTED morphemes match their accuracy.
    def ece(temp):
        conf, right = [], []
        for emb, (_, gold) in zip(embs, items):
            best = max(model.decoder.generate(
                vocab_embeddings=model.vocab, word_embedding=emb.unsqueeze(0), bos_embedding=model.bos,
                eos_idx=eos_idx, max_length=20, num_beams=5), key=lambda b: b[1])[0]
            chosen = [i for i in best if i != eos_idx]
            if not chosen:
                continue
            p = torch.softmax(model.step_logits(emb, chosen)[:len(chosen)].float() / temp, dim=-1)
            for k, i in enumerate(chosen):
                conf.append(float(p[k, i]))
                right.append(chosen[:k + 1] == gold[:k + 1])
        bins = [[] for _ in range(10)]
        for c, ok in zip(conf, right):
            bins[min(int(c * 10), 9)].append((c, ok))
        total = len(conf) or 1
        return (sum(abs(sum(c for c, _ in b) / len(b) - sum(ok for _, ok in b) / len(b)) * len(b)
                    for b in bins if b) / total,
                sum(right) / total)
    ece_before, accuracy = ece(1.0)
    ece_after, _ = ece(temperature)
    log(f'Temperature {temperature:.3f}: held-out NLL {before:.3f} -> {after:.3f}, '
        f'calibration error {ece_before:.3f} -> {ece_after:.3f}, morpheme accuracy {accuracy:.3f}')
    return {'temperature': temperature, 'held_out_words': len(items), 'held_out_steps': steps,
            'nll_before': before, 'nll_after': after, 'ece_before': ece_before,
            'ece_after': ece_after, 'morpheme_accuracy': accuracy}


def edit_distance(a, b) -> int:
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def held_out_scores(model: CwompModel, dev_records: List[dict]) -> dict:
    """The paper's morpheme error rate on the held-out sentences, every word
    counted (a word whose morphemes the lexicon lacks included): per sentence,
    the edit distance between the predicted and the gold glosses as units,
    over the gold count, clipped at 1, averaged over sentences. With the
    trained lexicon only, the paper's train-lexicon setting."""
    mers, words, right = [], 0, 0
    for r in dev_records:
        tw, sw, gw = r['t'].split(), r['m'].split(), r['g'].split()
        embs = model.encode_queries([model.query(w, r['t'], r['l']) for w in tw])
        pred, gold = [], []
        for emb, seg, gloss in zip(embs, sw, gw):
            picked = model.analyze(emb)
            p = [(f, g) for f, g, _ in picked]
            t = list(zip(seg.split('-'), gloss.split('-')))
            words += 1
            right += p == t
            pred += [g for _, g in p]
            gold += [g for _, g in t]
        if gold:
            mers.append(min(1.0, edit_distance(pred, gold) / len(gold)))
    return {'mer': sum(mers) / len(mers) if mers else None,
            'word_accuracy': right / words if words else None}


def train(args) -> None:
    home = Path(args.home)
    repo = Path(args.repo) if args.repo else home / 'repo'
    cwomp_src(repo)
    client = BaseService.get_client(args.url)
    project = client.projects.get(args.project_id)
    model_dir = home / project['id']
    print(f'Reading "{project.get("name")}"...')
    records, _ = read_project(client, project['id'], args.gloss_field, args.translation_field)
    dev = [r for r in records if is_dev(r['id'])]
    trn = [r for r in records if not is_dev(r['id'])]
    if not dev and len(trn) > 1:
        dev = [trn.pop()]
    if len(records) < MIN_SENTENCES:
        raise SystemExit(f'Only {len(records)} sentences are analyzed by a person in every word; '
                         f'CWoMP needs at least {MIN_SENTENCES}.')
    print(f'{len(trn)} sentences to train on, {len(dev)} held out.')

    work = model_dir / 'work'
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    shutil.copytree(repo / 'src', work / 'src')
    shutil.copytree(repo / 'config', work / 'config')
    (work / 'config' / 'languages.json').write_text(
        json.dumps({'language_codes': {LANGUAGE: LANGUAGE_CODE}}), encoding='utf-8')
    data = work / 'data' / 'new_languages' / LANGUAGE / 'parsed'
    data.mkdir(parents=True)
    write_split(data / f'{LANGUAGE_CODE}-train', trn)
    write_split(data / f'{LANGUAGE_CODE}-dev', dev)

    epochs = args.epochs or (1000 if len(trn) < TINY_CORPUS else 100)
    python = sys.executable
    run_step(python, 'make_lexicons.py', [f'language={LANGUAGE}'], work, print)
    run_step(python, 'train_retrieval.py', [
        f'language={LANGUAGE}', 'batch_size=128', f'num_epochs={epochs}', 'learning_rate=2e-5',
        'warmup_steps=100'], work, print)
    retrieval = work / 'outputs' / 'retrieval' / f'retrieval_{LANGUAGE}'
    encoder = retrieval if (retrieval / 'modules.json').exists() else retrieval / 'final_model'
    run_step(python, 'train_pointer.py', [
        f'language={LANGUAGE}', f'retrieval_model_path={encoder}', 'batch_size=32',
        f'num_epochs={epochs}', 'learning_rate=1e-4'], work, print)
    decoder = work / 'outputs' / 'retrieval' / f'pointer_{LANGUAGE}' / 'best_model.pt'

    # The model directory keeps what serving needs and nothing of the run.
    staged = model_dir / 'staged'
    if staged.exists():
        shutil.rmtree(staged)
    staged.mkdir()
    shutil.copytree(encoder, staged / 'encoder', ignore=shutil.ignore_patterns('checkpoints', 'runs', 'eval'))
    shutil.copy(decoder, staged / 'decoder.pt')
    shutil.copy(work / 'outputs' / 'lexicons' / LANGUAGE / 'morpheme_lexicon_train.csv', staged / 'lexicon.csv')
    manifest = {
        'project_id': project['id'], 'cwomp_commit': CWOMP_COMMIT,
        'trained_at': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'encoder': 'encoder', 'decoder': 'decoder.pt',
        'sentences': {'train': len(trn), 'held_out': len(dev)}, 'epochs': epochs,
        'gloss_field': args.gloss_field, 'translation_field': args.translation_field,
        'settings': {'use_spaces': True, 'use_transcript': True, 'use_translation': True},
    }
    (staged / 'model.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    model = CwompModel(staged, repo, device=args.device)
    manifest['calibration'] = calibrate(model, dev, print)
    manifest['temperature'] = manifest['calibration']['temperature']
    manifest['held_out'] = held_out_scores(model, dev)
    print(f'Held out: morpheme error rate {manifest["held_out"]["mer"]:.3f}, '
          f'word accuracy {manifest["held_out"]["word_accuracy"]:.3f}')
    (staged / 'model.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    # Swap in whole, so a running service never loads half a model.
    current = model_dir / 'current'
    old = model_dir / 'old'
    if old.exists():
        shutil.rmtree(old)
    if current.exists():
        current.rename(old)
    staged.rename(current)
    if old.exists():
        shutil.rmtree(old)
    if not args.keep_work:
        shutil.rmtree(work)
    print(f'Model ready in {current}.')


# --- the service ---------------------------------------------------------------

class AnalyzeProgress(PhasedProgress):
    """The bar's stretches for the model's pass over the words and the write."""

    ANALYZE, WRITE = (25, 85), (88, 99)


class CwompService(BaseService):
    def __init__(self):
        super().__init__(
            service_id='cwomp-analyzer',
            service_name='CWoMP',
            description='Proposes morpheme segmentation and glosses from a lexicon learned from this project',
            tasks=[TASKS.ANALYZE],
            summary=SUMMARY,
            extras={'request_fields': ANALYZE_REQUEST_FIELDS},
            parameters=[
                Param.field('gloss_field', 'Gloss field', 'Morpheme', role='gloss', required=True,
                            description='The morpheme-scope field that receives the glosses.'),
                Param.field('translation_field', 'Translation field', 'Sentence', role='translation',
                            description='The sentence-scope field holding the free translation.'),
                Param.boolean('overwrite', 'Overwrite human-edited annotations', default=False,
                              description='Also replace copied analyses and ones a person made or verified.'),
            ],
        )
        self.home = DEFAULT_HOME
        self.repo = None
        self.device = None
        self.models: Dict[str, CwompModel] = {}
        self.confirmed: Dict[Tuple[str, str, str], Tuple[float, Confirmed]] = {}

    def add_arguments(self, parser: argparse.ArgumentParser) -> None:
        parser.add_argument('--home', default=str(DEFAULT_HOME), help='Where models are kept, one per project')
        parser.add_argument('--repo', default=None, help='The CWoMP checkout (default: HOME/repo)')
        parser.add_argument('--device', default=None, help='cuda | cpu | cuda:1 (default: auto)')

    def setup(self, args) -> None:
        self.home = Path(args.home)
        self.repo = Path(args.repo) if args.repo else self.home / 'repo'
        self.device = args.device
        cwomp_src(self.repo)

    def model_for(self, project_id) -> Optional[CwompModel]:
        """The project's model, loaded again when a training run replaced it."""
        d = self.home / project_id / 'current'
        if not (d / 'model.json').exists():
            return None
        m = self.models.get(project_id)
        if m is None or m.loaded_mtime != (d / 'model.json').stat().st_mtime:
            print(f'Loading the CWoMP model of project {project_id}...')
            m = self.models[project_id] = CwompModel(d, self.repo, device=self.device)
        return m

    def confirmed_for(self, project_id, gloss_field, translation_field, progress) -> Confirmed:
        """What the project's people have confirmed (entries and their links),
        read again at most every LEXICON_REFRESH_S. The paper's mutable
        lexicon: what a person accepts reaches the next run without
        retraining."""
        key = (project_id, gloss_field, translation_field)
        at, confirmed = self.confirmed.get(key, (None, None))
        if at is None or time.monotonic() - at > LEXICON_REFRESH_S:
            _, confirmed = read_project(self.client, project_id, gloss_field, translation_field,
                                        log=progress, own_source=service_source(self.service_id))
            self.confirmed[key] = (time.monotonic(), confirmed)
        return confirmed

    def live_items(self, project) -> set:
        """The ids of every vocab item the project's vocabularies hold now. A
        link to an item deleted or merged away since the confirmed morphemes
        were read would refuse its whole batch."""
        ids = set()
        for v in project.get('vocabs') or []:
            for it in self.client.vocab_layers.get(v['id'], include_items=True).get('items') or []:
                ids.add(it['id'])
        return ids

    def process_request(self, request_data: dict, response_helper) -> None:
        document_id = request_data.get('document_id')
        project_id = request_data.get('project_id')
        requester = requester_of(self.client, request_data)
        progress = AnalyzeProgress(response_helper)
        word_layer_id = request_data.get('word_token_layer_id')
        morph_layer_id = request_data.get('morpheme_token_layer_id')
        sent_layer_id = request_data.get('sentence_token_layer_id')
        for key, val in (('documentId', document_id), ('wordTokenLayerId', word_layer_id),
                         ('morphemeTokenLayerId', morph_layer_id), ('sentenceTokenLayerId', sent_layer_id)):
            if not val:
                response_helper.error(f'Missing required parameter: {key}')
                return
        # The fields come from the request, never from a name: the dialog fills
        # the gloss field from its stored Lexicon field, and one left out is an
        # error. The translation is context, read only when one is named.
        gloss_field = request_data['gloss_field'].strip()
        if not gloss_field:
            response_helper.error('Choose the gloss field.')
            return
        translation_field = request_data['translation_field'].strip() or None
        overwrite = request_data['overwrite']

        response_helper.progress(2, 'Loading the model…')
        model = self.model_for(project_id)
        if model is None:
            response_helper.error(
                'No CWoMP model for this project. Train one on the service\'s machine: '
                f'igt_analyze_cwomp.py train {project_id}')
            return

        # A model knows the glosses of the field it was trained on. Another
        # field (a second gloss language, say) would get this one's glosses.
        trained_field = model.manifest.get('gloss_field')
        if trained_field and trained_field != gloss_field:
            response_helper.error(
                f'This project\'s CWoMP model was trained on the "{trained_field}" field, '
                f'not "{gloss_field}". Choose "{trained_field}", or train a model for '
                f'"{gloss_field}" on the service\'s machine.')
            return

        response_helper.progress(5, 'Reading the project’s confirmed morphemes…')
        project_confirmed = self.confirmed_for(
            project_id, gloss_field, translation_field,
            lambda msg: response_helper.progress(5, msg))
        model.set_lexicon(project_confirmed.entries)

        # The document is held from the read the run plans from through the
        # last write, so no edit can land while the model works (one rule for
        # every service, Luke's ruling R15). The result goes once it is let go.
        with held_run(self.client, response_helper, document_id) as run:
            response_helper.progress(20, 'Fetching document…')
            doc = self.client.documents.get(document_id, include_body=True)
            try:
                sentences, gloss_layer_id = derive(
                    doc, word_layer_id, morph_layer_id, sent_layer_id,
                    gloss_field=gloss_field, translation_field=translation_field)
            except ValueError as e:
                run.refusal = str(e)
                return
            translation_missing = (translation_field if translation_field
                                   and not field_layer_id(doc, sent_layer_id, translation_field, 'Sentence') else None)
            # This document's own confirmed morphemes count at once.
            own = Confirmed(service_source(self.service_id), project_confirmed.entry_types)
            for s in sentences:
                for w in s['words']:
                    own.add_word(w, gloss_layer_id)
            if own.entries - set(model.lexicon):
                model.set_lexicon(set(model.lexicon) | own.entries)
            confirmed = project_confirmed.merged(own)
            project = self.client.projects.get(project_id)
            confirmed.keep_items(self.live_items(project))
            # A link the model doubts is one more thing to undo: propose none.
            threshold = read_confidence_threshold(project.get('config'))

            def link_for(d):
                if d['prob'] is not None and d['prob'] < threshold:
                    return None
                return confirmed.link_for((d['form'], d['gloss']))

            targets, skipped = select_targets(sentences, overwrite,
                                              skip_word_ids=read_skip_word_ids(request_data))
            if not targets:
                run.result = analysis_result(document_id, len(sentences), 0, skipped,
                                             translation_missing=translation_missing)
                return

            jobs = []
            for s, idxs in targets:
                transcript = ' '.join(encode_piece(w['surface']) for w in s['words'])
                translation = ' '.join((s['translation'] or '').split())
                for i in idxs:
                    jobs.append((s, i, model.query(encode_piece(s['words'][i]['surface']), transcript, translation)))
            response_helper.progress(25, f'Analyzing {len(jobs)} words…')
            embs = model.encode_queries([q for _, _, q in jobs])
            plans, replaced = [], 0
            for n, ((s, i, _), emb) in enumerate(zip(jobs, embs)):
                if n % 50 == 0:
                    progress.count(AnalyzeProgress.ANALYZE, n, len(jobs), f'Analyzing words ({n}/{len(jobs)})…')
                picked = model.analyze_full(emb)
                w = s['words'][i]
                if not picked:
                    skipped['unaligned'] = skipped.get('unaligned', 0) + 1
                    continue
                forms, types = zip(*(decode_form(d['form']) for d in picked))
                plans.append({'word': w, 'sentence_id': s['id'], 'analysis': {
                    'segments': list(forms), 'glosses': [decode_piece(d['gloss']) for d in picked],
                    'types': list(types), 'joiners': joiners_for(list(types)),
                    'probs': [d['prob'] for d in picked],
                    'form_probs': [d['form_prob'] for d in picked],
                    'links': [link_for(d) for d in picked],
                    'gloss_details': [alternatives_detail(d, confirmed) for d in picked],
                    'surface_mismatch': False, 'degraded': False}})
                if w['state'] != 'unanalyzed':
                    replaced += 1

            response_helper.progress(88, 'Writing analyses…')
            source = service_source(self.service_id)
            stamp_detail = self.stamp_detail(requester, **model.describe())
            with response_helper.critical():
                with self.client.operation(requester.label(f'CWoMP analysis ({len(plans)} words)'),
                                           kind='service-run', ref=service_source(self.service_id)):
                    def wrote(done, total):
                        progress.count(AnalyzeProgress.WRITE, done, total,
                                       f'Writing analyses ({done}/{total} batches)…')
                    written = write_analyses(self.client, plans, gloss_layer_id, morph_layer_id,
                                             source, stamp_detail, on_progress=wrote)
            run.result = analysis_result(document_id, len(sentences), len(targets), skipped,
                                         written=written, replaced=replaced,
                                         translation_missing=translation_missing)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'train':
        p = argparse.ArgumentParser(description='Train CWoMP on a project\'s analyses')
        p.add_argument('project_id')
        p.add_argument('--url', default='http://localhost:8080')
        p.add_argument('--home', default=str(DEFAULT_HOME))
        p.add_argument('--repo', default=None)
        p.add_argument('--gloss-field', required=True, help='The morpheme field the model learns')
        p.add_argument('--translation-field', default=None,
                       help='The sentence field read as context (none when left out)')
        p.add_argument('--epochs', type=int, default=None,
                       help='Epochs for both stages (default: 100, 1000 under 100 sentences)')
        p.add_argument('--device', default=None)
        p.add_argument('--keep-work', action='store_true', help='Keep the training run\'s files')
        train(p.parse_args(sys.argv[2:]))
        return
    CwompService().run()


if __name__ == '__main__':
    main()
