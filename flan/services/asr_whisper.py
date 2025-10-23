"""
Whisper ASR Service

Complete Whisper ASR implementation with both model and service in one file.
"""

import sys
import argparse
import tempfile
import shutil
import torch
import whisper
from typing import List, Dict, Any
from client.asr import ASRModel, Alignment, AlignmentProcessor
from client.base_service import BaseService


class WhisperASRModel(ASRModel):
    """
    Simplified Whisper ASR model implementation.
    """
    
    def __init__(self, model_name: str = "base", keep_loaded: bool = True):
        """Initialize the Whisper ASR model."""
        self.model_name = model_name
        self.keep_loaded = keep_loaded
        self.model = None

        print(f"Whisper model: {model_name} (keep_loaded={keep_loaded})")

        if self.keep_loaded:
            self.load_model()
    
    def load_model(self):
        """Load the Whisper model"""
        if self.model is None:
            self.model = whisper.load_model(self.model_name)
            print(f"Whisper model loaded successfully on {self.model.device}")

    def unload_model(self):
        """Unload the model from memory if not keeping it loaded"""
        if not self.keep_loaded and self.model is not None:
            print("Unloading Whisper model from memory...")
            del self.model
            self.model = None

    def transcribe_with_alignments(self, audio_path: str) -> List[Alignment]:
        """
        Transcribe audio and return segment-level alignments.
        """
        self.load_model()
        
        print(f"Transcribing audio file: {audio_path}")
        
        try:
            result = self.model.transcribe(audio_path)
            
            alignments = []
            for segment in result["segments"]:
                segment_text = segment["text"].strip()
                if segment_text:
                    metadata = {
                        "confidence": segment.get("avg_logprob", None),
                        "no_speech_prob": segment.get("no_speech_prob", None)
                    }
                    # Remove None values from metadata
                    metadata = {k: v for k, v in metadata.items() if v is not None}

                    alignment = Alignment(
                        text=segment_text,
                        start=segment['start'],
                        end=segment['end'],
                        metadata=metadata
                    )
                    alignments.append(alignment)
            
            return alignments
            
        except Exception as e:
            raise RuntimeError(f"Whisper transcription failed: {str(e)}")
        finally:
            self.unload_model()
    
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
            description='Automatic Speech Recognition using OpenAI\'s Whisper'
        )
        self.asr_model = None
        self.alignment_processor = None

    def create_argument_parser(self) -> argparse.ArgumentParser:
        """Create argument parser for ASR service"""
        parser = argparse.ArgumentParser(description='Whisper ASR Service for Plaid')
        
        # Add common arguments
        self.setup_parser_common_args(parser)
        
        # Add ASR-specific arguments
        parser.add_argument('--model', default='large', 
                          choices=['tiny', 'base', 'small', 'medium', 'large'],
                          help='Whisper model size (default: large)')
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
        # Extract required parameters
        document_id = request_data.get('documentId')
        text_layer_id = request_data.get('textLayerId')
        alignment_token_layer_id = request_data.get('alignmentTokenLayerId')
        sentence_token_layer_id = request_data.get('sentenceTokenLayerId')
        
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
            full_document = self.client.documents.get(document_id, True)
            
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
            response_helper.progress(30, "Loading ASR model...")
            response_helper.progress(40, "Transcribing audio...")
            alignments = self.asr_model.transcribe_with_alignments(audio_file)
            
            if not alignments:
                raise ValueError("No transcription results generated")
            
            response_helper.progress(70, f"Generated {len(alignments)} segment alignments...")
            
            # Process alignments using the alignment processor
            tokens_created = self.alignment_processor.process_alignments(
                self.client, document_id, alignments, text_layer_id,
                alignment_token_layer_id, sentence_token_layer_id, response_helper
            )
            
            response_helper.progress(100, "ASR processing completed successfully")
            response_helper.complete({
                "documentId": document_id,
                "status": "success",
                "tokensCreated": tokens_created,
                "segmentsTranscribed": len(alignments)
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