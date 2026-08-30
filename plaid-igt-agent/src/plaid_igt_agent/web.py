"""Looking things up outside the project: search, and reading a page.

Everything else the assistant reads is the user's own project. This is the one
place where text from strangers enters the turn, so the rules around it are
tighter than anywhere else in the service:

- The operator opts in. Without ``--web-search`` and a key the two tools are
  not offered to the model at all, and the prompt never mentions them.
- ``read_url`` only opens a URL that this turn's search returned or that the
  user pasted into the chat. The model cannot go somewhere nobody suggested.
- A fetch is guarded against being pointed back at the operator's own network
  (see :func:`check_url`). The service usually runs beside the Plaid server,
  so an arbitrary fetch would otherwise be a request-forgery primitive.
- What comes back is fenced and labelled as untrusted, and the workspace
  refuses to plan a change in a turn that read the web (see ``Workspace``).

HTML is reduced to its text with the standard library rather than a
readability package: the result feeds a model, which copes with a nav menu at
the top, and this stays a three-dependency package that ships in the jar.
PDFs are not read. Most linguistics references are PDFs, so the tool says so
plainly instead of letting the model guess at a title.
"""

import ipaddress
import re
import socket
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import List, Set
from urllib.parse import urlsplit, urlunsplit

import httpx

BACKENDS = ('brave', 'tavily')
SEARCH_TIMEOUT_S = 20
FETCH_TIMEOUT_S = 20
MAX_REDIRECTS = 5
MAX_BODY_BYTES = 2_000_000   # read this much of a page, then extract and truncate
MAX_RESULTS = 10
READABLE_TYPES = ('text/html', 'text/plain', 'application/xhtml+xml')
URL_RE = re.compile(r'https?://[^\s<>"\'`\])}]+', re.I)


class WebError(Exception):
    """A lookup that failed in a way the model should read and act on."""


@dataclass
class WebConfig:
    backend: str
    api_key: str
    #: Hosts a fetch must never reach, on top of every private address. The
    #: service is given its own Plaid URL, which may well be a public one.
    deny_hosts: tuple = ()


# --- where a fetch may go -------------------------------------------------------

def _addresses(host: str) -> List[ipaddress._BaseAddress]:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise WebError(f'"{host}" does not resolve ({e.strerror or e}).')
    return [ipaddress.ip_address(i[4][0]) for i in infos]


def check_url(url: str, cfg: WebConfig) -> str:
    """The URL to fetch, or raise. Rejects anything that is not plain http(s)
    and anything that resolves onto the machine or network the service runs
    on: loopback, private ranges, link-local (which includes the cloud
    metadata endpoint), and the operator's own Plaid server."""
    parts = urlsplit((url or '').strip())
    if parts.scheme.lower() not in ('http', 'https'):
        raise WebError(f'Only http and https URLs can be read, not "{parts.scheme or url}".')
    host = (parts.hostname or '').lower()
    if not host:
        raise WebError(f'"{url}" has no host.')
    if host in {h.lower() for h in cfg.deny_hosts}:
        raise WebError(f'"{host}" is this Plaid server; there is nothing to read there. '
                       'Use the project tools for project data.')
    for ip in _addresses(host):
        if ip.is_multicast or not ip.is_global:
            raise WebError(f'"{host}" resolves to {ip}, an address inside the network this service '
                           'runs on. Only public web pages can be read.')
    return urlunsplit((parts.scheme.lower(), parts.netloc, parts.path, parts.query, ''))


def canonical(url: str) -> str:
    """A URL reduced to what makes it the same page, for deciding whether one
    was offered: scheme and host lowercased, fragment dropped."""
    p = urlsplit((url or '').strip())
    return urlunsplit((p.scheme.lower(), (p.netloc or '').lower(), p.path.rstrip('/'), p.query, ''))


def urls_in(text: str) -> List[str]:
    """Every http(s) URL written in a piece of text, trailing punctuation
    trimmed (a URL at the end of a sentence keeps its period otherwise)."""
    return [m.group(0).rstrip('.,;:!?') for m in URL_RE.finditer(text or '')]


# --- reading a page --------------------------------------------------------------

class _Text(HTMLParser):
    """HTML to something a model can read: the title, then the text, with the
    furniture (scripts, navigation, forms) left out and blocks kept apart."""

    SKIP = {'script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside',
            'form', 'svg', 'template', 'iframe', 'button', 'select'}
    BREAK = {'p', 'br', 'div', 'section', 'article', 'li', 'tr', 'td', 'th', 'blockquote',
             'pre', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figcaption', 'dt', 'dd'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ''
        self._in_title = False
        self._skip = 0
        self._out: List[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        elif tag == 'title':
            self._in_title = True
        elif tag in self.BREAK:
            self._out.append('\n')

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self._skip = max(0, self._skip - 1)
        elif tag == 'title':
            self._in_title = False
        elif tag in self.BREAK:
            self._out.append('\n')

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            self._out.append(data)

    def text(self) -> str:
        joined = ''.join(self._out)
        lines = [re.sub(r'[ \t\xa0]+', ' ', ln).strip() for ln in joined.split('\n')]
        return re.sub(r'\n{3,}', '\n\n', '\n'.join(ln for ln in lines if ln))


def extract(html: str) -> tuple:
    """-> (title, text) from an HTML document."""
    p = _Text()
    try:
        p.feed(html)
        p.close()
    except Exception:  # noqa: BLE001 - a malformed page still yields whatever parsed
        pass
    return re.sub(r'\s+', ' ', p.title).strip(), p.text()


def _content_type(response) -> str:
    return (response.headers.get('content-type') or '').split(';')[0].strip().lower()


def fetch(url: str, cfg: WebConfig, client=None) -> tuple:
    """-> (final url, title, text). Redirects are followed by hand so that
    every hop is checked, not just the one the model named."""
    seen = check_url(url, cfg)
    owned = client is None
    client = client or httpx.Client(timeout=FETCH_TIMEOUT_S, follow_redirects=False)
    try:
        for _ in range(MAX_REDIRECTS + 1):
            try:
                with client.stream('GET', seen, headers={'User-Agent': 'plaid-igt-agent'}) as r:
                    if r.is_redirect:
                        target = r.headers.get('location')
                        if not target:
                            raise WebError(f'{seen} redirected without saying where.')
                        seen = check_url(str(httpx.URL(seen).join(target)), cfg)
                        continue
                    if r.status_code >= 400:
                        raise WebError(f'{seen} answered {r.status_code}.')
                    kind = _content_type(r)
                    if kind and kind not in READABLE_TYPES:
                        raise WebError(f'{seen} is {kind}, and this tool reads HTML and plain text only. '
                                       'Say so rather than guessing at what it contains.')
                    body = b''
                    capped = False
                    for chunk in r.iter_bytes():
                        body += chunk
                        if len(body) >= MAX_BODY_BYTES:
                            capped = True
                            break
                    text = body.decode(r.encoding or 'utf-8', errors='replace')
            except httpx.HTTPError as e:
                raise WebError(f'{seen} could not be read ({type(e).__name__}: {e}).')
            # A page longer than the cap is cut mid-document, so say so rather
            # than let the model read a half page as a whole one.
            note = '\n\n[This page is longer than the tool reads; only the beginning was fetched.]' if capped else ''
            if kind == 'text/plain':
                return seen, '', text.strip() + note
            title, out = extract(text)
            if not out.strip():
                raise WebError(f'{seen} has no readable text (it may be built entirely by scripts).')
            return seen, title, out + note
        raise WebError(f'{url} redirected more than {MAX_REDIRECTS} times.')
    finally:
        if owned:
            client.close()


# --- searching --------------------------------------------------------------------

@dataclass
class Result:
    title: str
    url: str
    snippet: str


def _brave(query: str, limit: int, cfg: WebConfig, client) -> List[Result]:
    r = client.get('https://api.search.brave.com/res/v1/web/search',
                   params={'q': query, 'count': limit},
                   headers={'Accept': 'application/json', 'X-Subscription-Token': cfg.api_key})
    if r.status_code == 401 or r.status_code == 403:
        raise WebError('The search provider rejected the key (Brave).')
    r.raise_for_status()
    hits = ((r.json() or {}).get('web') or {}).get('results') or []
    return [Result(h.get('title') or '', h.get('url') or '', h.get('description') or '') for h in hits]


def _tavily(query: str, limit: int, cfg: WebConfig, client) -> List[Result]:
    r = client.post('https://api.tavily.com/search',
                    json={'query': query, 'max_results': limit},
                    headers={'Authorization': f'Bearer {cfg.api_key}'})
    if r.status_code in (401, 403):
        raise WebError('The search provider rejected the key (Tavily).')
    r.raise_for_status()
    hits = (r.json() or {}).get('results') or []
    return [Result(h.get('title') or '', h.get('url') or '', h.get('content') or '') for h in hits]


_SEARCHERS = {'brave': _brave, 'tavily': _tavily}


def search(query: str, limit: int, cfg: WebConfig, client=None) -> List[Result]:
    query = (query or '').strip()
    if not query:
        raise WebError('Give something to search for.')
    owned = client is None
    client = client or httpx.Client(timeout=SEARCH_TIMEOUT_S, follow_redirects=True)
    try:
        return _SEARCHERS[cfg.backend](query, max(1, min(limit, MAX_RESULTS)), cfg, client)
    except httpx.HTTPStatusError as e:
        raise WebError(f'The search provider answered {e.response.status_code}.')
    except httpx.HTTPError as e:
        raise WebError(f'The search provider could not be reached ({type(e).__name__}: {e}).')
    finally:
        if owned:
            client.close()


# --- one turn's dealings with the web ---------------------------------------------

@dataclass
class WebSession:
    """The web tools' state for one request: the operator's configuration, and
    the URLs the model is allowed to open (what a search here returned, plus
    whatever the user pasted into the conversation)."""
    cfg: WebConfig
    offered: Set[str] = field(default_factory=set)
    #: True once anything from outside the project has entered this turn.
    read: bool = False

    def offer(self, urls) -> None:
        self.offered.update(canonical(u) for u in urls)

    def allowed(self, url: str) -> bool:
        return canonical(url) in self.offered

    def search(self, query: str, limit: int, client=None) -> List[Result]:
        results = search(query, limit, self.cfg, client)
        self.offer(r.url for r in results)
        self.read = True
        return results

    def fetch(self, url: str, client=None) -> tuple:
        if not self.allowed(url):
            raise WebError('That URL has not come up in this conversation. Only a page from a '
                           'web_search result, or one the user pasted, can be opened. Search for it '
                           'first, or ask the user for the link.')
        out = fetch(url, self.cfg, client)
        self.read = True
        return out


def session_for(cfg: WebConfig, transcript) -> WebSession:
    """A session for one request, already told which links the user shared. A
    link the user put in the conversation is one they chose to show the
    assistant, so it may be opened. Nothing else the model has not searched
    up itself may be."""
    s = WebSession(cfg)
    for m in transcript or []:
        if isinstance(m, dict) and m.get('role') == 'user':
            s.offer(urls_in(m.get('content') or ''))
    return s


def ping(cfg: WebConfig) -> int:
    """One real search, so a bad key or an unreachable provider is the
    operator's problem at startup rather than a user's mid-chat. -> hit count."""
    return len(search('interlinear glossed text', 3, cfg))
