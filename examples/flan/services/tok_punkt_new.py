"""
NLTK Punkt Tokenizer Service

Simplified tokenization service using the tokenization framework.
This demonstrates how easy it is to create new tokenization services.
"""

import sys
import argparse
import nltk
from typing import List, Dict, Any, Tuple
from client.base_service import BaseService
from client.tokenization import TokenizerModel, TokenSpan, TokenProcessor, helpers


class NLTKPunktTokenizer(TokenizerModel):
    def __init__(self):
        self.punkt_tokenizer = None
        self._ensure_punkt_downloaded()
    
    def _ensure_punkt_downloaded(self):
        try:
            self.punkt_tokenizer = nltk.data.load('tokenizers/punkt/english.pickle')
        except LookupError:
            print("Downloading NLTK punkt tokenizer...")
            nltk.download('punkt')
            self.punkt_tokenizer = nltk.data.load('tokenizers/punkt/english.pickle')
    
    def tokenize_text(self, text: str) -> Tuple[List[TokenSpan], List[TokenSpan]]:
        return helpers.spans_from_nltk_punkt(text, self.punkt_tokenizer)
    
    def get_model_info(self) -> Dict[str, Any]:
        """Return information about the NLTK Punkt tokenizer."""
        return {
            "name": "NLTK Punkt",
            "type": "sentence_tokenizer",
            "language": "english",
            "description": "Pre-trained Punkt tokenizer for English sentence segmentation with TreebankWordTokenizer for words"
        }


class NLTKTokenizerService(BaseService):
    """
    NLTK tokenization service implementation using the framework.
    """
    
    def __init__(self):
        super().__init__(
            service_id='tok:nltk-punkt-tokenizer',
            service_name='NLTK Punkt Tokenizer',
            description='Tokenizes documents into sentences and words using NLTK\'s pre-trained Punkt tokenizer'
        )
        self.tokenizer_model = NLTKPunktTokenizer()
        self.token_processor = TokenProcessor()
    
    def create_argument_parser(self) -> argparse.ArgumentParser:
        """Create argument parser for tokenization service"""
        parser = argparse.ArgumentParser(description='NLTK Punkt Tokenizer Service for Plaid')
        
        # Add common arguments
        self.setup_parser_common_args(parser)
        
        return parser
    
    def setup(self, args) -> None:
        """Setup tokenization-specific configuration"""
        # Update service description with model info
        model_info = self.tokenizer_model.get_model_info()
        self.description = f"Tokenizes documents using {model_info['name']} tokenizer"
    
    def process_request(self, request_data: dict, response_helper) -> None:
        """Process tokenization request"""
        # Extract required parameters
        document_id = request_data.get('documentId')
        text_layer_id = request_data.get('textLayerId')
        primary_token_layer_id = request_data.get('primaryTokenLayerId')
        sentence_layer_id = request_data.get('sentenceLayerId')
        
        # Validate required parameters
        if not document_id:
            response_helper.error("Missing required parameter: documentId")
            return
        
        if not text_layer_id:
            response_helper.error("Missing required parameter: textLayerId")
            return
        
        if not primary_token_layer_id:
            response_helper.error("Missing required parameter: primaryTokenLayerId")
            return
        
        try:
            # Get document text
            response_helper.progress(5, "Fetching document...")
            full_document = self.client.documents.get(document_id, True)

            # Find the specified text layer
            text_layer = None
            for layer in full_document.get("text_layers", []):
                if layer.get("id") == text_layer_id:
                    text_layer = layer
                    break
            
            if not text_layer:
                response_helper.error(f"Text layer {text_layer_id} not found in document {document_id}")
                return
            
            if "text" not in text_layer or text_layer["text"] is None:
                response_helper.error(f"Text does not exist for text layer {text_layer_id}")
                return

            # Find the text content
            text_content = text_layer["text"]["body"]
            
            if not text_content.strip():
                response_helper.error(f"Text content is empty for document {document_id}")
                return
            
            # Tokenize with our model
            response_helper.progress(25, "Tokenizing text...")
            sentences, words = self.tokenizer_model.tokenize_text(text_content)
            
            if not words:
                response_helper.error("No tokens generated from text")
                return
            
            response_helper.progress(30, f"Generated {len(sentences)} sentences and {len(words)} words...")
            
            # Process tokens using the token processor
            results = self.token_processor.process_tokens(
                self.client, document_id, sentences, words,
                primary_token_layer_id, sentence_layer_id, response_helper
            )
            
            response_helper.progress(100, "Tokenization completed successfully")
            response_helper.complete({
                "documentId": document_id,
                "status": "success",
                **results  # Include tokensCreated, tokensDeleted, sentencesCreated
            })
            
        except Exception as e:
            import traceback
            print(f"Error during tokenization: {str(e)}")
            response_helper.error(f"Tokenization error: {str(e)}")
            traceback.print_exc()


def main():
    """Main entry point"""
    service = NLTKTokenizerService()
    service.run()


if __name__ == '__main__':
    main()