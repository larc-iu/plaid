"""A private Plaid core for the suites that need the real query engine.

The fake client runs no queries, so every corpus-wide igt tool (search,
statistics, worklists, the corpus-wide changes) is tested against a real
core. This module boots one for the test session: its own free port, its own
database in a temporary directory, its own admin, and it is stopped when the
session ends. The dev core on :8085 is never touched.

Which core runs, in order:

- ``PLAID_TEST_URL`` names a core that is already up (with
  ``PLAID_TEST_USER`` and ``PLAID_TEST_PASSWORD``): it is used and left
  running. The way to iterate without paying for a boot every run.
- ``PLAID_CORE_JAR`` names a built jar: it runs with ``java -jar``.
- The jar ``bb build`` leaves in ``plaid-core/target``, when it is newer than
  every core source file, so a stale jar never stands in for the working tree.
- Otherwise the core from source through the Clojure CLI (``clojure -M``),
  which compiles first and so takes longer to boot.

When none of these can run (no Java, or neither a fresh jar nor the Clojure
CLI), the tests that need a core skip and say why. ``PLAID_AGENT_REQUIRE_LIVE=1``
turns that skip into a failure, for a gate that means to run them.

Run this file to boot one and keep it up, printing the ``PLAID_TEST_URL`` to
export, until Ctrl-C.
"""

import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

REPO = Path(__file__).resolve().parents[2]
CORE_DIR = REPO / 'plaid-core'
ADMIN_EMAIL = 'agent-tests@example.com'
ADMIN_PASSWORD = 'agent-tests-password'
JVM_FLAGS = ['--add-opens=java.base/java.nio=ALL-UNNAMED', '--enable-native-access=ALL-UNNAMED', '-Xmx2g']
BOOT_TIMEOUT = 300


class Unavailable(Exception):
    """No core can be started here: the reason, for the skip."""


# Launches on a fresh port after the first one was taken before the core bound it.
PORT_RELAUNCHES = 2


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def _newest_source() -> float:
    newest = 0.0
    for sub in ('src', 'resources', 'deps.edn'):
        p = CORE_DIR / sub
        if p.is_file():
            newest = max(newest, p.stat().st_mtime)
            continue
        for root, _dirs, files in os.walk(p):
            for f in files:
                try:
                    newest = max(newest, os.stat(os.path.join(root, f)).st_mtime)
                except OSError:
                    pass
    return newest


def _fresh_jar() -> Optional[Path]:
    jars = sorted((CORE_DIR / 'target').glob('plaid-*.jar'), key=lambda p: p.stat().st_mtime)
    if jars and jars[-1].stat().st_mtime > _newest_source():
        return jars[-1]
    return None


def command(config: Path) -> list:
    """The command that runs a core with ``config``, or :class:`Unavailable`."""
    java = shutil.which('java')
    if not java:
        raise Unavailable('no Java on PATH to run a Plaid core')
    named = os.environ.get('PLAID_CORE_JAR')
    if named:
        if not Path(named).is_file():
            raise Unavailable(f'PLAID_CORE_JAR names no file: {named}')
        return [java, *JVM_FLAGS, '-jar', named, '--config', str(config)]
    jar = _fresh_jar()
    if jar:
        return [java, *JVM_FLAGS, '-jar', str(jar), '--config', str(config)]
    clojure = shutil.which('clojure')
    if clojure and (CORE_DIR / 'deps.edn').is_file():
        return [clojure, *(f'-J{f}' for f in JVM_FLAGS), '-M', '-m', 'plaid.server.main', '--config', str(config)]
    raise Unavailable('no Plaid core to run: no jar newer than plaid-core\'s sources (bb build, or PLAID_CORE_JAR) '
                      'and no Clojure CLI to run it from source')


def answers(url: str) -> bool:
    """Whether a server answers at ``url``."""
    try:
        urllib.request.urlopen(url + '/api/v1/login', timeout=2)
    except urllib.error.HTTPError:
        return True  # any HTTP answer means the server is up
    except Exception:  # noqa: BLE001
        return False
    return True


def _die_with_parent() -> None:
    """In the child, on Linux: be sent SIGTERM when the process that started
    it ends, however it ends, so a test run that is killed takes its core with
    it. The Clojure CLI execs the JVM, which keeps the request."""
    if sys.platform.startswith('linux'):
        import ctypes
        ctypes.CDLL(None).prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG


class PrivateCore:
    """One core process and its directory. :meth:`stop` ends both."""

    def __init__(self):
        self.dir = Path(tempfile.mkdtemp(prefix='plaid-agent-core-'))
        self.log = None
        try:
            self._launch()
        except Unavailable:
            shutil.rmtree(self.dir, ignore_errors=True)
            raise

    def _launch(self) -> None:
        """Start the core on a port free at this moment. The port is only
        known free until the JVM binds it, and on a busy CI runner another
        process can take it first, so :meth:`wait` launches again on a fresh
        one when the core says its port is in use."""
        self.port = _free_port()
        self.url = f'http://127.0.0.1:{self.port}'
        config = self.dir / 'config.toml'
        config.write_text(f'[server]\nport = {self.port}\n\n[logging]\nlevel = "warn"\nlibrary_level = "warn"\n\n'
                          f'[database]\npath = "{self.dir / "plaid.db"}"\n\n[backup]\nenabled = false\n')
        cmd = command(config)
        if self.log is not None:
            self.log.close()
        self.log = open(self.dir / 'core.log', 'wb')
        env = {**os.environ, 'PLAID_ADMIN_EMAIL': ADMIN_EMAIL, 'PLAID_ADMIN_PASSWORD': ADMIN_PASSWORD}
        # Its own process group, so stopping it reaches the JVM the Clojure
        # CLI starts and nothing else.
        self.proc = subprocess.Popen(cmd, cwd=CORE_DIR, env=env, stdin=subprocess.DEVNULL, stdout=self.log,
                                     stderr=subprocess.STDOUT, start_new_session=True, preexec_fn=_die_with_parent)

    def wait(self, timeout: float = BOOT_TIMEOUT) -> None:
        deadline = time.monotonic() + timeout
        relaunches = 0
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                if relaunches < PORT_RELAUNCHES and 'Address already in use' in self.tail():
                    relaunches += 1
                    self._launch()
                    continue
                raise RuntimeError(f'the private Plaid core exited ({self.proc.returncode}) before it was ready:\n'
                                   + self.tail())
            if answers(self.url):
                return
            time.sleep(0.5)
        raise RuntimeError(f'the private Plaid core was not ready after {timeout:.0f}s:\n' + self.tail())

    def tail(self) -> str:
        try:
            return (self.dir / 'core.log').read_text(errors='replace')[-3000:]
        except OSError:
            return ''

    def stop(self) -> None:
        if self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(30)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL)
                self.proc.wait()
            except ProcessLookupError:
                pass
        self.log.close()
        shutil.rmtree(self.dir, ignore_errors=True)


def start() -> PrivateCore:
    """A booted private core, or :class:`Unavailable`. A core that fails to
    boot raises with its log."""
    core = PrivateCore()
    try:
        core.wait()
    except BaseException:
        core.stop()
        raise
    return core


if __name__ == '__main__':
    # Held, so the wait below takes them and the core is stopped, rather than
    # this process dying and leaving the core running.
    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
    t0 = time.monotonic()
    core = start()
    print(f'plaid-core ready in {time.monotonic() - t0:.0f}s (pid {core.proc.pid})')
    print(f'export PLAID_TEST_URL={core.url} PLAID_TEST_USER={ADMIN_EMAIL} PLAID_TEST_PASSWORD={ADMIN_PASSWORD}')
    sys.stdout.flush()
    try:
        signal.sigwait({signal.SIGINT, signal.SIGTERM})
    finally:
        core.stop()
