"""A mirror skips where it cannot run and fails there only when told to."""

import pytest

import mirror_node
from mirror_node import node_or_skip


def test_a_missing_file_is_a_skip_that_names_it(tmp_path, monkeypatch):
    monkeypatch.delenv('PLAID_AGENT_REQUIRE_LIVE', raising=False)
    gone = tmp_path / 'node_modules'
    with pytest.raises(pytest.skip.Exception, match='node_modules'):
        node_or_skip(gone)


def test_a_missing_node_is_a_skip(tmp_path, monkeypatch):
    monkeypatch.delenv('PLAID_AGENT_REQUIRE_LIVE', raising=False)
    monkeypatch.setattr(mirror_node.shutil, 'which', lambda _name: None)
    with pytest.raises(pytest.skip.Exception, match='needs node'):
        node_or_skip(tmp_path)


def test_require_live_turns_the_skip_into_a_failure(tmp_path, monkeypatch):
    monkeypatch.setenv('PLAID_AGENT_REQUIRE_LIVE', '1')
    with pytest.raises(AssertionError, match='PLAID_AGENT_REQUIRE_LIVE is set'):
        node_or_skip(tmp_path / 'node_modules')


def test_everything_here_gives_the_node(tmp_path, monkeypatch):
    monkeypatch.setattr(mirror_node.shutil, 'which', lambda _name: '/usr/bin/node')
    assert node_or_skip(tmp_path) == '/usr/bin/node'
