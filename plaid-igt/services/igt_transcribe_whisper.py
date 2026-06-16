"""
Whisper ASR Service

Complete Whisper ASR implementation with both model and service in one file.
"""

import argparse
import tempfile
import shutil
import whisper
from typing import List, Dict, Any
from plaid_client.workflows.asr import ASRModel, Alignment, AlignmentProcessor
from plaid_client import BaseService, TASKS, Param, service_source, PROV_DETAIL_KEY


WHISPER_MODEL_SIZES = [
    ('tiny', 'Tiny — fastest, least accurate'),
    ('base', 'Base'),
    ('small', 'Small'),
    ('medium', 'Medium'),
    ('large', 'Large — slowest, most accurate'),
]

SUMMARY = """\
OpenAI **Whisper** speech-to-text. Downloads the document's attached media,
transcribes it, and writes time-aligned segments.

- **Model size**: larger models are more accurate but slower and need more
  memory. The operator's launch `--model` sets the default and the first model
  loaded; choosing a different size per request loads/caches it on demand.
- **Language**: leave blank to auto-detect, or force an ISO code (e.g. `en`).
- **Overwrite human-edited annotations**: each pass resets the sentence
  partition, which deletes sentence-level annotations. Machine-made,
  unverified ones are always fair game; if any are human-made or
  human-verified, the run refuses unless this is enabled.

Tokens this service creates carry provenance metadata (`prov`/`provSource`).
"""


class WhisperASRModel(ASRModel):
    """
    Simplified Whisper ASR model implementation.
    """
    
    def __init__(self, model_name: str = "base", keep_loaded: bool = True):
        """Initialize the Whisper ASR model."""
        self.model_name = model_name  # default/preferred size
        self.keep_loaded = keep_loaded
        self._models: Dict[str, Any] = {}  # size -> loaded model (cached iff keep_loaded)

        print(f"Whisper default model: {model_name} (keep_loaded={keep_loaded})")

        if self.keep_loaded:
            self.load_model(self.model_name)

    def load_model(self, model_name: str = None):
        """Load (and cache, when keep_loaded) the Whisper model of a given size."""
        name = model_name or self.model_name
        model = self._models.get(name)
        if model is None:
            print(f"Loading Whisper model '{name}'...")
            model = whisper.load_model(name)
            print(f"Whisper model '{name}' loaded on {model.device}")
            if self.keep_loaded:
                self._models[name] = model
        return model

    def transcribe_with_alignments(self, audio_path: str, model_size: str = None,
                                   language: str = None) -> List[Alignment]:
        """
        Transcribe audio and return segment-level alignments.

        Args:
            audio_path: Local path to the audio file.
            model_size: Optional per-request model size (defaults to the
                operator-configured size).
            language: Optional ISO language code to force (None = auto-detect).
        """
        name = model_size or self.model_name
        model = self.load_model(name)

        print(f"Transcribing audio file: {audio_path} (model={name}, language={language or 'auto'})")

        try:
            options = {}
            if language:
                options['language'] = language
            result = model.transcribe(audio_path, **options)

            alignments = []
            for segment in result["segments"]:
                segment_text = segment["text"].strip()
                if segment_text:
                    # Model scores ride in the provenance convention's
                    # provDetail slot (see the manual, "Provenance"): they're
                    # producer-specific extras, and avg_logprob is a raw
                    # score, NOT a calibrated probability — so no provProb.
                    detail = {
                        "model": f"whisper-{name}",
                        "avgLogprob": segment.get("avg_logprob", None),
                        "noSpeechProb": segment.get("no_speech_prob", None),
                    }
                    detail = {k: v for k, v in detail.items() if v is not None}

                    alignment = Alignment(
                        text=segment_text,
                        start=segment['start'],
                        end=segment['end'],
                        metadata={PROV_DETAIL_KEY: detail}
                    )
                    alignments.append(alignment)
            
            return alignments
            
        except Exception as e:
            raise RuntimeError(f"Whisper transcription failed: {str(e)}")
        finally:
            if not self.keep_loaded:
                # Not cached; drop the reference so it can be reclaimed.
                del model

    def get_model_info(self) -> Dict[str, Any]:
        """Return information about the Whisper model."""
        return {
            "name": "Whisper",
            "model_size": self.model_name,
            "keep_loaded": self.keep_loaded,
        }
    

class WhisperASRService(BaseService):
    """
    Whisper ASR service implementation using the framework.
    """
    
    def __init__(self):
        super().__init__(
            service_id='asr:whisper-asr',
            service_name='Whisper ASR',
            description='Automatic Speech Recognition using OpenAI\'s Whisper',
            tasks=[TASKS.TRANSCRIBE],
            summary=SUMMARY,
            parameters=[
                Param.enum('model_size', 'Model size', WHISPER_MODEL_SIZES, default='base',
                           description='Larger models are more accurate but slower and use more memory.'),
                Param.string('language', 'Language (optional)', default='',
                             placeholder='auto-detect (e.g. en, es, de)',
                             description='ISO code to force a language; blank = auto-detect.'),
                Param.boolean('overwrite', 'Overwrite human-edited annotations', default=False,
                              description='Allow the sentence-partition reset to delete sentence-level '
                                          'annotations a human created or verified.'),
            ],
        )
        self.asr_model = None
        self.alignment_processor = None

    def create_argument_parser(self) -> argparse.ArgumentParser:
        """Create argument parser for ASR service"""
        parser = argparse.ArgumentParser(description='Whisper ASR Service for Plaid')
        
        # Add common arguments
        self.setup_parser_common_args(parser)
        
        # Add ASR-specific arguments. The default matches the `model_size`
        # parameter's default so the preloaded model is the one UI requests use.
        parser.add_argument('--model', default='base',
                          choices=['tiny', 'base', 'small', 'medium', 'large'],
                          help='Whisper model size to preload as the default (default: base)')
        parser.add_argument('--no-keep-loaded', action='store_true',
                          help='Unload model from memory after each transcription')
        
        return parser
    
    def setup(self, args) -> None:
        """Setup ASR-specific configuration"""

        # Create ASR model
        keep_loaded = not args.no_keep_loaded
        self.asr_model = WhisperASRModel(model_name=args.model, keep_loaded=keep_loaded)
        self.alignment_processor = AlignmentProcessor()
        
        # Update service description with model info
        model_info = self.asr_model.get_model_info()
        self.description = f"Automatic Speech Recognition using {model_info['name']} {model_info['model_size']} model"
    
    def process_request(self, request_data: dict, response_helper) -> None:
        """Process ASR request"""
        # Request data reaches a Python service in snake_case (the client recases
        # the JS UI's camelCase keys symmetrically on the wire).
        document_id = request_data.get('document_id')
        text_layer_id = request_data.get('text_layer_id')
        alignment_token_layer_id = request_data.get('alignment_token_layer_id')
        sentence_token_layer_id = request_data.get('sentence_token_layer_id')
        # User-controlled arguments (declared in the service's parameter schema).
        model_size = request_data.get('model_size') or None
        language = request_data.get('language') or None
        overwrite = bool(request_data.get('overwrite', False))
        
        # Validate required parameters
        if not document_id:
            response_helper.error("Missing required parameter: documentId")
            return
        
        if not text_layer_id:
            response_helper.error("Missing required parameter: textLayerId")
            return
        
        if not alignment_token_layer_id:
            response_helper.error("Missing required parameter: alignmentTokenLayerId")
            return
        
        temp_dir = tempfile.mkdtemp()
        
        try:
            # Get document to fetch media URL
            response_helper.progress(5, "Fetching document...")
            full_document = self.client.documents.get(document_id, include_body=True)
            
            # Get media URL from document
            media_url = full_document.get("media_url")
            if not media_url:
                raise ValueError("No media file attached to document")
            
            # Construct full media URL if it's a relative path
            if media_url.startswith('/'):
                full_media_url = self.client.base_url.rstrip('/') + media_url
            else:
                full_media_url = media_url
            
            # Download media file
            response_helper.progress(10, "Downloading media file...")
            audio_file = self.alignment_processor.download_media_file(self.client, full_media_url, temp_dir)
            
            # Transcribe audio with ASR model
            response_helper.progress(30, f"Loading ASR model ({model_size or self.asr_model.model_name})...")
            response_helper.progress(40, "Transcribing audio...")
            alignments = self.asr_model.transcribe_with_alignments(
                audio_file, model_size=model_size, language=language)
            
            if not alignments:
                raise ValueError("No transcription results generated")
            
            response_helper.progress(70, f"Generated {len(alignments)} segment alignments...")
            
            # Process alignments using the alignment processor. Created tokens
            # are stamped machine-made (provenance convention); the processor
            # refuses to destroy protected annotations unless `overwrite`.
            # Label every write in the audit log (the processor acquires the
            # document lock and does the batched alignment writes inside this scope).
            audit_msg = f"Whisper ASR transcription ({language})" if language else "Whisper ASR transcription"
            with self.client.audit_message(audit_msg):
                tokens_created = self.alignment_processor.process_alignments(
                    self.client, document_id, alignments, text_layer_id,
                    alignment_token_layer_id, sentence_token_layer_id, response_helper,
                    prov_source=service_source(self.service_id),
                    overwrite=overwrite,
                )
            
            response_helper.progress(100, "ASR processing completed successfully")
            response_helper.complete({
                "document_id": document_id,
                "status": "success",
                "tokens_created": tokens_created,
                "segments_transcribed": len(alignments)
            })
            
        except Exception as e:
            import traceback
            print(f"Error during ASR processing: {str(e)}")
            response_helper.error(f"ASR processing error: {str(e)}")
            traceback.print_exc()
        finally:
            # Clean up temporary files
            try:
                shutil.rmtree(temp_dir)
            except Exception as cleanup_error:
                print(f"Failed to clean up temporary files: {cleanup_error}")


def main():
    """Main entry point"""
    service = WhisperASRService()
    service.run()


if __name__ == '__main__':
    main()