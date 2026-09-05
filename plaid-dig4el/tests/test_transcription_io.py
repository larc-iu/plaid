"""dig4el's transcription workbook: the template is generated, a field worker fills it,
and the parser turns it back into a recording that the knowledge graph accepts."""

import io
import json
from pathlib import Path

from openpyxl import load_workbook

from plaid_dig4el import transcription_io as tio
from plaid_dig4el.inference import kg as kgmod, legacy_labels
from plaid_dig4el.reference import catalog

FIX = Path(__file__).parent / "fixtures"


def test_workbook_round_trip():
    raw = catalog.raw_questionnaires()["1716315461"]
    wb = load_workbook(io.BytesIO(tio.generate_transcription_xlsx(raw, "Tahitian", "English").getvalue()))
    ws, info = wb["Transcription"], wb["Info"]
    # dig4el's template leaves row 2 empty (the freeze pane creates it); data starts at row 3
    assert ws["A3"].value == "1" and ws["B3"].value == raw["dialog"]["1"]["text"]
    info["B7"] = "A. Tester"
    ws["D3"] = "ia ora na"; ws["E3"] = "be well"; ws["G3"] = "ia...ora"; ws["H3"] = "greeting"
    buf = io.BytesIO(); wb.save(buf)
    rec = tio.cq_translation_from_transcription_xlsx(buf.getvalue(), default_target_language="Tahitian")
    assert rec["cq_uid"] == "1716315461" and rec["interviewer"] == "A. Tester"
    first = rec["data"]["1"]
    assert first["translation"] == "ia ora na" and first["lebt"] == "be well" and first["comment"] == "greeting"
    assert first["concept_words"] == {"Intent: GREET": "ia...ora"}
    kg = kgmod.from_recordings([rec], "Tahitian")
    assert len(kg) == len(raw["dialog"]) and kg[0]["recording_data"]["translation"] == "ia ora na"


def test_word_documents_build():
    raw = catalog.raw_questionnaires()["1716315461"]
    assert len(tio.generate_transcription_doc(raw, "Tahitian", "English").getvalue()) > 10000
    kg = {int(k): v for k, v in json.loads((FIX / "marquesan_kg.json").read_text()).items()}
    kg, _ = legacy_labels.update_knowledge_graph(kg)
    assert len(tio.generate_docx_from_kg_index_list(kg, [" "], list(kg)[:2]).getvalue()) > 10000
