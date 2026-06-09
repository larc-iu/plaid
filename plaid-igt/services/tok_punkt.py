"""
NLTK Punkt Tokenizer Service

Simplified tokenization service using the tokenization framework.
This demonstrates how easy it is to create new tokenization services.
"""

import argparse
import nltk
from typing import List, Dict, Any, Tuple
from client.base_service import BaseService
from client.tokenization import TokenizerModel, TokenSpan, TokenProcessor, helpers
from plaid_client import TASKS, Param


# Punkt ships pretrained sentence models for these languages. (value, label)
PUNKT_LANGUAGES = [
    ('english', 'English'), ('german', 'German'), ('french', 'French'),
    ('spanish', 'Spanish'), ('italian', 'Italian'), ('portuguese', 'Portuguese'),
    ('dutch', 'Dutch'), ('czech', 'Czech'), ('polish', 'Polish'),
    ('russian', 'Russian'), ('turkish', 'Turkish'),
]

SUMMARY = """\
Segments text into **sentences** with NLTK's pretrained *Punkt* model, then
splits each sentence into **words** with the Treebank word tokenizer.

- Sentence segmentation is language-specific — pick the closest **Language**.
- Word tokenization uses the same Treebank rules across languages; best for
  whitespace-delimited, Latin-script text.
"""


class NLTKPunktTokenizer(TokenizerModel):
    def __init__(self):
        self._cache: Dict[str, Any] = {}
        self._ensure_punkt_downloaded()

    def _ensure_punkt_downloaded(self):
        try:
            self._cache['english'] = nltk.data.load('tokenizers/punkt/english.pickle')
        except LookupError:
            print("Downloading NLTK punkt tokenizer...")
            nltk.download('punkt')
            self._cache['english'] = nltk.data.load('tokenizers/punkt/english.pickle')

    def _get_tokenizer(self, language: str = 'english'):
        """Load (and cache) the Punkt model for a language, falling back to
        English if that language's model isn't available."""
        if language not in self._cache:
            try:
                self._cache[language] = nltk.data.load(f'tokenizers/punkt/{language}.pickle')
            except LookupError:
                print(f"Punkt model for '{language}' unavailable; falling back to English.")
                self._cache[language] = self._cache['english']
        return self._cache[language]

    def tokenize_text(self, text: str, language: str = 'english') -> Tuple[List[TokenSpan], List[TokenSpan]]:
        return helpers.spans_from_nltk_punkt(text, self._get_tokenizer(language))

    def get_model_info(self) -> Dict[str, Any]:
        """Return information about the NLTK Punkt tokenizer."""
        return {
            "name": "NLTK Punkt",
            "type": "sentence_tokenizer",
            "language": "multi",
            "description": "Pre-trained Punkt tokenizer for sentence segmentation with TreebankWordTokenizer for words"
        }


class NLTKTokenizerService(BaseService):
    """
    NLTK tokenization service implementation using the framework.
    """
    
    def __init__(self):
        super().__init__(
            service_id='tok:nltk-punkt-tokenizer',
            service_name='NLTK Punkt Tokenizer',
            description='Tokenizes documents into sentences and words using NLTK\'s pre-trained Punkt tokenizer',
            tasks=[TASKS.TOKENIZE],
            summary=SUMMARY,
            parameters=[
                Param.enum('language', 'Language', PUNKT_LANGUAGES, default='english',
                           description='Pretrained Punkt model used for sentence segmentation.'),
            ],
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
        # Request data reaches a Python service in snake_case (the client recases
        # the JS UI's camelCase keys symmetrically on the wire).
        document_id = request_data.get('document_id')
        text_layer_id = request_data.get('text_layer_id')
        primary_token_layer_id = request_data.get('primary_token_layer_id')
        sentence_layer_id = request_data.get('sentence_layer_id')
        # User-controlled argument (declared in the service's parameter schema).
        language = request_data.get('language', 'english')
        
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
            response_helper.progress(25, f"Tokenizing text ({language})...")
            sentences, words = self.tokenizer_model.tokenize_text(text_content, language)
            
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