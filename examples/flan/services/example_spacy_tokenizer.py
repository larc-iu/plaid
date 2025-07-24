"""
Example spaCy Tokenizer Service

Demonstrates how easy it is to create a new tokenizer using the framework.
This implementation uses spaCy for advanced NLP tokenization.
"""

import argparse
from typing import List, Dict, Any, Tuple
from client.base_service import BaseService
from client.tokenization import TokenizerModel, TokenSpan, TokenProcessor, helpers


class SpacyTokenizerModel(TokenizerModel):
    """
    spaCy tokenizer implementation.
    
    Note: This is a demonstration. In practice, you'd need to install spaCy:
    pip install spacy
    python -m spacy download en_core_web_sm
    """
    
    def __init__(self, model_name: str = "en_core_web_sm"):
        """Initialize the spaCy tokenizer."""
        self.model_name = model_name
        self.nlp = None
        self._load_model()
    
    def _load_model(self):
        """Load the spaCy model."""
        try:
            import spacy
            self.nlp = spacy.load(self.model_name)
            print(f"Loaded spaCy model: {self.model_name}")
        except ImportError:
            raise RuntimeError("spaCy not installed. Please install with: pip install spacy")
        except OSError:
            raise RuntimeError(f"spaCy model '{self.model_name}' not found. Please download with: python -m spacy download {self.model_name}")
    
    def tokenize_text(self, text: str) -> Tuple[List[TokenSpan], List[TokenSpan]]:
        """
        Tokenize text using spaCy.
        
        Args:
            text: Input text to tokenize
            
        Returns:
            Tuple of (sentences, words) as TokenSpan lists with rich metadata
        """
        doc = self.nlp(text)
        return helpers.spans_from_spacy_doc(doc)
    
    def get_model_info(self) -> Dict[str, Any]:
        """Return information about the spaCy tokenizer."""
        return {
            "name": "spaCy",
            "model": self.model_name,
            "type": "nlp_tokenizer",
            "features": ["pos_tagging", "lemmatization", "sentence_segmentation"],
            "description": f"spaCy NLP tokenizer using {self.model_name} model"
        }


class SpacyTokenizerService(BaseService):
    """spaCy tokenization service implementation using the framework."""
    
    def __init__(self):
        super().__init__(
            service_id='tok:spacy-tokenizer',
            service_name='spaCy Tokenizer',
            description='Advanced NLP tokenization using spaCy with POS tagging and lemmatization'
        )
        self.tokenizer_model = None
        self.token_processor = TokenProcessor()
    
    def create_argument_parser(self) -> argparse.ArgumentParser:
        """Create argument parser for spaCy tokenization service"""
        parser = argparse.ArgumentParser(description='spaCy Tokenizer Service for Plaid')
        
        # Add common arguments
        self.setup_parser_common_args(parser)
        
        # Add spaCy-specific arguments
        parser.add_argument('--model', default='en_core_web_sm',
                          help='spaCy model to use (default: en_core_web_sm)')
        
        return parser
    
    def setup(self, args) -> None:
        """Setup spaCy-specific configuration"""
        # Create tokenizer model with specified spaCy model
        self.tokenizer_model = SpacyTokenizerModel(model_name=args.model)
        
        # Update service description with model info
        model_info = self.tokenizer_model.get_model_info()
        self.description = f"Advanced NLP tokenization using {model_info['name']} {model_info['model']} model"
    
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
            
            # Tokenize with spaCy
            response_helper.progress(25, "Processing text with spaCy...")
            sentences, words = self.tokenizer_model.tokenize_text(text_content)
            
            if not words:
                response_helper.error("No tokens generated from text")
                return
            
            response_helper.progress(30, f"Generated {len(sentences)} sentences and {len(words)} words with NLP features...")
            
            # Process tokens using the token processor
            results = self.token_processor.process_tokens(
                self.client, document_id, sentences, words,
                primary_token_layer_id, sentence_layer_id, response_helper
            )
            
            response_helper.progress(100, "spaCy tokenization completed successfully")
            response_helper.complete({
                "documentId": document_id,
                "status": "success",
                "tokenizer": "spaCy",
                **results  # Include tokensCreated, tokensDeleted, sentencesCreated
            })
            
        except Exception as e:
            import traceback
            print(f"Error during spaCy tokenization: {str(e)}")
            response_helper.error(f"spaCy tokenization error: {str(e)}")
            traceback.print_exc()


def main():
    """Main entry point"""
    service = SpacyTokenizerService()
    service.run()


if __name__ == '__main__':
    main()