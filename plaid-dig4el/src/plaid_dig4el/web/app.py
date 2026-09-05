"""dig4el's web application.

Server-rendered pages with htmx for the parts that update in place (a slot in the
questionnaire editor, a running inference's status). Every Plaid call is made with
the logged-in user's own token.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from plaid_client import PlaidClient
from plaid_client.http import PlaidAPIError

from .. import auth, db, plaid_gateway as gw
from ..inference import kg as kgmod, legacy_labels, pipeline, runner
from ..reference import catalog

HERE = Path(__file__).parent
app = FastAPI(title="dig4el", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
templates = Jinja2Templates(directory=HERE / "templates")
templates.env.globals.update(label=legacy_labels.label, catalog=catalog)


@app.on_event("startup")
def _startup() -> None:
    db.engine()
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


def render(request: Request, name: str, **ctx: Any) -> HTMLResponse:
    ctx.setdefault("user", auth.user_from_request(request))
    ctx["request"] = request
    return templates.TemplateResponse(request, name, ctx)


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
        try:
            self.project = self.client.projects.get(language.plaid_project_id)
        except PlaidAPIError as e:
            if e.status in (403, 404):
                raise HTTPException(404, "This language is not available to you.")
            raise
        self.layers = gw.Layers.from_config(language.layers)

    def _in(self, key: str) -> bool:
        return self.user.id in (self.project.get(key) or [])

    @property
    def can_manage(self) -> bool:
        return self.user.is_admin or self._in("maintainers")

    @property
    def can_edit(self) -> bool:
        return self.can_manage or self._in("writers")

    @property
    def role(self) -> str:
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
    user = current_user(request)
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
    with db.session() as s:
        languages = [l for l in s.query(db.Language).order_by(db.Language.name).all()
                     if l.plaid_project_id in visible]
        rows = []
        for l in languages:
            latest = l.runs[0] if l.runs else None
            rows.append({"language": l, "documents": len(l.documents), "latest_run": latest})
    return render(request, "languages.html", rows=rows)


@app.get("/languages/new", response_class=HTMLResponse)
def language_new(request: Request):
    current_user(request)
    from ..reference import grambank as gu, wals as wu

    wals_names = sorted(wu.language_pk_id_by_name.keys())
    gb_names = sorted({v.get("name", "") for v in gu.grambank_language_by_lid.values()} - {""})
    return render(request, "language_new.html", wals_names=wals_names, grambank_names=gb_names,
                  default_delimiters="".join(catalog.DEFAULT_DELIMITERS))


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
    if not name:
        raise HTTPException(400, "A language needs a name.")
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
    user = current_user(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        docs = []
        for ref in lang.documents:
            q = catalog.questionnaires().get(ref.questionnaire_uid)
            try:
                d = access.load_doc(ref.plaid_document_id)
                docs.append({"ref": ref, "q": q, "doc": d, "filled": sum(1 for x in d.slots if x.filled),
                             "total": len(d.slots), "missing": False})
            except PlaidAPIError:
                docs.append({"ref": ref, "q": q, "doc": None, "filled": 0, "total": 0, "missing": True})
        present = {ref.questionnaire_uid for ref in lang.documents}
        available = [q for uid, q in catalog.questionnaires().items() if uid not in present]
        available.sort(key=lambda q: q.short_title)
        runs = list(lang.runs)
        published = sum(1 for d in docs if d["doc"] and d["doc"].published and d["filled"])
    return render(request, "language.html", lang=lang, access=access, docs=docs, available=available,
                  runs=runs, imported=imported, published=published)


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
    q = catalog.questionnaires().get(doc.questionnaire)
    return {"lang": lang, "access": access, "doc": doc, "q": q}


@app.get("/languages/{language_id}/documents/{document_id}", response_class=HTMLResponse)
def editor_page(request: Request, language_id: str, document_id: str):
    user = current_user(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        doc = access.load_doc(document_id)
    return render(request, "questionnaire.html", **_editor_context(access, lang, doc))


def _slot_response(request: Request, access: Access, lang: db.Language, document_id: str, segment: str):
    doc = access.load_doc(document_id)
    slot = doc.slot(segment)
    if slot is None:
        raise HTTPException(404, "No such segment")
    return render(request, "_slot.html", slot=slot, seg=slot.segment, **_editor_context(access, lang, doc))


@app.get("/languages/{language_id}/documents/{document_id}/slots/{segment}", response_class=HTMLResponse)
def slot_get(request: Request, language_id: str, document_id: str, segment: str):
    user = current_user(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
    return _slot_response(request, access, lang, document_id, segment)


@app.post("/languages/{language_id}/documents/{document_id}/slots/{segment}/translation",
          response_class=HTMLResponse)
def slot_translation(request: Request, language_id: str, document_id: str, segment: str,
                     text: str = Form(""), alternate_pivot: str = Form(""),
                     back_translation: str = Form(""), note: str = Form("")):
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
        text = text.replace("\n", " ").strip()
        if text != slot.text:
            gw.fill_slot(access.client, doc, slot, text, lang.delimiters or catalog.DEFAULT_DELIMITERS,
                         fields=fields, description=f"Translate segment {segment} of {doc.name}")
        else:
            with access.client.operation(f"Edit fields of segment {segment} of {doc.name}"):
                gw.write_fields(access.client, doc, slot, fields)
    return _slot_response(request, access, lang, document_id, segment)


@app.post("/languages/{language_id}/documents/{document_id}/slots/{segment}/concepts",
          response_class=HTMLResponse)
async def slot_concepts(request: Request, language_id: str, document_id: str, segment: str):
    user = current_user(request)
    form = await request.form()
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_edit(access)
        doc = access.load_doc(document_id)
        slot = doc.slot(segment)
        if slot is None or slot.segment is None:
            raise HTTPException(404, "No such segment")
        wanted = {c: [str(v) for v in form.getlist(f"c:{c}")] for c in slot.segment.expected_concepts()}
        gw.set_concepts(access.client, doc, slot, wanted)
    return _slot_response(request, access, lang, document_id, segment)


# ---------------------------------------------------------------- inference


@app.post("/languages/{language_id}/inference")
def inference_start(request: Request, language_id: str):
    user = current_user(request)
    with db.session() as s:
        lang = get_language(s, language_id)
        access = Access(user, lang)
        require_edit(access)
        run = db.InferenceRun(language_id=lang.id, created_by=user.id, status="queued",
                              settings_json={"seed": None})
        s.add(run)
        s.commit()
        run_id = run.id
    runner.start_run(run_id, user.token)
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
    user = current_user(request)
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
    current_user(request)
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
