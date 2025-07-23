# Whisper ASR Service

This service provides automatic speech recognition (ASR) using OpenAI's Whisper model, creating segment-level time alignments for audio files.

## Requirements

- Python 3.8+
- OpenAI Whisper
- requests

## Installation

```bash
pip install openai-whisper requests
```

## Usage

Run the service with a project ID:

```bash
python asr_service.py PROJECT_ID [API_URL]
```

Example:
```bash
python asr_service.py 123e4567-e89b-12d3-a456-426614174000
```

Or with a custom API URL:
```bash
python asr_service.py 123e4567-e89b-12d3-a456-426614174000 http://localhost:8085
```

## Authentication

On first run, you'll be prompted to enter your Plaid API token. The token will be saved to `.token` for future use.

## How it works

1. The service registers itself as "whisper-asr" with the Plaid messaging system
2. When an ASR request is received, it:
   - Downloads the audio file from the authenticated media URL
   - Loads the Whisper model (base by default)
   - Transcribes the entire audio file using Whisper's natural segmentation
   - Generates segment-level transcriptions with time alignments
   - Creates time alignment tokens with metadata containing `timeBegin` and `timeEnd`
   - Preserves existing alignment tokens (won't overwrite manual work)

## Features

### Model
- Uses OpenAI's Whisper `base` model by default for English speech recognition
- Automatic GPU detection and usage when available
- Handles entire audio files without manual chunking

### Time Alignments
- Natural segment-level time alignments (sentences, phrases, breath units)
- Tokens are created with `timeBegin` and `timeEnd` metadata
- Inserts transcribed segments chronologically into existing text
- Preserves existing alignment tokens (additive approach)

### Audio Support
- Supports common audio/video formats: MP3, WAV, MP4, M4A, AAC
- Automatic format detection from content-type headers
- Whisper handles audio format conversion automatically

### Error Handling
- Comprehensive error handling for network issues, file formats, and model loading
- Clear progress updates during processing
- Automatic cleanup of temporary files

## Output

The service creates time alignment tokens with:
- Character positions in the document text
- Time metadata: `timeBegin` and `timeEnd` (in seconds)
- Natural segment boundaries determined by Whisper

## Performance Notes

- First run downloads the Whisper model (~140MB for base model)
- GPU acceleration significantly improves processing speed
- Whisper handles long audio files efficiently without manual chunking
- Memory usage is optimized by Whisper's internal processing

## Limitations

- Processing time scales with audio duration
- Segment boundaries are determined by Whisper's internal algorithm
- Quality depends on audio clarity and background noise levels