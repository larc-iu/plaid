"""``plaid-dig4el``: run the dig4el server against a Plaid instance."""

from __future__ import annotations

import argparse
import os
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(prog="plaid-dig4el", description="dig4el on Plaid")
    parser.add_argument("--plaid-url", default=os.environ.get("PLAID_URL", "http://localhost:8085"),
                        help="the Plaid server (default http://localhost:8085)")
    parser.add_argument("--data-dir", default=os.environ.get("PLAID_DIG4EL_DATA_DIR", "./data"),
                        help="where dig4el keeps its database and files (default ./data)")
    parser.add_argument("--reference-dir", default=os.environ.get("PLAID_DIG4EL_REFERENCE_DIR"),
                        help="the derived WALS/Grambank data (default: reference_data next to the package)")
    parser.add_argument("--host", default=os.environ.get("PLAID_DIG4EL_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PLAID_DIG4EL_PORT", "8087")))
    parser.add_argument("--reload", action="store_true", help="development: reload on code changes")
    llm = parser.add_argument_group("language model", "an OpenAI-compatible endpoint such as a litellm proxy; "
                                    "without these the app runs and the model-backed features say they are off")
    llm.add_argument("--llm-url", default=os.environ.get("LLM_BASE_URL"), help="the endpoint, e.g. http://localhost:4000/v1")
    llm.add_argument("--llm-key-file", default=os.environ.get("LLM_KEY_FILE"),
                     help="file whose first line is the endpoint's key (or set LLM_API_KEY)")
    llm.add_argument("--llm-model", default=os.environ.get("LLM_MODEL"),
                     help="model for the structured stages (must honour response_format json_schema)")
    llm.add_argument("--llm-model-strong", default=os.environ.get("LLM_MODEL_STRONG"),
                     help="optional larger model, offered as 'strong' when generating descriptions")
    llm.add_argument("--llm-embedding-model", default=os.environ.get("LLM_EMBEDDING_MODEL"),
                     help="embedding model for sentence and document retrieval")
    args = parser.parse_args()

    for flag, var in ((args.llm_url, "LLM_BASE_URL"), (args.llm_key_file, "LLM_KEY_FILE"), (args.llm_model, "LLM_MODEL"),
                      (args.llm_model_strong, "LLM_MODEL_STRONG"), (args.llm_embedding_model, "LLM_EMBEDDING_MODEL")):
        if flag:
            os.environ[var] = str(flag)

    if args.reference_dir:
        os.environ["PLAID_DIG4EL_REFERENCE_DIR"] = str(Path(args.reference_dir).resolve())
    os.environ["PLAID_URL"] = args.plaid_url
    os.environ["PLAID_DIG4EL_DATA_DIR"] = str(Path(args.data_dir).resolve())
    os.environ["PLAID_DIG4EL_HOST"] = args.host
    os.environ["PLAID_DIG4EL_PORT"] = str(args.port)

    import uvicorn

    uvicorn.run("plaid_dig4el.web.app:app", host=args.host, port=args.port, reload=args.reload,
                factory=False)


if __name__ == "__main__":
    main()
