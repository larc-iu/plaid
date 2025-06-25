import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { SentenceRow } from './SentenceRow';
import { useDocumentData } from './hooks/useDocumentData';
import { useLayerInfo } from './hooks/useLayerInfo';
import { useAnnotationHandlers } from './hooks/useAnnotationHandlers';

export const AnnotationEditor = () => {
  const { projectId, documentId } = useParams();
  const [sentences, setSentences] = useState([]);
  
  const { 
    document, 
    project, 
    loading, 
    error, 
    setDocument, 
    setError, 
    refreshData 
  } = useDocumentData(projectId, documentId);
  
  const layerInfo = useLayerInfo(document);
  
  const {
    handleAnnotationUpdate,
    handleFeatureDelete,
    handleRelationCreate,
    handleRelationUpdate,
    handleRelationDelete
  } = useAnnotationHandlers(document, setDocument, setError, layerInfo, refreshData);

  // Helper function to process sentences from document data
  const processSentences = (documentData) => {
    const textLayer = documentData.textLayers?.[0];
    const text = textLayer?.text;
    const tokenLayer = textLayer?.tokenLayers?.[0];
    const tokens = tokenLayer?.tokens || [];
    
    if (!text?.body || tokens.length === 0) {
      return [];
    }

    // Find span layers
    const spanLayers = tokenLayer?.spanLayers || [];
    const sentenceLayer = spanLayers.find(layer => layer.name === 'Sentence');
    const sentenceSpans = sentenceLayer?.spans || [];
    
    // Sort tokens by position in text
    const sortedTokens = [...tokens].sort((a, b) => a.begin - b.begin);
    
    // Find which tokens start new sentences
    const sentenceStartTokenIds = new Set(
      sentenceSpans.map(span => {
        // Handle both tokens array and begin/end properties
        if (span.tokens && span.tokens.length > 0) {
          return span.tokens[0];
        }
        return span.begin;
      }).filter(id => id != null)
    );

    // Group tokens into sentences
    const sentences = [];
    let currentSentence = [];
    
    for (const token of sortedTokens) {
      // If this token starts a new sentence and we have tokens in current sentence
      if (sentenceStartTokenIds.has(token.id) && currentSentence.length > 0) {
        sentences.push(currentSentence);
        currentSentence = [];
      }
      currentSentence.push(token);
    }
    
    // Add the last sentence if it has tokens
    if (currentSentence.length > 0) {
      sentences.push(currentSentence);
    }

    // If no sentence boundaries, treat all tokens as one sentence
    if (sentences.length === 0 && sortedTokens.length > 0) {
      sentences.push(sortedTokens);
    }

    return sentences.map((sentenceTokens, index) => ({
      id: index,
      tokens: sentenceTokens,
      text: sentenceTokens.map(token => 
        text.body.substring(token.begin, token.end)
      ).join(' ')
    }));
  };

  // Process sentences when document changes
  const processedSentences = useMemo(() => {
    if (!document) return [];
    return processSentences(document);
  }, [document]);

  useEffect(() => {
    setSentences(processedSentences);
  }, [processedSentences]);

  if (loading) {
    return <div>Loading document...</div>;
  }

  if (!document) {
    return <div>Document not found</div>;
  }

  if (sentences.length === 0) {
    return <div>No sentences found. Please ensure the document has been tokenized in the Text Editor.</div>;
  }

  return (
    <div style={{ margin: 0, padding: 0, width: '100%', minHeight: '100vh' }}>
      {/* Breadcrumbs and title section */}
      <div style={{ padding: '1rem 1.5rem', borderBottom: '1px solid #e5e7eb' }}>
        <nav className="flex items-center text-sm text-gray-500 mb-4">
          <Link to="/projects" className="text-blue-600 hover:text-blue-800">Projects</Link>
          <span className="mx-2 text-gray-400">/</span>
          <Link to={`/projects/${projectId}/documents`} className="text-blue-600 hover:text-blue-800">
            {project?.name || 'Loading...'}
          </Link>
          <span className="mx-2 text-gray-400">/</span>
          <Link to={`/projects/${projectId}/documents/${document?.id}/edit`} className="text-blue-600 hover:text-blue-800">{document?.name || 'Loading...'}</Link>
        </nav>
        
        <h1 className="text-2xl font-bold text-gray-900">{document?.name || 'Loading...'}</h1>
      </div>

      {/* Error display */}
      {error && (
        <div style={{ color: 'red', marginBottom: '1rem', padding: '0 1.5rem' }}>
          {error}
        </div>
      )}

      {/* All sentences displayed vertically */}
      {sentences.map((sentence, index) => {
        // Calculate total tokens before this sentence
        const totalTokensBefore = sentences
          .slice(0, index)
          .reduce((total, prevSentence) => total + prevSentence.tokens.length, 0);

        return (
          <SentenceRow
            key={sentence.id}
            sentence={sentence}
            document={document}
            onAnnotationUpdate={handleAnnotationUpdate}
            onFeatureDelete={handleFeatureDelete}
            onRelationCreate={handleRelationCreate}
            onRelationUpdate={handleRelationUpdate}
            onRelationDelete={handleRelationDelete}
            sentenceIndex={index}
            totalTokensBefore={totalTokensBefore}
          />
        );
      })}
    </div>
  );
};