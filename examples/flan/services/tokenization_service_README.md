# NLTK Punkt Tokenization Service

This service provides document tokenization using NLTK's pre-trained Punkt tokenizer.

## Requirements

- Python 3.x
- NLTK library
- requests library

## Installation

```bash
pip install nltk requests
```

## Usage

Run the service with a project ID:

```bash
python tokenization_service.py PROJECT_ID [API_URL]
```

Example:
```bash
python tokenization_service.py 123e4567-e89b-12d3-a456-426614174000
```

Or with a custom API URL:
```bash
python tokenization_service.py 123e4567-e89b-12d3-a456-426614174000 http://localhost:8085
```

## Authentication

On first run, you'll be prompted to enter your Plaid API token. The token will be saved to `.token` for future use.

## How it works

1. The service registers itself as "nltk-punkt-tokenizer" with the Plaid messaging system
2. When a tokenization request is received, it:
   - Acquires a lock on the document (handled by the frontend)
   - Fetches the document content
   - Uses NLTK's Punkt tokenizer to identify sentences and words
   - Preserves any existing tokens (won't overwrite manual edits)
   - Creates new tokens in bulk for efficiency
   - Releases the lock (handled by the frontend)

## Features

- Preserves existing tokens - won't overwrite manual tokenization
- Creates both word tokens and sentence boundaries
- Provides progress updates during processing
- Handles errors gracefully with clear error messages