import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { SentenceRow } from './SentenceRow';
import { useDocumentData } from './hooks/useDocumentData';
import { useLayerInfo } from './hooks/useLayerInfo';
import { useAnnotationHandlers } from './hooks/useAnnotationHandlers';
import { useSentenceData } from './hooks/useSentenceData';
import { DocumentTabs } from './DocumentTabs';

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
  const processedSentences = useSentenceData(document);
  
  const {
    handleAnnotationUpdate,
    handleFeatureDelete,
    handleRelationCreate,
    handleRelationUpdate,
    handleRelationDelete
  } = useAnnotationHandlers(document, setDocument, setError, layerInfo, refreshData);

  useEffect(() => {
    setSentences(processedSentences);
  }, [processedSentences]);

  if (loading) {
    return <div className="text-center text-gray-600 py-8">Loading document...</div>;
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
      <div style={{ padding: '1rem 1.5rem' }}>
        <DocumentTabs 
          projectId={projectId}
          documentId={documentId}
          project={project}
          document={document}
        />
      </div>

      {/* Error display */}
      {error && (
        <div style={{ color: 'red', marginBottom: '1rem', padding: '0 1.5rem' }}>
          {error}
        </div>
      )}

      {/* All sentences displayed vertically */}
      {sentences.map((sentenceData, index) => {
        // Calculate total tokens before this sentence
        const totalTokensBefore = sentences
          .slice(0, index)
          .reduce((total, prevSentence) => total + prevSentence.tokens.length, 0);

        return (
          <SentenceRow
            key={sentenceData.id}
            sentenceData={sentenceData}
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