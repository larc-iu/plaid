"""Running the pipeline for a language in the background and recording the run."""

from __future__ import annotations

import threading
import traceback
from dataclasses import asdict

from plaid_client import PlaidClient

from .. import db, plaid_gateway as gw
from ..config import settings
from . import pipeline


def preload() -> None:
    """Warm the reference tables and the conditional-probability graph so the first
    run does not pay for them. Safe to call from a background thread."""
    from ..reference import bridge, grambank, wals  # noqa: F401

    wals._load()
    grambank._load()
    bridge._load()
    pipeline.cpt_graph()


def preload_in_background() -> None:
    threading.Thread(target=preload, name="dig4el-preload", daemon=True).start()


def gather_inputs(client: PlaidClient, language: db.Language) -> tuple[dict, dict]:
    """Read the language's published questionnaire documents from Plaid and build the
    knowledge graph. Returns (knowledge graph, inputs record)."""
    layers = gw.Layers.from_config(language.layers)
    docs = []
    inputs = {"documents": []}
    for ref in language.documents:
        try:
            doc = gw.read_questionnaire_document(client, ref.plaid_document_id, layers)
        except Exception as e:  # deleted in Plaid, or no longer readable
            inputs["documents"].append({"id": ref.plaid_document_id, "questionnaire": ref.questionnaire_uid,
                                        "missing": True, "error": str(e)[:200]})
            continue
        inputs["documents"].append({"id": doc.id, "questionnaire": doc.questionnaire, "version": doc.version,
                                    "published": doc.published,
                                    "filled": sum(1 for s in doc.slots if s.filled)})
        docs.append(doc)
    kg = gw.knowledge_graph_from_docs(docs, language.typology_name, published_only=True)
    return kg, inputs


def execute_run(run_id: str, token: str) -> None:
    with db.session() as s:
        run = s.get(db.InferenceRun, run_id)
        if run is None:
            return
        run.status = "running"
        s.commit()
        language = s.get(db.Language, run.language_id)
        _ = language.documents  # load while the session is open
    try:
        client = PlaidClient(settings().plaid_url, token)
        kg, inputs = gather_inputs(client, language)
        cfg = pipeline.Settings(**{k: v for k, v in (run.settings_json or {}).items()
                                   if k in pipeline.Settings.__dataclass_fields__})
        report = pipeline.run_inference(kg, language.typology_name, gw.KG_DELIMITERS, cfg,
                                        grambank_name=language.grambank_name or None)
        report["sentences"] = len(kg)
        with db.session() as s:
            run = s.get(db.InferenceRun, run_id)
            run.report = report
            run.inputs = inputs
            run.settings_json = asdict(cfg)
            run.status = "done"
            run.finished_at = db.now()
            s.commit()
    except Exception:
        with db.session() as s:
            run = s.get(db.InferenceRun, run_id)
            run.status = "failed"
            run.error = traceback.format_exc()[-4000:]
            run.finished_at = db.now()
            s.commit()


def start_run(run_id: str, token: str) -> None:
    threading.Thread(target=execute_run, args=(run_id, token), name=f"dig4el-run-{run_id[:8]}",
                     daemon=True).start()
