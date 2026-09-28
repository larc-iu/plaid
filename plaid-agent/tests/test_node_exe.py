"""The mirror tests find node where nvm installed it, not only on PATH: a
non-interactive shell has none on PATH, and every mirror case skipped."""

import os
import stat

import node_exe


def _fake_node(root, version):
    path = root / 'versions' / 'node' / f'v{version}' / 'bin' / 'node'
    path.parent.mkdir(parents=True)
    path.write_text(f'#!/bin/sh\necho v{version}\n')
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


def test_nvm_s_newest_node_is_found_with_none_on_path(tmp_path, monkeypatch):
    _fake_node(tmp_path, '16.20.0')
    newest = _fake_node(tmp_path, '24.1.0')
    _fake_node(tmp_path, '20.9.0')
    monkeypatch.setenv('NVM_DIR', str(tmp_path))
    monkeypatch.setenv('PATH', '/nonexistent')
    monkeypatch.delenv('NVM_BIN', raising=False)
    monkeypatch.delenv('PLAID_NODE', raising=False)
    assert node_exe.find_node() == newest


def test_plaid_node_names_the_node_and_an_old_one_is_not_used(tmp_path, monkeypatch):
    old = _fake_node(tmp_path, '16.20.0')
    monkeypatch.setenv('PLAID_NODE', old)
    assert node_exe.find_node() is None
    monkeypatch.setenv('PLAID_NODE', os.path.join(str(tmp_path), 'missing'))
    assert node_exe.find_node() is None
