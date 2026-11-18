"""A job token core no longer takes while the starter still writes (D5, D6
of the job review 2026-11-18): the starter changed their password or logged
out everywhere, which revokes every token minted for them (CONTRACT 4), or a
piece ran past the token's hour. The next heartbeat mints a valid token, and
the job carries on with it: a step refused 401 is made again with it, and
every client the job handed out sends the latest token. Only a heartbeat that
answers the job failed ends it ``starter-access``."""

from job_fixtures import JobClient, document, start


def _client():
    return JobClient({f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['blank']}]) for i in (1, 2)})


class _Client:
    def __init__(self, token):
        self.token = token


def test_every_client_the_job_handed_out_sends_the_token_of_the_latest_heartbeat():
    client = _client()
    job = start(client)
    made = []
    job.client_for = lambda token: made.append(_Client(token)) or made[-1]
    piece = job.client()
    job.beat()
    assert job.token and piece.token == job.token
    later = job.client()
    job.beat()
    assert piece.token == later.token == job.token
