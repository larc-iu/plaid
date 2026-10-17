"""A second oracle for igt plans, written by the REV4-AGENT review and kept
as its sweep (``test_rule_plan_model.py``): random plans of rules, keeps,
named changes and ``values=`` on a live private core,
approved through the service, against an independent model of what the user
asked for, run step by step over the tool calls."""
import re

from fixtures import GLOSS, MGLOSS, project_raw, TEXT_LAYER, SENT_LAYER, WORD_LAYER, MORPH_LAYER
from live import _Session
from test_service_flow import Helper
from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.conversation import ConversationStore, assistant_item, build_meta, user_item
from plaid_agent.igt.service import AssistantService

VALS = ['A', 'B', 'C', 'AB', '']
LET = ['A', 'B', 'C', 'D']
FORMS = ['ka', 'to', 'mi']
SUFF = ['s', 'n']
FIELDS = {'Gloss': 'Word', 'Morph Gloss': 'Morpheme'}
DOCS = ['Doc A', 'Doc B']


def project():
    p = project_raw()
    # No tagset on Morph Gloss: values are free.
    for tl in p['text_layers']:
        for tk in tl['token_layers']:
            for sl in tk.get('span_layers') or []:
                if sl['id'] == MGLOSS:
                    sl['config'] = {'igt': {'scope': 'Morpheme'}}
    return p


def make_doc(rng, did, name, nsent=2, nword=3):
    words, morphs, gl, mg = [], [], [], []
    sents = []
    body = ''
    stored = {}
    for si in range(nsent):
        sb = len(body)
        for wi in range(nword):
            stem = rng.choice(FORMS)
            parts = [stem] + ([rng.choice(SUFF)] if rng.random() < 0.5 else [])
            surf = ''.join(parts)
            b = len(body)
            body += surf
            e = len(body)
            body += ' ' if wi < nword - 1 else '. '
            wid = f'{did}-w{si}{wi}'
            words.append({'id': wid, 'begin': b, 'end': e})
            v = rng.choice(VALS)
            ref = f's{si + 1}.w{wi + 1}'
            stored[(name, ref, 'Gloss')] = v
            if v:
                gl.append({'id': f'{did}-g{si}{wi}', 'value': v, 'tokens': [wid]})
            for mi, form in enumerate(parts):
                mid = f'{did}-m{si}{wi}{mi}'
                morphs.append({'id': mid, 'begin': b, 'end': e, 'precedence': mi + 1, 'metadata': {'form': form}})
                v = rng.choice(VALS)
                stored[(name, f'{ref}.m{mi + 1}', 'Morph Gloss')] = v
                if v:
                    mg.append({'id': f'{did}-mg{si}{wi}{mi}', 'value': v, 'tokens': [mid]})
        sents.append({'id': f'{did}-s{si}', 'begin': sb, 'end': len(body) - 1})
    body = body.rstrip()
    doc = {'id': did, 'name': name, 'version': 1, 'text_layers': [{
        'id': TEXT_LAYER, 'name': 'Text', 'text': {'id': f'{did}-text', 'body': body},
        'token_layers': [
            {'id': SENT_LAYER, 'tokens': sents, 'span_layers': []},
            {'id': WORD_LAYER, 'tokens': words, 'span_layers': [{'id': GLOSS, 'spans': gl}], 'vocabs': []},
            {'id': MORPH_LAYER, 'tokens': morphs, 'span_layers': [{'id': MGLOSS, 'spans': mg}], 'vocabs': []},
        ]}]}
    # form of each target, for set_field_for_form
    forms = {}
    for si in range(nsent):
        for wi in range(nword):
            ws_ = [w for w in words if w['id'] == f'{did}-w{si}{wi}'][0]
            surf = body[ws_['begin']:ws_['end']]
            forms[(name, f's{si + 1}.w{wi + 1}', 'Gloss')] = surf
            ms = [m for m in morphs if m['id'].startswith(f'{did}-m{si}{wi}')]
            for mi, m in enumerate(ms):
                forms[(name, f's{si + 1}.w{wi + 1}.m{mi + 1}', 'Morph Gloss')] = m['metadata']['form']
    return doc, stored, forms


# --- the independent model -------------------------------------------------------

class Model:
    """What the user asked for. entries: ('rule', spec) | ('named', t, v) |
    ('keep', t). Sequential: rules read stored + earlier rules, kept values
    as stored; named values set at their position; keeps hold a target out of
    every rule."""

    def __init__(self, stored, forms):
        self.stored = dict(stored)
        self.forms = forms
        self.entries = []

    def kept(self):
        return {e[1] for e in self.entries if e[0] == 'keep'}

    @staticmethod
    def apply_rule(spec, t, v, form):
        if spec['field'] != t[2] or (spec.get('document') and spec['document'] != t[0]):
            return None
        if spec['tool'] == 'replace_in_field':
            if v == '':
                return None
            if spec['whole']:
                nv = spec['replacement'] if v == spec['pattern'] else v
            else:
                nv = v.replace(spec['pattern'], spec['replacement'])
            return nv if nv != v else None
        if spec['tool'] == 'set_field_for_form':
            if form != spec['form']:
                return None
            if v == spec['value'] or (spec['only_empty'] and v != ''):
                return None
            return spec['value']

    def run(self, entries=None, rule_view_only=False):
        """Final values. rule_view_only: ignore named entries (what rules read)."""
        entries = self.entries if entries is None else entries
        kept = {e[1] for e in entries if e[0] == 'keep'}
        V = dict(self.stored)
        for e in entries:
            if e[0] == 'rule':
                for t in V:
                    if t in kept:
                        continue
                    nv = self.apply_rule(e[1], t, V[t], self.forms[t])
                    if nv is not None:
                        V[t] = nv
            elif e[0] == 'named' and not rule_view_only:
                V[e[1]] = e[2]
        return V

    def rule_takes(self, t):
        """Some rule of the plan changes t (rules over stored + earlier rules)."""
        kept = self.kept()
        V = dict(self.stored)
        for e in self.entries:
            if e[0] != 'rule':
                continue
            for u in V:
                if u in kept and u != t:
                    continue
                nv = self.apply_rule(e[1], u, V[u], self.forms[u])
                if nv is not None:
                    if u == t:
                        return True
                    if u not in kept:
                        V[u] = nv
        return False

    def set_field(self, t, v):
        self.entries = [e for e in self.entries if not (e[0] in ('named', 'keep') and e[1] == t)
                        or e[0] == 'rule']
        if v == self.stored[t]:
            if self.rule_takes(t):
                self.entries.append(('keep', t))
            return
        self.entries.append(('named', t, v))


def parse_int_sum(s):
    return sum(int(x) for x in re.findall(r'\d+', s or ''))


def values_of(ws):
    out = {}
    for d in ws.documents():
        doc = ws.doc(d['id'])
        for si, s in enumerate(doc.sentences, start=1):
            for wi, w in enumerate(s.words, start=1):
                g = w.fields.get('Gloss')
                out[(doc.name, f's{si}.w{wi}', 'Gloss')] = g.value if g else ''
                for mi, m in enumerate(w.morphemes, start=1):
                    g = m.fields.get('Morph Gloss')
                    out[(doc.name, f's{si}.w{wi}.m{mi}', 'Morph Gloss')] = g.value if g else ''
    return out


#: What the service answers to an approval of a plan with nothing to write,
#: which it settles as discarded (Luke 2026-10-16).
NOTHING_TO_WRITE = 'Nothing to write. The plan was discarded.'


def as_applied(h):
    """A sweep's reading of an approval: a plan with nothing to write, settled
    as discarded, counts as applied with nothing written."""
    if h is not None and h.errors == [NOTHING_TO_WRITE] and not h.done:
        h.errors = []
        h.done = [{'kind': 'applied', 'applied': 0, 'message': NOTHING_TO_WRITE}]
    return h


def approve(c, project_id, ws, tag='x'):
    p = ws.plan_payload()
    if p is None:
        return None, None, None
    store = ConversationStore(c, _Session.user, project_id, 'igt')
    item = assistant_item('Planned.', p, [], [], '', 'fake/model', service='igt:assist:fake')
    conv = {'messages': [{'role': 'user', 'content': 'x'}, {'role': 'assistant', 'content': 'Planned.'}],
            'display': [user_item('x'), item]}
    store.save('c1', conv, build_meta(None, 'c1', conv, 'igt:assist:fake', 'fake/model'))
    svc = AssistantService(); svc.cfg = ModelConfig(model='fake/model'); svc.service_id = 'igt:assist:fake'
    h = Helper(request_id='r1')
    svc.process_request({'requester_client': c, 'requester_id': _Session.user, 'project_id': project_id,
                         'delegated_projects': [project_id], 'conversation_id': 'c1', 'op': 'approve',
                         'plan_id': p['id']}, h)
    return p, h, store
