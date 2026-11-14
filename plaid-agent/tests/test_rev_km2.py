"""REV-KM2's probes (scripts/REV-KM2/test_revkm2_probes.py) as tests.
People's precedent (``IgtRunner.people_of``) leaves out only a word on whose
morphemes someone else made the job wrote a value or a link in place
(REV-KM-3): a person's hand correction of a job's proposal, and a person's
analysis beside a machine word field, are people's again (REV-KM2-1)."""

import json

from fixtures import FakeClient, fake_ws, lexicon_raw
from test_restated_analysis import ALIDI, doc, project, ws

from plaid_agent.igt.toolkit import call_tool

J = 'JH'


def _harmonize(words, confirm=()):
    from job_fixtures import JobClient, document, recorded, runner, start
    raw = document('d1', 'Story d1', [{'words': words}])
    ml = next(tl for tl in raw['text_layers'][0]['token_layers'] if tl['id'] == 'tk-morph')
    for sp in ml['span_layers'][0]['spans']:
        if sp['tokens'][0] in confirm:
            sp['metadata'] = {**sp['metadata'], 'provConfirmed': True}
    client = JobClient({'d1': raw})
    job = start(client, id=J)
    job.update_row('d1', state='done')
    recorded(job)
    r = runner(job)
    return r, r.harmonize(job)


def test_km2_1_a_hand_correction_of_the_jobs_proposal_is_peoples_precedent():
    """P3c: the job proposed ka-ta 'g1-g9'. A person corrected ta to g2 on
    two of those words (that span verified, the rest the job's). The job's
    rewritable words hold g1-g9 twice and g1-g2 once."""
    corrected = {'token': J, 'span': J, 'link': J}
    words = [('kata', [('ka', 'g1'), ('ta', 'g2')], corrected) for _ in range(2)]
    words += [('kata', [('ka', 'g1'), ('ta', 'g9')], J), ('kata', [('ka', 'g1'), ('ta', 'g9')], J),
              ('kata', [('ka', 'g1'), ('ta', 'g2')], J)]
    r, out = _harmonize(words, confirm=('d1-s1w1m2', 'd1-s1w2m2'))
    assert sum(x['count'] for x in r.people.get('kata', {}).values()) == 2, r.people
    (c,) = out['changed']
    assert (c['to'], c['by']) == ('ka-ta ‘g1-g2’', 'person'), json.dumps(out, ensure_ascii=False)


def test_km2_1_peoples_analysis_beside_a_machine_word_field_is_peoples_precedent():
    """P3h: people analysed kata as ka-ta 'g1-g2' on four words, each with
    the job's Word Gloss. The job's own words hold g1-X twice, g1-g2 once."""
    words = [{'form': 'kata', 'morphs': [('ka', 'g1'), ('ta', 'g2')], 'who': 'human', 'gloss': ('go', J)}
             for _ in range(4)]
    words += [('kata', [('ka', 'g1'), ('ta', 'X')], J), ('kata', [('ka', 'g1'), ('ta', 'X')], J),
              ('kata', [('ka', 'g1'), ('ta', 'g2')], J)]
    r, out = _harmonize(words)
    (c,) = out['changed']
    assert (c['to'], c['by']) == ('ka-ta ‘g1-g2’', 'person'), json.dumps(out, ensure_ascii=False)


def test_km2_1_a_piece_is_shown_that_precedent():
    """P3p: three people's words of kata, each with another producer's
    draft Word Gloss: a piece is shown them."""
    from job_fixtures import JobClient, document, runner, start
    from plaid_agent.igt.workspace import Workspace
    words = [{'form': 'kata', 'morphs': [('ka', 'g1'), ('ta', 'g2')], 'who': 'human', 'gloss': ('go', 'machine')}
             for _ in range(3)] + ['kata']
    client = JobClient({'d1': document('d1', 'Story d1', [{'words': words}])})
    job = start(client, id=J)
    r = runner(job)
    project = r.project()
    d = r.read(project, 'd1')
    out = r.precedent(Workspace(job.client(), project), project, [d.sentences[0].words[3]])
    assert 'people: ka-ta ‘g1-g2’ (3)' in out, out
