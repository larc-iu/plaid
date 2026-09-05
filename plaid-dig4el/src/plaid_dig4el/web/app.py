"""dig4el's web application.

Server-rendered pages with htmx for the parts that update in place (a slot in the
questionnaire editor, a running inference's status). Every Plaid call is made with
the logged-in user's own token.
"""

from __future__ import annotations

import csv
import io
import json
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from markupsafe import Markup, escape
from plaid_client import PlaidClient
from plaid_client.http import PlaidAPIError

from ..config import settings
from .. import auth, catalog_store, db, documents, docx_export, explore, generation, jobs, plaid_gateway as gw, sentences, transcription_io
from ..inference import kg as kgmod, legacy_labels, pipeline, runner
from ..legacy import graphs_utils as graphs
from ..reference import catalog

HERE = Path(__file__).parent
app = FastAPI(title="dig4el", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
templates = Jinja2Templates(directory=HERE / "templates")


def asset(path: str) -> str:
    """A static asset URL stamped with the file's modification time, so a changed
    stylesheet or script is fetched afresh instead of served from the browser cache."""
    try:
        stamp = int((HERE / "static" / path).stat().st_mtime)
    except OSError:
        stamp = 0
    return f"/static/{path}?v={stamp}"


templates.env.globals.update(label=legacy_labels.label, catalog=catalog, asset=asset)


def emph(text: Any) -> Markup:
    """The models mark target-language words with ``**...**`` (and italics with ``*...*``),
    as dig4el's Streamlit pages rendered through Markdown. Escape, then render those."""
    import re

    escaped = str(escape(str(text or "")))
    escaped = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?![*\w])", r"<em>\1</em>", escaped)
    return Markup(escaped)


templates.env.filters["emph"] = emph


@app.on_event("startup")
def _startup() -> None:
    db.engine()
    catalog_store.install()
    jobs.start_worker()
    runner.preload_in_background()


# ------------------------------------------------------------------ helpers


class NeedsLogin(Exception):
    pass


@app.exception_handler(NeedsLogin)
async def _needs_login(request: Request, exc: NeedsLogin):
    if request.headers.get("HX-Request"):
        return Response(status_code=200, headers={"HX-Redirect": "/login"})
    return RedirectResponse("/login", status_code=303)


def current_user(request: Request) -> auth.User:
    user = auth.user_from_request(request)
    if user is None:
        raise NeedsLogin()
    return user


def viewer(request: Request) -> auth.User:
    """The logged-in user, or the guest account for a visitor who is not logged in
    (when an administrator has set one up). Read-only routes take this."""
    user = auth.user_from_request(request) or auth.guest_user()
    if user is None:
        raise NeedsLogin()
    return user


def render(request: Request, name: str, status_code: int = 200, **ctx: Any) -> HTMLResponse:
    ctx.setdefault("user", auth.user_from_request(request) or auth.guest_user())
    ctx["request"] = request
    return templates.TemplateResponse(request, name, ctx, status_code=status_code)


def redirect(url: str, request: Request | None = None) -> Response:
    if request is not None and request.headers.get("HX-Request"):
        return Response(status_code=200, headers={"HX-Redirect": url})
    return RedirectResponse(url, status_code=303)


class Access:
    """A language as one user sees it: the Plaid project and the user's role on it."""

    def __init__(self, user: auth.User, language: db.Language):
        self.user = user
        self.language = language
        self.client: PlaidClient = user.client()
        self.as_guest = user.is_guest
        try:
            self.project = self.client.projects.get(language.plaid_project_id)
        except PlaidAPIError as e:
            if e.status not in (403, 404):
                raise
            guest = auth.guest_user() if language.open_to_guests and not user.is_guest else None
            if guest is None:
                raise HTTPException(404, "This language is not available to you.")
            try:  # a logged-in reader of an opened language browses it as the guest does
                self.client = guest.client()
                self.project = self.client.projects.get(language.plaid_project_id)
                self.as_guest = True
            except PlaidAPIError:
                raise HTTPException(404, "This language is not available to you.")
        self.layers = gw.Layers.from_config(language.layers)

    def _in(self, key: str) -> bool:
        return self.user.id in (self.project.get(key) or [])

    @property
    def can_manage(self) -> bool:
        return not self.as_guest and (self.user.is_admin or self._in("maintainers"))

    @property
    def can_edit(self) -> bool:
        return not self.as_guest and (self.can_manage or self._in("writers"))

    @property
    def role(self) -> str:
        if self.as_guest:
            return "guest"
        if self.user.is_admin:
            return "admin"
        if self._in("maintainers"):
            return "caretaker"
        if self._in("writers"):
            return "contributor"
        return "member"

    def load_doc(self, document_id: str) -> gw.QuestionnaireDoc:
        doc = gw.read_questionnaire_document(self.client, document_id, self.layers)
        doc._layers = self.layers  # type: ignore[attr-defined]
        return doc


def get_language(s, language_id: str) -> db.Language:
    lang = s.get(db.Language, language_id)
    if lang is None:
        raise HTTPException(404, "Unknown language")
    return lang


def require_edit(access: Access) -> None:
    if not access.can_edit:
        raise HTTPException(403, "Only the language's caretakers can change its data.")


def require_manage(access: Access) -> None:
    if not access.can_manage:
        raise HTTPException(403, "Only the language's caretakers can do this.")


# --------------------------------------------------------------------- auth


@app.get("/login", response_class=HTMLResponse)
def login_form(request: Request):
    return render(request, "login.html", error=None)


@app.post("/login")
def login_submit(request: Request, user_id: str = Form(...), password: str = Form(...)):
    try:
        user = auth.login(user_id.strip(), password)
    except PlaidAPIError as e:
        msg = "Wrong email or password." if e.status in (401, 403) else f"Plaid is not reachable: {e}"
        return render(request, "login.html", error=msg)
    resp = redirect("/")
    resp.set_cookie(auth.COOKIE, auth.session_cookie_value(user), httponly=True, samesite="lax")
    return resp


@app.post("/logout")
def logout(request: Request):
    user = auth.user_from_request(request)
    if user:
        auth.logout(user)
    resp = redirect("/login")
    resp.delete_cookie(auth.COOKIE)
    return resp


# ---------------------------------------------------------------- languages


@app.get("/", response_class=HTMLResponse)
def languages_page(request: Request):
    user = viewer(request)
    client = user.client()
    try:
        projects = client.projects.list()
    except PlaidAPIError as e:
        if e.status == 401:
            raise NeedsLogin()
        raise
    if isinstance(projects, dict):
        projects = projects.get("entries", [])
    visible = {p["id"] for p in projects}
    guest_open = auth.guest_user() is not None
    with db.session() as s:
        languages = [l for l in s.query(db.Language).order_by(db.Language.name).all()
                     if (l.plaid_project_id in visible and (not user.is_guest or l.open_to_guests))
                     or (guest_open and not user.is_guest and l.open_to_guests)]
        rows = []
        for l in languages:
            latest = l.runs[0] if l.runs else None
            rows.append({"language": l, "documents": len(l.documents), "latest_run": latest})
    return render(request, "languages.html", rows=rows)


def reference_names(database: str) -> list[str]:
    """The language names one of the typological databases knows, sorted."""
    from ..reference import grambank as gu, wals as wu

    if database == "wals":
        return wu.language_names()
    if database == "grambank":
        return gu.language_names()
    raise HTTPException(404)


def match_names(names: list[str], q: str, limit: int = 15) -> list[str]:
    """Case-insensitive matches for a partial name, those starting with it first."""
    q = q.strip().casefold()
    if not q:
        return []
    starts = [n for n in names if n.casefold().startswith(q)]
    within = [n for n in names if q in n.casefold() and not n.casefold().startswith(q)]
    return (starts + within)[:limit]


@app.get("/reference/names", response_class=HTMLResponse)
def reference_name_matches(request: Request, database: str = "", wals_name: str = "", grambank_name: str = "",
                           q: str = ""):
    """Typeahead matches for the WALS or Grambank name fields (an htmx fragment)."""
    viewer(request)
    q = q or wals_name or grambank_name
    return render(request, "_names.html", q=q.strip(), names=match_names(reference_names(database), q))


def new_language_form(request: Request, values: dict[str, str] | None = None,
                      errors: dict[str, str] | None = None) -> HTMLResponse:
    values = {"pivot_language": "English", "delimiters": "".join(catalog.DEFAULT_DELIMITERS), **(values or {})}
    return render(request, "language_new.html", status_code=400 if errors else 200,
                  values=values, errors=errors or {})


@app.get("/languages/new", response_class=HTMLResponse)
def language_new(request: Request):
    current_user(request)
    return new_language_form(request)


@app.post("/languages")
async def language_create(
    request: Request,
    name: str = Form(...),
    glottocode: str = Form(""),
    wals_name: str = Form(""),
    grambank_name: str = Form(""),
    pivot_language: str = Form("English"),
    delimiters: str = Form(""),
    legacy_file: UploadFile | None = File(None),
):
    user = current_user(request)
    client = user.client()
    name = name.strip()
    wals_name = wals_name.strip()
    grambank_name = grambank_name.strip()
    values = {"name": name, "glottocode": glottocode, "wals_name": wals_name, "grambank_name": grambank_name,
              "pivot_language": pivot_language, "delimiters": delimiters}
    errors = {}
    if not name:
        errors["name"] = "A language needs a name."
    if wals_name and wals_name not in reference_names("wals"):
        errors["wals_name"] = "WALS has no language by this name. Pick one from the list, or leave it empty."
    if grambank_name and grambank_name not in reference_names("grambank"):
        errors["grambank_name"] = "Grambank has no language by this name. Pick one from the list, or leave it empty."
    if errors:
        return new_language_form(request, values, errors)
    delims = list(dict.fromkeys(delimiters)) if delimiters else catalog.delimiters_for(wals_name or name)
    identity = {"name": name, "glottocode": glottocode.strip(), "walsName": wals_name.strip(),
                "grambankName": grambank_name.strip(), "pivotLanguage": pivot_language.strip() or "English"}
    pid, layers = gw.create_language_project(client, name, identity)
    with db.session() as s:
        lang = db.Language(name=name, glottocode=identity["glottocode"], wals_name=identity["walsName"],
                           grambank_name=identity["grambankName"], pivot_language=identity["pivotLanguage"],
                           delimiters=delims, plaid_project_id=pid, layers=layers.to_config(),
                           created_by=user.id)
        s.add(lang)
        s.commit()
        lang_id = lang.id

    imported = 0
    if legacy_file is not None and legacy_file.filename:
        raw = await legacy_file.read()
        if raw.strip():
            data = json.loads(raw.decode("utf-8"))
            if isinstance(data, list):  # recording files
                kg = kgmod.from_recordings(data, name)
            else:  # a knowledge graph
                kg = {int(k) if str(k).isdigit() else k: v for k, v in data.items()}
            kg, _ = legacy_labels.update_knowledge_graph(kg)
            created = gw.import_legacy_kg(client, pid, layers, kg, delims, publish=True)
            with db.session() as s:
                for c in created:
                    s.add(db.QuestionnaireDocument(language_id=lang_id, questionnaire_uid=c["uid"],
                                                   plaid_document_id=c["id"]))
                s.commit()
            imported = len(created)
    return redirect(f"/languages/{lang_id}" + (f"?imported={imported}" if imported else ""))


@app.get("/languages/{language_id}", response_class=HTMLResponse)
def language_page(request: Request, language_id: str, imported: int | None = None):
    user = viewer(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        docs = []
        for ref in lang.documents:
            q = catalog.questionnaires().get(ref.questionnaire_uid)
            try:
                d = access.load_doc(ref.plaid_document_id)
                docs.append({"ref": ref, "q": q, "doc": d, "filled": sum(1 for x in d.slots if x.filled),
                             "total": len(d.slots), "missing": False, "reason": ""})
            except gw.DocumentUnavailable as e:
                docs.append({"ref": ref, "q": q, "doc": None, "filled": 0, "total": 0, "missing": True,
                             "reason": str(e)})
        present = {ref.questionnaire_uid for ref in lang.documents}
        available = [q for uid, q in catalog.questionnaires().items() if uid not in present]
        available.sort(key=lambda q: q.short_title)
        runs = [{"run": r, "stale": r.status == "done" and _run_is_stale(r, docs)} for r in lang.runs]
        published = sum(1 for d in docs if d["doc"] and d["doc"].published and d["filled"])
        corpora = []
        for ref in lang.corpora:
            try:
                d = access.load_doc(ref.plaid_document_id)
                corpora.append({"ref": ref, "doc": d, "missing": False, "reason": "",
                                "sentences": sum(1 for x in d.slots if x.filled)})
            except gw.DocumentUnavailable as e:
                corpora.append({"ref": ref, "doc": None, "missing": True, "reason": str(e), "sentences": 0})
        pool_size = sum(1 for d in docs + corpora if d["doc"]
                        for x in d["doc"].slots if x.filled and x.fields.get("prompt", (None, ""))[1].strip())
        augmented = s.query(db.SentenceAugmentation).filter_by(language_id=lang.id).count()
        augment_job = _latest_job(s, "augment", lang.id)
        layer_status = gw.check_layers(access.project, access.layers)
        outputs = list(lang.outputs)
        generate_job = _latest_job(s, "generate", lang.id)
        has_approved = any(r.approved for r in lang.runs)
        files = [{"doc": d, "chunks": len(d.chunks)} for d in lang.reference_documents]
        index_job = _latest_job(s, "index_documents", lang.id)
    return render(request, "language.html", lang=lang, access=access, docs=docs, available=available,
                  runs=runs, imported=imported, published=published, corpora=corpora,
                  pool_size=pool_size, augmented=augmented, augment_job=augment_job,
                  outputs=outputs, generate_job=generate_job, has_approved=has_approved,
                  files=files, index_job=index_job, layer_status=layer_status,
                  repaired=request.query_params.get("repaired", ""),
                  lesson_topics=list(generation.lesson_seeds()), sketch_topics=generation.SKETCH_TOPICS,
                  readers_languages=generation.READERS_LANGUAGES, readers_types=generation.READERS_TYPES)


def _latest_job(s, kind: str, language_id: str) -> db.Job | None:
    for job in s.query(db.Job).filter_by(kind=kind).order_by(db.Job.created_at.desc()).limit(50):
        if job.payload.get("language_id") == language_id:
            return job
    return None


def _run_is_stale(run: db.InferenceRun, docs: list[dict]) -> bool:
    """True when the published translations differ from what the run read: a document
    changed version (Plaid bumps it on any edit inside), was published or unpublished,
    went missing, or was added since."""
    seen = {d["id"]: d for d in (run.inputs or {}).get("documents", [])}
    for d in docs:
        if d["missing"]:
            was = seen.get(d["ref"].plaid_document_id)
            if was and was.get("published") and not was.get("missing"):
                return True
            continue
        doc = d["doc"]
        was = seen.get(doc.id)
        if was is None:
            if doc.published and d["filled"]:
                return True
            continue
        if was.get("missing") or bool(was.get("published")) != doc.published:
            return True
        if doc.published and was.get("version") != doc.version:
            return True
    return False


@app.post("/languages/{language_id}/documents/{document_id}/forget")
def questionnaire_forget(request: Request, language_id: str, document_id: str):
    """Drop the reference to a questionnaire document that no longer exists in Plaid."""
    user = current_user(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_manage(access)
        for ref in list(lang.documents) + list(lang.corpora):
            if ref.plaid_document_id == document_id:
                s.delete(ref)
        s.commit()
    return redirect(f"/languages/{language_id}", request)


# ---------------------------------------------------------------- sentence pairs


def parse_pairs(filename: str, raw: bytes) -> list[dict[str, str]]:
    """dig4el's sentence-pair files: a JSON list of {source, target, comments} or a CSV
    with those columns. Rows missing either side are dropped."""
    text = raw.decode("utf-8-sig")
    if filename.lower().endswith(".json"):
        data = json.loads(text)
        if not isinstance(data, list):
            raise HTTPException(400, "A sentence-pair file is a JSON list of objects with source and target.")
        rows = [r for r in data if isinstance(r, dict)]
    else:
        reader = csv.DictReader(io.StringIO(text))
        rows = [{(k or "").strip().lower(): (v or "") for k, v in r.items()} for r in reader]
    pairs = []
    for r in rows:
        source, target = str(r.get("source") or "").strip(), str(r.get("target") or "").strip()
        if source and target:
            pairs.append({"source": source, "target": target, "comments": str(r.get("comments") or "").strip()})
    if not pairs:
        raise HTTPException(400, "No row had both a source and a target sentence.")
    return pairs


@app.post("/languages/{language_id}/corpora")
async def corpus_add(request: Request, language_id: str, name: str = Form(...), origin: str = Form(""),
                     author: str = Form(""), file: UploadFile = File(...)):
    user = current_user(request)
    raw = await file.read()
    pairs = parse_pairs(file.filename or "", raw)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_edit(access)
        doc = gw.create_corpus_document(access.client, lang.plaid_project_id, access.layers, name.strip(),
                                        {"origin": origin.strip(), "author": author.strip()}, pairs,
                                        lang.delimiters or catalog.DEFAULT_DELIMITERS)
        s.add(db.CorpusDocument(language_id=lang.id, plaid_document_id=doc["id"], name=name.strip(),
                                origin=origin.strip(), author=author.strip(), created_by=user.id))
        s.commit()
    return redirect(f"/languages/{language_id}/documents/{doc['id']}", request)


@app.post("/languages/{language_id}/augment")
def augment_start(request: Request, language_id: str, model: str = Form("")):
    user = current_user(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_edit(access)
        running = _latest_job(s, "augment", lang.id)
        if running is not None and running.status in ("queued", "running"):
            return redirect(f"/languages/{language_id}", request)
        job = jobs.enqueue(s, "augment", {"language_id": lang.id, "model": model.strip()}, user.id, user.token)
        s.commit()
        job_id = job.id
    jobs.submit(job_id)
    return redirect(f"/languages/{language_id}", request)


@app.get("/languages/{language_id}/jobs/{job_id}/status", response_class=HTMLResponse)
def job_status(request: Request, language_id: str, job_id: str):
    current_user(request)
    with db.session() as s:
        job = s.get(db.Job, job_id)
        if job is None:
            raise HTTPException(404)
        if job.status in ("done", "failed"):
            target = f"/languages/{language_id}"
            if job.kind == "generate" and job.status == "done" and job.payload.get("output_id"):
                target = f"/languages/{language_id}/outputs/{job.payload['output_id']}"
            return Response(status_code=200, headers={"HX-Redirect": target})
    return render(request, "_job_status.html", job=job, language_id=language_id)


# --------------------------------------------------------- reference documents


def _start_indexing(s, lang: db.Language, user: auth.User) -> str | None:
    running = _latest_job(s, "index_documents", lang.id)
    if running is not None and running.status in ("queued", "running"):
        return None
    job = jobs.enqueue(s, "index_documents", {"language_id": lang.id}, user.id, user.token)
    s.commit()
    return job.id


@app.post("/languages/{language_id}/files")
async def file_add(request: Request, language_id: str, title: str = Form(""), description: str = Form(""),
                   file: UploadFile = File(...)):
    user = current_user(request)
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "The file is empty.")
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_edit(access)
    documents.add_document(lang.id, Path(file.filename or "document").name, raw, title.strip(),
                           description.strip(), user.id)
    with db.session() as s:
        lang = get_language(s, language_id)
        job_id = _start_indexing(s, lang, user)
    if job_id:
        jobs.submit(job_id)
    return redirect(f"/languages/{language_id}", request)


@app.post("/languages/{language_id}/files/index")
def files_index(request: Request, language_id: str):
    user = current_user(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_edit(access)
        for d in lang.reference_documents:
            if d.status == "failed" and d.text:
                d.status = "uploaded"
        job_id = _start_indexing(s, lang, user)
    if job_id:
        jobs.submit(job_id)
    return redirect(f"/languages/{language_id}", request)


@app.get("/languages/{language_id}/files/{file_id}/download")
def file_download(request: Request, language_id: str, file_id: str):
    user = viewer(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        Access(user, lang)
        doc = s.get(db.ReferenceDocument, file_id)
        if doc is None or doc.language_id != lang.id:
            raise HTTPException(404)
        path = documents.stored_path(doc)
        filename = doc.filename
    if not path.exists():
        raise HTTPException(404, "The file is no longer on the server.")
    return StreamingResponse(open(path, "rb"), media_type="application/octet-stream",
                             headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.post("/languages/{language_id}/files/{file_id}/delete")
def file_delete(request: Request, language_id: str, file_id: str):
    user = current_user(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_edit(access)
        doc = s.get(db.ReferenceDocument, file_id)
        if doc is None or doc.language_id != lang.id:
            raise HTTPException(404)
    documents.remove_document(file_id)
    return redirect(f"/languages/{language_id}", request)


@app.post("/languages/{language_id}/files/search", response_class=HTMLResponse)
def files_search(request: Request, language_id: str, query: str = Form("")):
    user = viewer(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        Access(user, lang)
    hits = documents.retrieve(lang.id, query.strip(), k=6) if query.strip() else []
    return render(request, "_file_search.html", lang=lang, query=query.strip(), hits=hits)


# ------------------------------------------------------------ grammar outputs


@app.post("/languages/{language_id}/generate")
def generate_start(request: Request, language_id: str, format: str = Form("lesson"),
                   readers_language: str = Form("English"), readers_type: str = Form("Adults"),
                   topic_standard: str = Form(""), topic_custom: str = Form(""), model: str = Form(""),
                   polish: str = Form(""), use_cq: str = Form("1"), use_pairs: str = Form("1"),
                   use_documents: str = Form("1")):
    user = current_user(request)
    topic = topic_custom.strip() or topic_standard.strip()
    if not topic:
        raise HTTPException(400, "Choose a topic or type one.")
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_edit(access)
        running = _latest_job(s, "generate", lang.id)
        if running is not None and running.status in ("queued", "running"):
            return redirect(f"/languages/{language_id}", request)
        payload = {"language_id": lang.id, "format": "sketch" if format == "sketch" else "lesson",
                   "readers_language": readers_language, "readers_type": "Linguists" if format == "sketch" else readers_type,
                   "topic": topic, "model": model.strip(), "polish": bool(polish),
                   "use_cq": bool(use_cq), "use_pairs": bool(use_pairs), "use_documents": bool(use_documents)}
        job = jobs.enqueue(s, "generate", payload, user.id, user.token)
        s.commit()
        job_id = job.id
    jobs.submit(job_id)
    return redirect(f"/languages/{language_id}", request)


def _output(s, language_id: str, output_id: str) -> db.GrammarOutput:
    out = s.get(db.GrammarOutput, output_id)
    if out is None or out.language_id != language_id:
        raise HTTPException(404, "Unknown output")
    return out


@app.get("/languages/{language_id}/outputs/{output_id}", response_class=HTMLResponse)
def output_page(request: Request, language_id: str, output_id: str):
    user = viewer(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        out = _output(s, language_id, output_id)
        feedback = list(out.feedback)
    return render(request, "output.html", lang=lang, access=access, out=out, feedback=feedback)


@app.get("/languages/{language_id}/outputs/{output_id}/json")
def output_json(request: Request, language_id: str, output_id: str):
    user = viewer(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        Access(user, lang)
        out = _output(s, language_id, output_id)
    return JSONResponse(out.output, headers={"Content-Disposition": f'attachment; filename="{_output_filename(out)}.json"'})


@app.get("/languages/{language_id}/outputs/{output_id}/docx")
def output_docx(request: Request, language_id: str, output_id: str):
    user = viewer(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        Access(user, lang)
        out = _output(s, language_id, output_id)
    buf = docx_export.lesson_docx(out.output, lang.name, out.readers_language)
    return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                             headers={"Content-Disposition": f'attachment; filename="{_output_filename(out)}.docx"'})


def _output_filename(out: db.GrammarOutput) -> str:
    stem = "".join(ch if ch.isalnum() else "_" for ch in out.topic)[:50].strip("_")
    return f"dig4el_{out.format}_{stem}_{out.readers_language}_{out.created_at.strftime('%Y%m%d_%H%M')}"


@app.post("/languages/{language_id}/outputs/{output_id}/feedback")
def output_feedback(request: Request, language_id: str, output_id: str, errors: int = Form(0),
                    completeness: int = Form(0), clarity: int = Form(0), usefulness: int = Form(0),
                    confidence: int = Form(0), comments: str = Form("")):
    user = current_user(request)
    if user.is_guest:
        raise HTTPException(403, "Log in to give feedback.")
    with db.session() as s:
        lang = get_language(s, language_id)
        Access(user, lang)
        out = _output(s, language_id, output_id)
        s.add(db.OutputFeedback(output_id=out.id, user_id=user.id, errors=errors, completeness=completeness,
                                clarity=clarity, usefulness=usefulness, confidence=confidence,
                                comments=comments.strip()))
        s.commit()
    return redirect(f"/languages/{language_id}/outputs/{output_id}", request)


@app.post("/languages/{language_id}/search", response_class=HTMLResponse)
def sentence_search(request: Request, language_id: str, query: str = Form(""), how: str = Form("keyword")):
    user = viewer(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        Access(user, lang)
        rows = s.query(db.SentenceAugmentation).filter_by(language_id=lang.id).all()
    query = query.strip()
    hits: list[sentences.Hit] = []
    if user.is_guest and how == "model":
        how = "keyword"
    if query:
        if how == "embedding":
            hits = sentences.embedding_hits(rows, query)
        elif how == "model":
            hits = sentences.model_selection(rows, query)
        else:
            hits = sentences.keyword_hits(rows, query, lang.delimiters or catalog.DEFAULT_DELIMITERS)[:50]
    return render(request, "_search.html", lang=lang, query=query, how=how, hits=hits)


@app.post("/languages/{language_id}/questionnaires")
def questionnaire_add(request: Request, language_id: str, uid: str = Form(...)):
    user = current_user(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_edit(access)
        q = catalog.questionnaires().get(uid)
        if q is None:
            raise HTTPException(400, "Unknown questionnaire")
        if any(r.questionnaire_uid == uid for r in lang.documents):
            return redirect(f"/languages/{language_id}", request)
        doc = gw.create_questionnaire_document(access.client, lang.plaid_project_id, access.layers, q)
        s.add(db.QuestionnaireDocument(language_id=lang.id, questionnaire_uid=uid, plaid_document_id=doc["id"]))
        s.commit()
    return redirect(f"/languages/{language_id}/documents/{doc['id']}", request)


@app.post("/languages/{language_id}/documents/{document_id}/publish")
def document_publish(request: Request, language_id: str, document_id: str, published: str = Form("")):
    user = current_user(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_edit(access)
        gw.set_published(access.client, document_id, published == "1")
    return redirect(f"/languages/{language_id}", request)


# ------------------------------------------------------------------- editor


def _editor_context(access: Access, lang: db.Language, doc: gw.QuestionnaireDoc) -> dict:
    """The editor's rows: for a questionnaire, in questionnaire order with the segments
    whose slot is gone and foreign sentence tokens last; for a corpus, the slots with
    their augmentations."""
    q = catalog.questionnaires().get(doc.questionnaire) if doc.kind == "questionnaire" else None
    rows: list[tuple[str, Any]] = []
    if q:
        for seg in q.segments:
            slot = doc.slot(seg.index)
            rows.append(("slot", slot) if slot else ("missing", seg))
        rows.extend(("slot", s) for s in doc.extra_slots)
    else:
        rows = [("slot", s) for s in doc.slots]
    return {"lang": lang, "access": access, "doc": doc, "q": q, "rows": rows,
            "aug": _augmentations(doc), "corpus": _corpus_ref(lang, doc)}


def _augmentations(doc: gw.QuestionnaireDoc) -> dict[str, db.SentenceAugmentation]:
    with db.session() as s:
        return {a.token_id: a for a in s.query(db.SentenceAugmentation).filter_by(document_id=doc.id).all()}


def _corpus_ref(lang: db.Language, doc: gw.QuestionnaireDoc) -> db.CorpusDocument | None:
    with db.session() as s:  # the language may be detached by now
        return s.query(db.CorpusDocument).filter_by(plaid_document_id=doc.id).one_or_none()


def meanings_of(doc: gw.QuestionnaireDoc, slot: gw.Slot, aug: dict[str, db.SentenceAugmentation]) -> list[str]:
    """The meanings a slot links words to: a questionnaire segment's expected concepts,
    or a corpus sentence's key translation concepts plus any meaning already linked."""
    if doc.kind == "questionnaire":
        return slot.segment.expected_concepts() if slot.segment else []
    a = aug.get(slot.token_id)
    out = list(a.key_translation_concepts) if a else []
    out += [c["value"] for c in slot.concepts if c["value"] not in out]
    return out


# Twenty hues a golden angle apart, dark enough for white text.
PALETTE = [f"hsl({(i * 137) % 360} 58% 38%)" for i in range(20)]


def concept_colors(concepts: list[str]) -> dict[str, str]:
    """A color per concept: the same everywhere for the same concept (a hash of its id
    picks it), distinct within one sentence (a collision moves to the next free color)."""
    taken: set[int] = set()
    out: dict[str, str] = {}
    for c in sorted(concepts):
        i = zlib.crc32(c.encode()) % len(PALETTE)
        while i in taken and len(taken) < len(PALETTE):
            i = (i + 1) % len(PALETTE)
        taken.add(i)
        out[c] = PALETTE[i]
    return out


class SlotView:
    """What the linking panel needs: which concepts each word carries, which words each
    concept has, a color per concept, and the concept currently being linked (the first
    one without words unless the caller says otherwise)."""

    def __init__(self, slot: gw.Slot, active: str | None = None, expected: list[str] | None = None):
        seg = slot.segment
        self.concepts: list[str] = expected if expected is not None else (seg.expected_concepts() if seg else [])
        form_of = {w["id"]: w["form"] for w in slot.words}
        order = {w["id"]: i for i, w in enumerate(slot.words)}
        self.by_word: dict[str, list[str]] = {}
        self.by_concept: dict[str, list[str]] = {}
        for sp in slot.concepts:
            toks = sorted(sp["tokens"], key=lambda t: order.get(t, 0))
            self.by_concept.setdefault(sp["value"], []).extend(form_of[t] for t in toks if t in form_of)
            for t in toks:
                self.by_word.setdefault(t, []).append(sp["value"])
        if active in self.concepts:
            self.active = active
        else:
            self.active = next((c for c in self.concepts if not self.by_concept.get(c)),
                               self.concepts[0] if self.concepts else "")
        self.colors = concept_colors(list(set(self.concepts) | set(self.by_concept)))


def _attach_views(doc: gw.QuestionnaireDoc, active: str | None = None, segment: str | None = None,
                  aug: dict[str, db.SentenceAugmentation] | None = None) -> None:
    aug = aug if aug is not None else _augmentations(doc)
    for s in doc.slots:
        s.view = SlotView(s, active if segment is None or s.segment_index == segment else None,  # type: ignore[attr-defined]
                          expected=meanings_of(doc, s, aug))


@app.get("/languages/{language_id}/documents/{document_id}", response_class=HTMLResponse)
def editor_page(request: Request, language_id: str, document_id: str):
    user = viewer(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        doc = access.load_doc(document_id)
    ctx = _editor_context(access, lang, doc)
    _attach_views(doc, aug=ctx["aug"])
    return render(request, "corpus.html" if doc.kind == "corpus" else "questionnaire.html", **ctx)


def _slot_response(request: Request, access: Access, lang: db.Language, document_id: str, segment: str,
                   active: str | None = None):
    doc = access.load_doc(document_id)
    slot = doc.slot(segment)
    if slot is None:
        raise HTTPException(404, "No such segment")
    ctx = _editor_context(access, lang, doc)
    _attach_views(doc, active, segment, aug=ctx["aug"])
    return render(request, "_pair.html" if doc.kind == "corpus" else "_slot.html", slot=slot, seg=slot.segment, **ctx)


@app.get("/languages/{language_id}/documents/{document_id}/slots/{segment}", response_class=HTMLResponse)
def slot_get(request: Request, language_id: str, document_id: str, segment: str, active: str | None = None):
    user = viewer(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
    return _slot_response(request, access, lang, document_id, segment, active)


@app.post("/languages/{language_id}/documents/{document_id}/slots/{segment}/translation",
          response_class=HTMLResponse)
def slot_translation(request: Request, language_id: str, document_id: str, segment: str,
                     text: str = Form(""), alternate_pivot: str = Form(""),
                     back_translation: str = Form(""), note: str = Form(""), source: str | None = Form(None)):
    user = current_user(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_edit(access)
        doc = access.load_doc(document_id)
        slot = doc.slot(segment)
        if slot is None:
            raise HTTPException(404, "No such segment")
        fields = {"alternate_pivot": alternate_pivot, "back_translation": back_translation, "note": note}
        if doc.kind == "corpus":
            fields = {"note": note}
            if source is not None:
                fields["prompt"] = source
        text = text.replace("\n", " ").strip()
        if text != slot.text:
            gw.fill_slot(access.client, doc, slot, text, lang.delimiters or catalog.DEFAULT_DELIMITERS,
                         fields=fields, description=f"Translate segment {segment} of {doc.name}")
        else:
            with access.client.operation(f"Edit fields of segment {segment} of {doc.name}"):
                gw.write_fields(access.client, doc, slot, fields)
    return _slot_response(request, access, lang, document_id, segment)


@app.post("/languages/{language_id}/documents/{document_id}/slots/{segment}/restore")
def slot_restore(request: Request, language_id: str, document_id: str, segment: str):
    user = current_user(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_edit(access)
    doc = access.load_doc(document_id)
    q = catalog.questionnaires().get(doc.questionnaire)
    seg = q.segment(segment) if q else None
    if seg is None or doc.slot(segment) is not None:
        raise HTTPException(400, "Nothing to restore")
    gw.restore_slot(access.client, doc, seg)
    return redirect(f"/languages/{language_id}/documents/{document_id}#slot-{segment}", request)


@app.post("/languages/{language_id}/documents/{document_id}/slots/{segment}/augmentation",
          response_class=HTMLResponse)
async def slot_augmentation(request: Request, language_id: str, document_id: str, segment: str):
    """Edit what the model said about a corpus sentence: description, keywords, comment,
    and the meanings (rename, add, remove), as dig4el's step 3 allowed."""
    user = current_user(request)
    form = await request.form()
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_edit(access)
        doc = access.load_doc(document_id)
        slot = doc.slot(segment)
        if slot is None:
            raise HTTPException(404, "No such segment")
        a = s.query(db.SentenceAugmentation).filter_by(token_id=slot.token_id).one_or_none()
        if a is None:
            a = db.SentenceAugmentation(language_id=lang.id, document_id=doc.id, token_id=slot.token_id,
                                        source=slot.fields.get("prompt", (None, ""))[1], target=slot.text)
            s.add(a)
        if "description" in form:
            a.description = str(form.get("description") or "").strip()
            a.keywords = [k.strip() for k in str(form.get("keywords") or "").split(",") if k.strip()]
            a.comment = str(form.get("comment") or "").strip()
        concepts = list(a.key_translation_concepts)
        renames: dict[str, str] = {}
        for key, value in form.multi_items():
            if key.startswith("concept__"):
                old = key[len("concept__"):]
                new = str(value).strip()
                if old in concepts:
                    if new and new != old:
                        renames[old] = new
                        concepts[concepts.index(old)] = new
                    elif not new:
                        concepts.remove(old)
        new_concept = str(form.get("new_concept") or "").strip()
        if new_concept and new_concept not in concepts:
            concepts.append(new_concept)
        a.key_translation_concepts = concepts
        a.edited_by = user.id
        s.commit()
        if renames:
            with access.client.operation(f"Rename meanings in sentence {segment} of {doc.name}"):
                for old, new in renames.items():
                    gw.rename_concept(access.client, slot, old, new)
    return _slot_response(request, access, lang, document_id, segment)


@app.post("/languages/{language_id}/documents/{document_id}/slots/{segment}/link",
          response_class=HTMLResponse)
def slot_link(request: Request, language_id: str, document_id: str, segment: str,
              concept: str = Form(""), word: str = Form(...)):
    """Toggle one word in or out of one concept's link."""
    user = current_user(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_edit(access)
        doc = access.load_doc(document_id)
        slot = doc.slot(segment)
        if slot is None or (doc.kind == "questionnaire" and slot.segment is None):
            raise HTTPException(404, "No such segment")
        if not doc.can_link:
            raise HTTPException(409, "The Concept layer was removed in Plaid, so meanings cannot be linked.")
        if concept not in meanings_of(doc, slot, _augmentations(doc)):
            return _slot_response(request, access, lang, document_id, segment)
        current = next((sp for sp in slot.concepts if sp["value"] == concept), None)
        tokens = set(current["tokens"]) if current else set()
        tokens ^= {word}
        ordered = [w["id"] for w in slot.words if w["id"] in tokens]
        gw.set_concepts(access.client, doc, slot, {concept: ordered})
    return _slot_response(request, access, lang, document_id, segment, active=concept)


# ---------------------------------------------------------------- inference


@app.post("/languages/{language_id}/inference")
def inference_start(request: Request, language_id: str):
    user = current_user(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_edit(access)
        run = runner.start_run(s, lang, user.id, user.token)
        s.commit()
        run_id, job_id = run.id, run.job_id
    jobs.submit(job_id)
    return redirect(f"/languages/{language_id}/runs/{run_id}", request)


def _run_view(run: db.InferenceRun, show_all: bool) -> dict:
    report = run.report or {}
    params = report.get("parameters", [])
    by_topic = report.get("discovery", {}).get("by_topic", {})
    topic_of = {}
    for topic, plist in by_topic.items():
        for p in plist:
            topic_of.setdefault(p, topic)
    overrides = run.overrides or {}
    groups: dict[str, list] = {}
    for p in params:
        if not show_all and not p["retained"] and p["parameter"] not in overrides:
            continue
        row = dict(p)
        ov = overrides.get(p["parameter"])
        if ov:
            row["origin"] = "caretaker"
            row["winner_code"] = ov["code"]
            row["winner"] = ov["name"]
        groups.setdefault(topic_of.get(p["parameter"], "Other"), []).append(row)
    ordered = [(t, groups[t]) for t in by_topic if t in groups] + [(t, g) for t, g in groups.items() if t not in by_topic]
    counts = {
        "parameters": len(params),
        "retained": sum(1 for p in params if p["retained"]),
        "known": sum(1 for p in params if p["origin"] == "known"),
        "observed": sum(1 for p in params if p["origin"] == "observed"),
        "inferred": sum(1 for p in params if p["origin"] == "inferred"),
    }
    return {"groups": ordered, "counts": counts, "evidence": report.get("observations", {}).get("evidence", {}),
            "known": report.get("known", {}), "sentences": report.get("sentences", 0)}


@app.get("/languages/{language_id}/runs/{run_id}", response_class=HTMLResponse)
def run_page(request: Request, language_id: str, run_id: str, all: int = 0):
    user = viewer(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        run = s.get(db.InferenceRun, run_id)
        if run is None or run.language_id != lang.id:
            raise HTTPException(404, "Unknown run")
        view = _run_view(run, bool(all)) if run.status == "done" else None
    return render(request, "run.html", lang=lang, access=access, run=run, view=view, show_all=bool(all))


@app.get("/languages/{language_id}/runs/{run_id}/status", response_class=HTMLResponse)
def run_status(request: Request, language_id: str, run_id: str):
    viewer(request)
    with db.session() as s:
        run = s.get(db.InferenceRun, run_id)
        if run is None:
            raise HTTPException(404)
        if run.status in ("done", "failed"):
            return Response(status_code=200, headers={"HX-Redirect": f"/languages/{language_id}/runs/{run_id}"})
        started = run.created_at
    elapsed = int((datetime.now(timezone.utc) - started.replace(tzinfo=timezone.utc)).total_seconds())
    return render(request, "_run_status.html", run_status=run.status, elapsed=elapsed,
                  language_id=language_id, run_id=run_id)


@app.post("/languages/{language_id}/runs/{run_id}/override")
def run_override(request: Request, language_id: str, run_id: str, parameter: str = Form(...),
                 code: str = Form(...)):
    user = current_user(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_edit(access)
        run = s.get(db.InferenceRun, run_id)
        if run is None or run.approved:
            raise HTTPException(400, "This run cannot be changed.")
        param = next((p for p in run.report.get("parameters", []) if p["parameter"] == parameter), None)
        if param is None:
            raise HTTPException(404, "Unknown parameter")
        overrides = dict(run.overrides or {})
        if code == param["winner_code"]:
            overrides.pop(parameter, None)
        else:
            overrides[parameter] = {"code": code, "name": param["beliefs"][code]["name"], "by": user.id,
                                    "at": db.now().isoformat()}
        run.overrides = overrides
        s.commit()
    return redirect(f"/languages/{language_id}/runs/{run_id}", request)


@app.post("/languages/{language_id}/runs/{run_id}/approve")
def run_approve(request: Request, language_id: str, run_id: str):
    user = current_user(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_manage(access)
        run = s.get(db.InferenceRun, run_id)
        if run is None or run.status != "done":
            raise HTTPException(400, "Only a finished run can be approved.")
        run.approved_by = user.id
        run.approved_at = db.now()
        s.commit()
    return redirect(f"/languages/{language_id}/runs/{run_id}", request)


# ---------------------------------------------------------- catalog editors
# dig4el's "expert features": the concept graph editor and the questionnaire editor.


def require_admin(user: auth.User) -> None:
    if not user.is_admin:
        raise HTTPException(403, "Only administrators can change the catalog.")


def _concept_names(cg: dict) -> list[str]:
    return sorted(cg.keys(), key=str.lower)


@app.get("/catalog/concepts", response_class=HTMLResponse)
def concepts_page(request: Request, focus: str = "INTELLECT"):
    user = viewer(request)
    cg = catalog.concepts()
    if focus not in cg:
        focus = next(iter(cg)) if cg else ""
    node = cg.get(focus, {})
    parent = node.get("ontological parent", "self")
    children = sorted(graphs.get_children(cg, focus), key=str.lower) if focus else []
    inherited = sorted(graphs.inherit_required_features(cg, focus), key=str.lower) if focus else []
    lineage = list(reversed(graphs.get_genealogy(cg, focus))) if focus and focus in cg else []
    return render(request, "concepts.html", user=user, cg=cg, names=_concept_names(cg) + ["self"], focus=focus,
                  node=node, parent=parent, children=children, inherited=inherited, lineage=lineage)


@app.post("/catalog/concepts")
async def concept_create(request: Request):
    user = current_user(request)
    require_admin(user)
    form = await request.form()
    name = str(form.get("name") or "").strip()
    cg = dict(catalog.concepts())
    if not name or name in cg:
        raise HTTPException(400, "A new concept needs a name that is not taken.")
    cg[name] = {"description": str(form.get("description") or "").strip(), "type": "concept",
                "ontological parent": str(form.get("parent") or "self"),
                "gramprop": [x for x in form.getlist("gramprop") if x], "requires": [x for x in form.getlist("requires") if x]}
    catalog_store.save_concepts(cg, user.id)
    return redirect(f"/catalog/concepts?focus={name}", request)


@app.post("/catalog/concepts/{name}/edit")
async def concept_edit(request: Request, name: str):
    """Edit a concept as dig4el's editor did, renaming references across the graph."""
    user = current_user(request)
    require_admin(user)
    form = await request.form()
    cg = {k: dict(v) for k, v in catalog.concepts().items()}
    if name not in cg:
        raise HTTPException(404)
    new_name = str(form.get("new_name") or name).strip() or name
    cg[name].update({"description": str(form.get("description") or "").strip(), "type": "concept",
                     "ontological parent": str(form.get("parent") or "self"),
                     "gramprop": [x for x in form.getlist("gramprop") if x],
                     "requires": [x for x in form.getlist("requires") if x]})
    if new_name != name:
        if new_name in cg:
            raise HTTPException(400, "That name is taken.")
        cg[new_name] = cg.pop(name)
        for c in cg.values():
            if c.get("ontological parent") == name:
                c["ontological parent"] = new_name
            c["requires"] = [new_name if r == name else r for r in c.get("requires", [])]
            c["gramprop"] = [new_name if r == name else r for r in c.get("gramprop", [])]
    catalog_store.save_concepts(cg, user.id)
    return redirect(f"/catalog/concepts?focus={new_name}", request)


@app.post("/catalog/concepts/{name}/delete")
def concept_delete(request: Request, name: str):
    user = current_user(request)
    require_admin(user)
    cg = {k: dict(v) for k, v in catalog.concepts().items()}
    if name not in cg:
        raise HTTPException(404)
    if graphs.get_children(cg, name):
        raise HTTPException(400, "This concept has children; delete them first.")
    parent = cg[name].get("ontological parent", "INTELLECT")
    del cg[name]
    catalog_store.save_concepts(cg, user.id)
    return redirect(f"/catalog/concepts?focus={parent if parent in cg else 'INTELLECT'}", request)


@app.get("/catalog/questionnaires", response_class=HTMLResponse)
def questionnaires_page(request: Request):
    user = viewer(request)
    rows = []
    for uid, raw in catalog.raw_questionnaires().items():
        dialog = raw.get("dialog", {})
        with_graph = sum(1 for d in dialog.values() if d.get("graph"))
        rows.append({"uid": uid, "raw": raw, "short_title": catalog.titles().get(uid, raw.get("title", uid)),
                     "segments": len(dialog), "with_graph": with_graph})
    rows.sort(key=lambda r: r["short_title"])
    return render(request, "questionnaires.html", user=user, rows=rows)


@app.post("/catalog/questionnaires")
def questionnaire_create(request: Request, title: str = Form(...)):
    user = current_user(request)
    require_admin(user)
    uid = catalog_store.new_questionnaire(title.strip() or "Untitled", user.id)
    return redirect(f"/catalog/questionnaires/{uid}", request)


def _raw_questionnaire(uid: str) -> dict:
    raw = catalog.raw_questionnaires().get(uid)
    if raw is None:
        raise HTTPException(404, "Unknown questionnaire")
    return json.loads(json.dumps(raw))  # a private copy


def _segment_keys(raw: dict) -> list[str]:
    return sorted(raw.get("dialog", {}).keys(), key=lambda k: int(k) if k.isdigit() else 10**9)


@app.get("/catalog/questionnaires/{uid}", response_class=HTMLResponse)
def questionnaire_page(request: Request, uid: str):
    user = viewer(request)
    raw = _raw_questionnaire(uid)
    segments = [(k, raw["dialog"][k]) for k in _segment_keys(raw)]
    return render(request, "questionnaire_edit.html", user=user, uid=uid, raw=raw, segments=segments,
                  short_title=catalog.titles().get(uid, raw.get("title", uid)))


@app.get("/catalog/questionnaires/{uid}/json")
def questionnaire_json(request: Request, uid: str):
    viewer(request)
    raw = _raw_questionnaire(uid)
    return JSONResponse(raw, headers={"Content-Disposition": f'attachment; filename="cq_{raw.get("title", uid)}_{uid}.json"'})


@app.post("/catalog/questionnaires/{uid}/header")
def questionnaire_header(request: Request, uid: str, title: str = Form(""), short_title: str = Form(""),
                         context: str = Form(""), a_name: str = Form(""), a_gender: str = Form("indef"),
                         a_age: str = Form(""), b_name: str = Form(""), b_gender: str = Form("indef"),
                         b_age: str = Form("")):
    user = current_user(request)
    require_admin(user)
    raw = _raw_questionnaire(uid)
    raw["title"] = title.strip() or raw.get("title", "")
    raw["short_title"] = short_title.strip() or raw["title"]
    raw["context"] = context.strip()
    raw["speakers"] = {"A": {"name": a_name.strip(), "gender": a_gender, "age": a_age.strip()},
                       "B": {"name": b_name.strip(), "gender": b_gender, "age": b_age.strip()}}
    catalog_store.save_questionnaire(uid, raw, user.id)
    return redirect(f"/catalog/questionnaires/{uid}", request)


@app.post("/catalog/questionnaires/{uid}/delete")
def questionnaire_delete(request: Request, uid: str):
    user = current_user(request)
    require_admin(user)
    with db.session() as s:
        used = s.query(db.QuestionnaireDocument).filter_by(questionnaire_uid=uid).count()
    if used:
        raise HTTPException(400, f"{used} language(s) have translations of this questionnaire. Remove those first.")
    catalog_store.delete_questionnaire(uid)
    return redirect("/catalog/questionnaires", request)


EMPTY_SEGMENT = {"speaker": "A", "text": "", "intent": [], "legacy index": "", "idiomaticity": 1,
                 "predicate": [], "concept": [], "graph": {}, "trimmed_graph": {}}


@app.post("/catalog/questionnaires/{uid}/segments")
def segment_insert(request: Request, uid: str, after: str = Form("")):
    """Insert an empty segment after the given one (or at the end), shifting the rest."""
    user = current_user(request)
    require_admin(user)
    raw = _raw_questionnaire(uid)
    keys = _segment_keys(raw)
    position = (keys.index(after) + 2) if after in keys else len(keys) + 1
    new_dialog = {}
    for k in keys:
        n = int(k)
        new_dialog[str(n + 1 if n >= position else n)] = raw["dialog"][k]
    new_dialog[str(position)] = dict(EMPTY_SEGMENT)
    raw["dialog"] = new_dialog
    catalog_store.save_questionnaire(uid, raw, user.id)
    return redirect(f"/catalog/questionnaires/{uid}/segments/{position}", request)


@app.post("/catalog/questionnaires/{uid}/segments/{index}/delete")
def segment_delete(request: Request, uid: str, index: str):
    user = current_user(request)
    require_admin(user)
    raw = _raw_questionnaire(uid)
    keys = _segment_keys(raw)
    if index not in keys:
        raise HTTPException(404)
    n = int(index)
    raw["dialog"] = {str(int(k) - 1 if int(k) > n else int(k)): v for k, v in raw["dialog"].items() if k != index}
    catalog_store.save_questionnaire(uid, raw, user.id)
    return redirect(f"/catalog/questionnaires/{uid}", request)


def value_options(cg: dict, node: str, sentence_concepts: list[str]) -> list[tuple[str, list[tuple[str, str]]]]:
    """What a requirement leaf may be set to, following dig4el's CQ editor walk: a terminal
    feature offers its children (or itself), an absolute reference offers the sentence's
    concepts (or none, which stands for the node itself), anything else its terminal
    descendants grouped by feature."""
    children = sorted(graphs.get_children(cg, node), key=str.lower)
    leaves = sorted(graphs.get_leaves_from_node(cg, node), key=str.lower)
    if node == "ABSOLUTE REFERENCE" or children == ["ABSOLUTE REFERENCE", "DEICTIC"]:
        return [("Concepts of this sentence", [(c, c) for c in sentence_concepts] + [("None", node)])]
    if leaves == children or not children:
        return [(node, [(c, c) for c in (children or [node])])]
    groups: list[tuple[str, list[tuple[str, str]]]] = []
    for child in children:
        groups.extend(value_options(cg, child, sentence_concepts))
    return groups


@app.get("/catalog/questionnaires/{uid}/segments/{index}", response_class=HTMLResponse)
def segment_page(request: Request, uid: str, index: str):
    user = viewer(request)
    raw = _raw_questionnaire(uid)
    seg = raw.get("dialog", {}).get(index)
    if seg is None:
        raise HTTPException(404)
    cg = catalog.concepts()
    graph = seg.get("graph") or {}
    leaves = []
    for name, entry in graph.items():
        if entry.get("requires"):
            continue
        node = entry["path"][-1] if entry.get("path") else name
        leaves.append({"name": name, "value": entry.get("value", ""), "node": node,
                       "options": value_options(cg, node, list(seg.get("concept") or [])) if node in cg else []})
    keys = _segment_keys(raw)
    i = keys.index(index)
    return render(request, "segment_edit.html", user=user, uid=uid, raw=raw, index=index, seg=seg, leaves=leaves,
                  intents=graphs.get_leaves_from_node(cg, "INTENT") if "INTENT" in cg else [],
                  predicates=graphs.get_leaves_from_node(cg, "PREDICATE") if "PREDICATE" in cg else [],
                  concept_names=_concept_names(cg), prev=keys[i - 1] if i > 0 else None,
                  next=keys[i + 1] if i + 1 < len(keys) else None,
                  short_title=catalog.titles().get(uid, raw.get("title", uid)))


@app.post("/catalog/questionnaires/{uid}/segments/{index}")
async def segment_save(request: Request, uid: str, index: str):
    """dig4el's "Validate sentence", plus the graph actions: initialize from the concepts,
    set a leaf's value, reset."""
    user = current_user(request)
    require_admin(user)
    form = await request.form()
    raw = _raw_questionnaire(uid)
    seg = raw.get("dialog", {}).get(index)
    if seg is None:
        raise HTTPException(404)
    cg = catalog.concepts()
    action = str(form.get("action") or "save")
    if action == "reset":
        raw["dialog"][index] = dict(EMPTY_SEGMENT)
    else:
        seg["legacy index"] = str(form.get("legacy_index") or "").strip()
        seg["speaker"] = str(form.get("speaker") or "A")
        seg["text"] = str(form.get("text") or "").strip()
        try:
            seg["idiomaticity"] = max(1, min(5, int(form.get("idiomaticity") or 1)))
        except ValueError:
            seg["idiomaticity"] = 1
        seg["intent"] = [x for x in form.getlist("intent") if x]
        seg["predicate"] = [x for x in form.getlist("predicate") if x]
        seg["concept"] = [x for x in form.getlist("concept") if x in cg]
        graph = seg.get("graph") or {}
        if action == "init_graph" or (action == "save" and not graph and seg["concept"]):
            graph = graphs.create_requirement_graph(seg["concept"], cg)
        elif action == "set_value":
            leaf, value = str(form.get("leaf") or ""), str(form.get("value") or "")
            if leaf in graph:
                graph[leaf]["value"] = value
        seg["graph"] = graph
        seg["trimmed_graph"] = graphs.arrange_requirement_graph_for_display(graph) if graph else {}
    catalog_store.save_questionnaire(uid, raw, user.id)
    return redirect(f"/catalog/questionnaires/{uid}/segments/{index}", request)


# ------------------------------------------------------------------ explorers


@app.get("/explore/wals", response_class=HTMLResponse)
def explore_wals(request: Request, language: str = "", compare: str = "", parameter: str = "",
                 macroarea: str = "", family: str = ""):
    user = viewer(request)
    names = [n.strip() for n in compare.split(";") if n.strip()]
    columns, rows = explore.wals_compare(names) if names else ([], [])
    macroareas, families = explore.wals_filters()
    return render(request, "explore_wals.html", user=user, database="wals", title="WALS",
                  language=explore.wals_language(language.strip()) if language.strip() else None,
                  language_query=language, compare=compare, columns=columns, rows=rows,
                  parameters=explore.wals_parameters(), parameter=parameter,
                  counts=explore.wals_parameter_counts(parameter, macroarea, family) if parameter else [],
                  macroareas=macroareas, families=families, macroarea=macroarea, family=family)


@app.get("/explore/grambank", response_class=HTMLResponse)
def explore_grambank(request: Request, language: str = "", compare: str = "", parameter: str = "",
                     macroarea: str = "", family: str = ""):
    user = viewer(request)
    names = [n.strip() for n in compare.split(";") if n.strip()]
    columns, rows = explore.grambank_compare(names) if names else ([], [])
    macroareas, families = explore.grambank_filters()
    return render(request, "explore_wals.html", user=user, database="grambank", title="Grambank",
                  language=explore.grambank_language(language.strip()) if language.strip() else None,
                  language_query=language, compare=compare, columns=columns, rows=rows,
                  parameters=explore.grambank_parameters(), parameter=parameter,
                  counts=explore.grambank_parameter_counts(parameter, macroarea, family) if parameter else [],
                  macroareas=macroareas, families=families, macroarea=macroarea, family=family)


@app.get("/explore/probabilities", response_class=HTMLResponse)
def explore_probabilities(request: Request, p1: str = "", p2: str = ""):
    user = viewer(request)
    table = explore.conditional_table(p1, p2) if p1 and p2 else None
    parameters = [("WALS", explore.wals_parameters()), ("Grambank", explore.grambank_parameters())]
    return render(request, "explore_probabilities.html", user=user, p1=p1, p2=p2, parameters=parameters, table=table)


@app.get("/languages/{language_id}/statistics", response_class=HTMLResponse)
def language_statistics(request: Request, language_id: str, word: str = "", feature: str = "", value: str = "",
                        hub: str = "total"):
    """dig4el's statistics and exploration of the transcriptions: word frequencies and
    neighbours, a word's sentences and connected meanings, and for a feature the words
    that set one value apart."""
    user = viewer(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        _ = lang.documents
    kg, _inputs = runner.gather_inputs(access.client, lang)
    delimiters = gw.KG_DELIMITERS
    ws = explore.word_statistics(kg, delimiters)
    top = sorted(ws["words"].values(), key=lambda w: (-w["frequency"], w["word"]))[:60]
    cg = catalog.concepts()
    features = ["INTENT", "PREDICATE", "PERSONAL DEICTIC"] + sorted(
        (c for c in cg if c not in ("INTENT", "PREDICATE", "PERSONAL DEICTIC") and graphs.get_children(cg, c)), key=str.lower)
    value_loc = explore.feature_values(kg, cg, feature, delimiters) if feature in cg else {}
    network = explore.word_network(ws["words"])
    hub_metric = hub if hub in explore.HUB_METRICS else "total"
    network["hubs"].sort(key=lambda h: (-h[hub_metric], h["word"]))
    return render(request, "statistics.html", lang=lang, access=access, sentences=len(kg), stats=ws, top=top,
                  network=network, hub_metric=hub_metric, hub_metrics=explore.HUB_METRICS,
                  word=word.strip(), word_detail=explore.word_detail(kg, word.strip(), delimiters) if word.strip() else None,
                  features=features, feature=feature,
                  value_counts=sorted(((v, len(e)) for v, e in value_loc.items()), key=lambda t: -t[1]),
                  value=value, value_detail=explore.value_detail(kg, value_loc, value, ws["total"], delimiters)
                  if value and value in value_loc else None)


# ---------------------------------------------- transcription workbooks and documents


def _template_names(lang: db.Language, uid: str, suffix: str) -> str:
    q = catalog.raw_questionnaires().get(uid, {})
    stem = "".join(ch if ch.isalnum() else "_" for ch in q.get("title", uid))[:40].strip("_")
    return f"dig4el_{stem}_{uid}_{lang.name.replace(' ', '_')}.{suffix}"


@app.get("/languages/{language_id}/questionnaires/{uid}/template.xlsx")
def questionnaire_template_xlsx(request: Request, language_id: str, uid: str):
    """dig4el's Excel workbook for transcribing a questionnaire in the field."""
    user = viewer(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        Access(user, lang)
    raw = catalog.raw_questionnaires().get(uid)
    if raw is None:
        raise HTTPException(404)
    buf = transcription_io.generate_transcription_xlsx(raw, lang.name, lang.pivot_language)
    return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": f'attachment; filename="{_template_names(lang, uid, "xlsx")}"'})


@app.get("/languages/{language_id}/questionnaires/{uid}/template.docx")
def questionnaire_template_docx(request: Request, language_id: str, uid: str):
    user = viewer(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        Access(user, lang)
    raw = catalog.raw_questionnaires().get(uid)
    if raw is None:
        raise HTTPException(404)
    buf = transcription_io.generate_transcription_doc(raw, lang.name, lang.pivot_language)
    return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                             headers={"Content-Disposition": f'attachment; filename="{_template_names(lang, uid, "docx")}"'})


@app.post("/languages/{language_id}/transcriptions")
async def transcription_upload(request: Request, language_id: str, file: UploadFile = File(...)):
    """Import a filled transcription workbook: the questionnaire it names gets a
    document if the language lacks one, and every translated segment fills its slot."""
    user = current_user(request)
    raw = await file.read()
    try:
        recording = transcription_io.cq_translation_from_transcription_xlsx(raw)
    except Exception as e:
        raise HTTPException(400, f"This is not a transcription workbook: {e}")
    uid = str(recording.get("cq_uid") or "")
    q = catalog.questionnaires().get(uid)
    if q is None:
        raise HTTPException(400, f"The workbook names questionnaire {uid or '(none)'}, which the catalog does not have.")
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_edit(access)
        ref = next((r for r in lang.documents if r.questionnaire_uid == uid), None)
        if ref is None:
            created = gw.create_questionnaire_document(access.client, lang.plaid_project_id, access.layers, q)
            ref = db.QuestionnaireDocument(language_id=lang.id, questionnaire_uid=uid, plaid_document_id=created["id"])
            s.add(ref)
            s.commit()
        doc_id = ref.plaid_document_id
        delimiters = lang.delimiters or catalog.DEFAULT_DELIMITERS
    doc = access.load_doc(doc_id)
    filled = gw.fill_from_recording(access.client, doc, access.layers, recording, delimiters)
    return redirect(f"/languages/{language_id}/documents/{doc_id}?imported={filled}", request)


@app.get("/languages/{language_id}/corpus.docx")
def corpus_docx(request: Request, language_id: str, entries: str = ""):
    """dig4el's partial-corpus Word export: the chosen knowledge-graph entries with
    their glosses."""
    user = viewer(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        _ = lang.documents
    kg, _inputs = runner.gather_inputs(access.client, lang)
    wanted = [int(x) for x in entries.split(",") if x.strip().isdigit()]
    indices = [i for i in wanted if i in kg] or list(kg)
    buf = transcription_io.generate_docx_from_kg_index_list(kg, gw.KG_DELIMITERS, indices)
    return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                             headers={"Content-Disposition": f'attachment; filename="dig4el_{lang.name.replace(" ", "_")}_corpus.docx"'})


@app.get("/compare", response_class=HTMLResponse)
def compare_page(request: Request, languages: str = "", intent: str = "", concept: str = "", sentence: str = ""):
    """dig4el's compare page: the same prompt across languages, with each language's
    translation and gloss, filtered by intent or concept."""
    user = viewer(request)
    with db.session() as s:
        mine = []
        for lang in s.query(db.Language).order_by(db.Language.name).all():
            try:
                Access(user, lang)
            except HTTPException:
                continue
            _ = lang.documents
            mine.append(lang)
    chosen = [n.strip() for n in languages.split(";") if n.strip()]
    kgs: dict[str, dict] = {}
    for lang in mine:
        if lang.name in chosen:
            kg, _inputs = runner.gather_inputs(Access(user, lang).client, lang)
            kgs[lang.name] = kg
    comp = explore.comparable_sentences(kgs) if len(kgs) > 1 else {}
    concepts = sorted({c for kg in kgs.values() for d in kg.values() for c, w in d["recording_data"]["concept_words"].items() if w})
    intents = sorted({i for kg in kgs.values() for d in kg.values() for i in d["sentence_data"]["intent"]})
    keys = []
    for text, data in comp.items():
        l0 = next(iter(data))
        sd = kgs[l0][data[l0]["kg_index"]]["sentence_data"]
        if intent and intent not in sd["intent"]:
            continue
        if concept and concept not in sd["concept"]:
            continue
        keys.append(text)
    keys.sort()
    rows = []
    if sentence in comp:
        for tl, entry in comp[sentence].items():
            rows.append({"language": tl, "translation": entry["stl"],
                         "gloss": kgmod.build_super_gloss(kgs[tl], entry["kg_index"], gw.KG_DELIMITERS)})
    return render(request, "compare.html", user=user, mine=mine, chosen=chosen, intents=intents, concepts=concepts,
                  intent=intent, concept=concept, keys=keys, sentence=sentence, rows=rows, loaded=len(kgs))


# ---------------------------------------------------------------- guest access


@app.post("/languages/{language_id}/guests")
def language_guests(request: Request, language_id: str, open: str = Form("0")):
    """Open a language to guests (the guest account becomes a reader of its project)
    or close it again. Done with the caretaker's own client, so it is audited."""
    user = current_user(request)
    guest = auth.guest_user()
    if guest is None:
        raise HTTPException(400, "No guest account is set up yet. An administrator does that under Guest access.")
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_manage(access)
        if open == "1":
            access.client.projects.add_reader(lang.plaid_project_id, guest.id)
            lang.open_to_guests = True
        else:
            try:
                access.client.projects.remove_reader(lang.plaid_project_id, guest.id)
            except PlaidAPIError as e:
                if e.status not in (400, 404):
                    raise
            lang.open_to_guests = False
        s.commit()
    return redirect(f"/languages/{language_id}", request)


@app.get("/admin/guests", response_class=HTMLResponse)
def guests_page(request: Request, error: str = ""):
    user = current_user(request)
    require_admin(user)
    return render(request, "guests.html", user=user, cfg=auth.guest_config(), error=error,
                  opened=_opened_languages())


def _opened_languages() -> list[db.Language]:
    with db.session() as s:
        return s.query(db.Language).filter_by(open_to_guests=True).order_by(db.Language.name).all()


@app.post("/admin/guests")
def guests_setup(request: Request, email: str = Form(...), password: str = Form(...),
                 display_name: str = Form("dig4el guests")):
    """Create the guest account if Plaid lacks it, mint it a named token, keep the token."""
    user = current_user(request)
    require_admin(user)
    email = email.strip()
    admin = user.client()
    try:
        admin.users.get(email)
    except PlaidAPIError as e:
        if e.status != 404:
            raise
        admin.users.create(email, password, False, display_name=display_name.strip() or "dig4el guests")
    try:
        as_guest = PlaidClient.login(settings().plaid_url, email, password)
    except PlaidAPIError as e:
        return redirect(f"/admin/guests?error=Plaid+refused+that+password+for+{email}", request)
    minted = as_guest.api_tokens.create(email, "dig4el guest access")
    auth.save_guest_config({"user_id": email, "token": minted["token"], "token_id": minted.get("id", ""),
                            "name": minted.get("name", ""), "created_by": user.id, "created_at": db.now().isoformat()})
    return redirect("/admin/guests", request)


@app.post("/admin/guests/revoke")
def guests_revoke(request: Request):
    user = current_user(request)
    require_admin(user)
    cfg = auth.guest_config() or {}
    if cfg.get("token_id"):
        try:
            PlaidClient(settings().plaid_url, cfg["token"]).api_tokens.revoke(cfg["user_id"], cfg["token_id"])
        except PlaidAPIError:
            pass
    auth.clear_guest_config()
    return redirect("/admin/guests", request)


@app.post("/languages/{language_id}/repair")
def language_repair(request: Request, language_id: str):
    """Recreate the layers another app deleted and rebuild what the surviving data allows."""
    user = current_user(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_manage(access)
        docs = [{"id": r.plaid_document_id, "kind": "questionnaire", "questionnaire": r.questionnaire_uid}
                for r in lang.documents]
        docs += [{"id": c.plaid_document_id, "kind": "corpus", "questionnaire": ""} for c in lang.corpora]
        new_layers, report = gw.repair_layers(access.client, lang.plaid_project_id, access.layers, docs,
                                              lang.delimiters or catalog.DEFAULT_DELIMITERS)
        lang.layers = new_layers.to_config()
        s.commit()
    from urllib.parse import quote
    return redirect(f"/languages/{language_id}?repaired={quote(' '.join(report))}", request)

