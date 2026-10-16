"""What the package root exports beside the client, so a caller never has to
reach into a submodule for a name it is meant to catch or compare against."""

import plaid_client
from plaid_client import services, sse


def test_the_no_answer_messages_and_the_stream_close_are_at_the_root():
    assert plaid_client.UNKNOWN_OUTCOME == services.UNKNOWN_OUTCOME
    assert plaid_client.UNREACHABLE == services.UNREACHABLE
    assert plaid_client.StreamClosed is sse.StreamClosed
    for name in ('UNKNOWN_OUTCOME', 'UNREACHABLE', 'StreamClosed'):
        assert name in plaid_client.__all__
