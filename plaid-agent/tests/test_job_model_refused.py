"""A model's provider that refuses the job's calls (S1-2 of the stress
campaign 2026-11-18). A refusal of the key or of the model (401, 403, 404)
would refuse every call the same: the job ends failed, ``model-refused``,
with the provider's words (no key, no address, no library class name), never a sentence skipped as an answer too long
and a job ended done. Any other refusal of the provider is a stretch's own
failure, halved as before, and its sentences say ``refused``, never
``output``."""

import litellm
import pytest

from job_fixtures import JobClient, ModelConfig, Model, call, document, planned, reply, use

from plaid_agent.core.job import Worker
from plaid_agent.igt.job import runner_factory


def _client():
    return JobClient({f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['ka']}, {'words': ['mo']}])
                      for i in (1, 2)})


def _run(monkeypatch, raising, from_planning=False):
    client = _client()
    made = client.jobs.create('p1', 'igt', 'Gloss the words.')

    def answer(asked, n, kwargs):
        if '"Story 2"' in asked or from_planning:
            raise raising()
        if n > 1:
            return reply('Done.')
        return reply(calls=[call(1, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w1',
                                                     'morphemes': [{'form': 'ka', 'type': 'stem'}]})])
    model = planned(answer)
    if from_planning:
        def model(asked, n, kwargs):  # noqa: F811 - every call refused, the planning's too
            raise raising()
    use(monkeypatch, Model(model))
    Worker(client, {'igt': runner_factory(ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                          count=lambda v: 1)},
           'fake/m', client_for=lambda token: client, sleep=lambda s: None, heartbeat_s=10 ** 6).once()
    return client.jobs.rows[made['id']]


REFUSALS = {
    'key': lambda: litellm.AuthenticationError('Incorrect API key provided', 'openai', 'm'),
    'model': lambda: litellm.NotFoundError('The model does not exist', 'm', 'openai'),
    'permission': lambda: litellm.PermissionDeniedError(
        'Not allowed', 'openai', 'm', __import__('httpx').Response(403, request=__import__('httpx').Request(
            'POST', 'http://x'))),
}


@pytest.mark.parametrize('what', sorted(REFUSALS))
@pytest.mark.parametrize('from_planning', [False, True])
def test_a_refused_key_or_model_fails_the_job_with_the_providers_words(monkeypatch, what, from_planning):
    row = _run(monkeypatch, REFUSALS[what], from_planning)
    assert row['state'] == 'failed', (row['state'], row.get('reason'), row.get('message'))
    assert row['reason'] == 'model-refused'
    # A fixed sentence with safe facts only, never the provider's words (REV-SJ1-R2-1).
    lines = {'key': 'The model’s provider refused the job’s key (HTTP 401).',
             'permission': 'The model’s provider refused the job’s key (HTTP 403).',
             'model': 'The model’s provider found no such model or address (HTTP 404).'}
    assert row['message'] == lines[what], row['message']
    skipped = [s for d in row['documents'] for s in d.get('skipped') or []]
    assert not any(s.get('kind') == 'output' for s in skipped), skipped


def test_another_provider_refusal_skips_its_sentences_as_refused_never_too_long(monkeypatch):
    row = _run(monkeypatch, lambda: litellm.BadRequestError('Invalid request', 'm', 'openai'))
    assert row['state'] == 'done', (row['state'], row.get('reason'), row.get('message'))
    d2 = next(d for d in row['documents'] if d['document_id'] == 'd2')
    assert [s['kind'] for s in d2['skipped']] == ['refused', 'refused'], d2['skipped']


#: The review's probe (REV-SJ1-R2-1), each case: the worker's arguments, the
#: environment, what the provider says, and what must never reach a reader.
PROBE_KEY = 'sk-live-Zq81hT0pWmX4abcd'
PROBE = {
    'env OPENAI_API_KEY': (dict(api_key=None, api_base=None), {'OPENAI_API_KEY': PROBE_KEY},
                           f'Incorrect API key provided: {PROBE_KEY}', [PROBE_KEY]),
    'env AZURE_AD_TOKEN': (dict(api_key=None, api_base=None), {'AZURE_AD_TOKEN': PROBE_KEY},
                           f'Token refused: {PROBE_KEY}', [PROBE_KEY]),
    'env HF_TOKEN': (dict(api_key=None, api_base=None), {'HF_TOKEN': PROBE_KEY}, f'bad token {PROBE_KEY}',
                     [PROBE_KEY]),
    'env AWS_SECRET_ACCESS_KEY': (dict(api_key=None, api_base=None), {'AWS_SECRET_ACCESS_KEY': PROBE_KEY},
                                  f'signature for {PROBE_KEY}', [PROBE_KEY]),
    'partial key': (dict(api_key=PROBE_KEY, api_base=None), {},
                    'Incorrect API key provided: sk-liv*************abcd', ['sk-liv', 'abcd']),
    'url-encoded key': (dict(api_key='k3y/with+slash=Zq81', api_base=None), {},
                        'refused key k3y%2Fwith%2Bslash%3DZq81', ['k3y', 'Zq81']),
    'key in JSON': (dict(api_key=PROBE_KEY, api_base=None), {},
                    '{"error": {"message": "bad key", "key": "%s"}}' % PROBE_KEY, [PROBE_KEY]),
    'base quoted with a slash': (dict(api_key=PROBE_KEY, api_base='https://llm.internal.org/v1'), {},
                                 'Not found: https://llm.internal.org/v1/ model m', ['llm.internal.org']),
    'bare host': (dict(api_key=PROBE_KEY, api_base='https://llm.internal.org:8443/v1'), {},
                  'Cannot connect to host llm.internal.org port 8443', ['llm.internal.org', '8443']),
    'user:password': (dict(api_key=PROBE_KEY, api_base='https://bob:hunter22pass@llm.internal.org/v1'), {},
                      'Unauthorized for bob:hunter22pass on llm.internal.org', ['hunter22pass', 'bob:']),
    'query-string key': (dict(api_key=None, api_base='https://llm.internal.org/v1?api-key=QQQsecretQQQ'), {},
                         'refused api-key=QQQsecretQQQ', ['QQQsecretQQQ']),
    'short key': (dict(api_key='abc123', api_base=None), {}, 'Incorrect API key provided: abc123', ['abc123']),
}


@pytest.mark.parametrize('case', sorted(PROBE))
def test_no_provider_words_reach_a_reader(monkeypatch, case):
    """REV-SJ1-R2-1: masking cannot be complete, so a reader is never shown a
    provider's own words: not in the job's line, its report, a heartbeat or
    read_job. The secrets are the worker's own (``jobworker.job_secrets``)."""
    import json
    import os
    from plaid_agent.igt import jobread
    from plaid_agent.jobworker import job_secrets
    args, env, said, secret = PROBE[case]
    for k in [k for k in os.environ if 'KEY' in k or 'TOKEN' in k or 'SECRET' in k]:
        monkeypatch.delenv(k)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    client = _client()
    made = client.jobs.create('p1', 'igt', 'Gloss the words.')

    def refusing(**kwargs):
        raise litellm.AuthenticationError(said, 'openai', 'm')
    use(monkeypatch, refusing)
    Worker(client, {'igt': runner_factory(ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                          count=lambda v: 1)},
           'fake/m', client_for=lambda token: client, sleep=lambda s: None, heartbeat_s=10 ** 6,
           secrets=job_secrets(**args)).once()
    row = client.jobs.rows[made['id']]
    assert row['message'] == 'The model’s provider refused the job’s key (HTTP 401).', row['message']
    seen = [row['message'], json.dumps(row['report'], ensure_ascii=False),
            *[json.dumps(c, ensure_ascii=False) for c in client.jobs.calls if c[0] == 'heartbeat'],
            '\n'.join(jobread.summary(client.jobs.get(made['id'])))]
    for text in seen:
        for bit in secret:
            assert bit not in text, (bit, text[:300])


def test_any_other_error_of_the_model_library_says_only_its_status(monkeypatch):
    """REV-SJ1-R2-1: an error of the provider's library that ends the job as
    the worker's own fault shows its status, never its words."""
    from plaid_agent.core.job import error_line
    e = litellm.APIConnectionError(f'Cannot reach https://llm.internal.org/v1 with key {PROBE_KEY}', 'openai', 'm')
    line = error_line(e)
    assert PROBE_KEY not in line and 'llm.internal.org' not in line, line
    assert line == 'The job worker stopped the job: the model’s provider failed (HTTP 500).', line
