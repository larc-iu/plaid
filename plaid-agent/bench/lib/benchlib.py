"""Shared pieces of the assistant benchmark: where things are, a private core
on a copy of a database, and the client for a sandbox user.

Run every bench script with the plaid-agent env's python ($PLAID_AGENT_PYTHON,
which the launchers require). The scripts put the
snapshotted plaid-agent and plaid-client-py (code/<sha>/) on sys.path
themselves, through `use_code`, so the code under test is the snapshot, never
the working tree.

The harness is in git (plaid-agent/bench). Everything it makes or reads that
is not code lives in the data directory, `$PLAID_BENCH_DATA` (default
~/.local/share/plaid-bench), never in the repository: the code snapshots
(code/), the fixture sources and the database snapshot (fixtures/src,
fixtures/snapshot, fixtures/build), the runs (runs/) and the gate's slot
files (.llm-slots/).
"""
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get('PLAID_BENCH_DATA') or Path.home() / '.local/share/plaid-bench').expanduser()
FIXTURES = DATA / 'fixtures'
SNAPSHOT = FIXTURES / 'snapshot'
RUNS = DATA / 'runs'
CODE = DATA / 'code'
AGENT_PY = Path(os.environ.get('PLAID_AGENT_PYTHON') or sys.executable)
JAVA_OPTS = ['--add-opens=java.base/java.nio=ALL-UNNAMED', '--enable-native-access=ALL-UNNAMED']

USERS = {
    'A': ('a@b.com', 'password'),
    'B': ('b@x.com', 'b-pass-123'),
    'C': ('c@x.com', 'c-pass-123'),
}


def code_dir(sha=None) -> Path:
    sha = sha or (CODE / 'CURRENT').read_text().strip()
    d = CODE / sha
    if not (d / 'plaid-core/target/plaid.jar').is_file():
        raise SystemExit(f'no built code at {d}: run code.sh first')
    return d


def use_code(sha=None) -> Path:
    d = code_dir(sha)
    for p in (d / 'plaid-agent/src', d / 'plaid-client-py/src'):
        if str(p) not in sys.path:
            sys.path.insert(0, str(p))
    return d


def free_port() -> int:
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def listens(pid: int, port: int) -> bool:
    """Whether process `pid` holds the socket listening on `port`, read from
    Linux's /proc. Where there is no /proc this cannot be told, and a server
    answering on the port is taken as the one started."""
    if not Path('/proc/net/tcp').exists():
        return True
    inodes = set()
    for table in ('/proc/net/tcp', '/proc/net/tcp6'):
        try:
            rows = Path(table).read_text().splitlines()[1:]
        except OSError:
            continue
        for row in rows:
            f = row.split()
            if f[3] == '0A' and int(f[1].rsplit(':', 1)[1], 16) == port:
                inodes.add(f'socket:[{f[9]}]')
    try:
        fds = os.listdir(f'/proc/{pid}/fd')
    except OSError:
        return False
    for fd in fds:
        try:
            if os.readlink(f'/proc/{pid}/fd/{fd}') in inodes:
                return True
        except OSError:
            pass
    return False


# Launches on a fresh port after the one handed out was taken before the core
# bound it (another shard's core, most likely).
PORT_RELAUNCHES = 2


class Core:
    """A plaid-core on its own port over the database directory `db_dir`
    (plaid.db plus jwt-secret.txt), its log in `log`. Started in its own
    process group, so stop() takes exactly what start() made. A port named by
    the caller is used or the start fails. Otherwise a port taken before the
    core binds it is left for a fresh one."""

    def __init__(self, code: Path, db_dir: Path, log: Path, port: int = None, admin=True):
        self.code, self.db_dir, self.log = code, Path(db_dir), Path(log)
        self.named_port = port
        self.port = port or free_port()
        self.url = f'http://127.0.0.1:{self.port}'
        self.proc = None
        self.admin = admin

    def command(self, cfg: Path) -> list:
        return ['java', '-Xmx3g', *JAVA_OPTS, '-jar', str(self.code / 'plaid-core/target/plaid.jar'),
                '--config', str(cfg)]

    def _launch(self):
        cfg = self.db_dir / 'config.toml'
        cfg.write_text(f'[server]\nport = {self.port}\n[logging]\nlevel = "info"\nlibrary_level = "warn"\n'
                       f'[database]\npath = "{self.db_dir / "plaid.db"}"\n'
                       f'[backup]\nenabled = false\ndirectory = "{self.db_dir / "backups"}"\n')
        env = dict(os.environ, PLAID_NO_REEXEC='1')
        env.pop('OPENAI_API_KEY', None)
        if self.admin:
            env.update(PLAID_ADMIN_EMAIL=USERS['A'][0], PLAID_ADMIN_PASSWORD=USERS['A'][1])
        self.log_from = self.log.stat().st_size if self.log.exists() else 0
        self.proc = subprocess.Popen(
            self.command(cfg),
            stdout=open(self.log, 'ab'), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            env=env, start_new_session=True, cwd=str(self.db_dir))

    def tail(self) -> str:
        """This launch's log, its last lines."""
        try:
            with open(self.log, 'rb') as f:
                f.seek(self.log_from)
                return f.read().decode(errors='replace')[-3000:]
        except OSError:
            return ''

    def _answers(self) -> bool:
        try:
            req = urllib.request.Request(self.url + '/api/v1/login', data=b'{}', method='POST',
                                         headers={'content-type': 'application/json'})
            urllib.request.urlopen(req, timeout=2)
        except urllib.error.HTTPError:
            pass
        except Exception:
            return False
        return True

    def _relaunch(self, why):
        """On a fresh port, or the start fails with `why` when the caller named
        the port or the relaunches are spent."""
        self.stop()
        if self.named_port or self.relaunches >= PORT_RELAUNCHES:
            raise RuntimeError(f'{why}\n{self.tail()}')
        self.relaunches += 1
        self.port = free_port()
        self.url = f'http://127.0.0.1:{self.port}'
        self._launch()

    def start(self, timeout=120):
        """Returns once the core this process started answers on its port.
        The core must hold the port itself: a server another process runs
        there is never taken for it."""
        self.relaunches = 0
        self._launch()
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                if 'Address already in use' in self.tail():
                    self._relaunch(f'core could not bind port {self.port}, see {self.log}')
                    continue
                raise RuntimeError(f'core exited ({self.proc.returncode}), see {self.log}\n{self.tail()}')
            if self._answers():
                if listens(self.proc.pid, self.port):
                    return self
                self._relaunch(f'port {self.port} answers from another process, see {self.log}')
                continue
            time.sleep(0.3)
        raise RuntimeError(f'core not up after {timeout}s, see {self.log}\n{self.tail()}')

    def stop(self, timeout=30):
        if not self.proc or self.proc.poll() is not None:
            return
        os.killpg(self.proc.pid, signal.SIGTERM)
        try:
            self.proc.wait(timeout)
        except subprocess.TimeoutExpired:
            os.killpg(self.proc.pid, signal.SIGKILL)
            self.proc.wait()


def copy_db(src: Path, dst: Path):
    """The snapshot's database directory, file by file (plaid.db, its WAL if
    any, the JWT secret the stored API tokens are signed with)."""
    dst.mkdir(parents=True, exist_ok=True)
    for name in ('plaid.db', 'plaid.db-wal', 'plaid.db-shm', 'jwt-secret.txt'):
        if (src / name).exists():
            shutil.copy2(src / name, dst / name)


def manifest():
    return json.loads((SNAPSHOT / 'manifest.json').read_text())


def client_for(url, user='A', tokens=None):
    from plaid_client import PlaidClient
    tokens = tokens or manifest()['tokens']
    return PlaidClient(url, tokens[user])


def kill_group(proc, timeout=15):
    if not proc or proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
    except ProcessLookupError:
        pass
