import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { SentenceRow } from './SentenceRow';
import { useDocumentData } from './hooks/useDocumentData';
import { useLayerInfo } from './hooks/useLayerInfo';
import { useAnnotationHandlers } from './hooks/useAnnotationHandlers';
import { useSentenceData } from './hooks/useSentenceData';

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