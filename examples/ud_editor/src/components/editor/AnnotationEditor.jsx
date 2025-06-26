import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { SentenceRow } from './SentenceRow';
import { useDocumentData } from './hooks/useDocumentData';
import { useLayerInfo } from './hooks/useLayerInfo';
import { useAnnotationHandlers } from './hooks/useAnnotationHandlers';
import { useSentenceData } from './hooks/useSentenceData';
import { useDocumentHistory } from './hooks/useDocumentHistory';
import { DocumentTabs } from './DocumentTabs';
import { HistoryDrawer } from './HistoryDrawer';

export const AnnotationEditor = () => {
  const { projectId, documentId } = useParams();
  const [sentences, setSentences] = useState([]);
  
  // History viewer state
  const [isHistoryDrawerOpen, setIsHistoryDrawerOpen] = useState(false);
  const [selectedHistoryEntry, setSelectedHistoryEntry] = useState(null);
  const [viewingHistoricalState, setViewingHistoricalState] = useState(false);
  
  const { 
    document, 
    project, 
    loading, 
    error, 
    setDocument, 
    setError, 
    refreshData 
  } = useDocumentData(projectId, documentId);
  
  // History functionality
  const {
    auditEntries,
    historicalDocument,
    loadingAudit,
    loadingHistorical,
    error: historyError,
    fetchHistoricalDocument,
    clearHistoricalDocument
  } = useDocumentHistory(documentId);
  
  // Use historical document if viewing historical state, otherwise use current document
  const activeDocument = viewingHistoricalState ? historicalDocument : document;
  
  const layerInfo = useLayerInfo(activeDocument);
  const processedSentences = useSentenceData(activeDocument);
  
  const {
    handleAnnotationUpdate,
    handleFeatureDelete,
    handleRelationCreate,
    handleRelationUpdate,
    handleRelationDelete
  } = useAnnotationHandlers(activeDocument, setDocument, setError, layerInfo, refreshData);

  // History drawer handlers
  const handleOpenHistory = () => {
    setIsHistoryDrawerOpen(true);
  };

  const handleCloseHistory = () => {
    setIsHistoryDrawerOpen(false);
    // Auto-return to current state when closing drawer
    if (selectedHistoryEntry) {
      handleSelectHistoryEntry(null);
    }
  };

  const handleSelectHistoryEntry = async (entry) => {
    if (!entry) {
      // Return to current state
      setSelectedHistoryEntry(null);
      setViewingHistoricalState(false);
      clearHistoricalDocument();
      return;
    }

    // Set selected entry immediately for instant feedback
    setSelectedHistoryEntry(entry);
    
    // Fetch historical document in background
    const historicalDoc = await fetchHistoricalDocument(entry.time);
    if (historicalDoc) {
      setViewingHistoricalState(true);
    }
  };

  useEffect(() => {
    setSentences(processedSentences);
  }, [processedSentences]);

  // Always render the main container with drawer to maintain state
  return (
    <div style={{ margin: 0, padding: 0, width: '100%', minHeight: '100vh' }}>
      {/* History Drawer */}
      <HistoryDrawer
        isOpen={isHistoryDrawerOpen}
        onClose={handleCloseHistory}
        auditEntries={auditEntries}
        loading={loadingAudit}
        error={historyError}
        onSelectEntry={handleSelectHistoryEntry}
        selectedEntry={selectedHistoryEntry}
      />
      
      {/* Main content area - pushed right when drawer is open */}
      <div 
        className={`transition-all duration-300 ease-in-out ${
          isHistoryDrawerOpen ? 'ml-96' : 'ml-0'
        }`}
        style={{ minHeight: '100vh' }}
      >
        {/* Handle different loading/error states within the main content area */}
        {loading && (
          <div className="text-center text-gray-600 py-8">Loading document...</div>
        )}

        {!loading && !activeDocument && (
          <div className="text-center text-gray-600 py-8">Document not found</div>
        )}

        {!loading && activeDocument && processedSentences.length === 0 && (
          <div className="p-6">
            {/* Breadcrumbs and title section */}
            <div style={{ padding: '1rem 1.5rem' }}>
              <DocumentTabs 
                projectId={projectId}
                documentId={documentId}
                project={project}
                document={activeDocument}
              />
              
              {/* History controls */}
              <div className="flex items-center justify-between mt-4">
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleOpenHistory}
                    className="flex items-center gap-2 px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    History
                  </button>
                  
                  {selectedHistoryEntry && (
                    <div className="flex items-center gap-2 px-3 py-2 bg-yellow-100 text-yellow-800 rounded-md border border-yellow-200">
                      {loadingHistorical ? (
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="m4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      )}
                      <span className="text-sm font-medium">
                        {loadingHistorical ? 'Loading Historical State...' : 'Viewing Historical State'}
                      </span>
                      <span className="text-xs">
                        {selectedHistoryEntry && new Date(selectedHistoryEntry.time).toLocaleString()}
                      </span>
                    </div>
                  )}
                </div>
                
                {viewingHistoricalState && (
                  <button
                    onClick={() => handleSelectHistoryEntry(null)}
                    className="px-3 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                  >
                    Return to Current
                  </button>
                )}
              </div>
            </div>

            {/* Error display */}
            {(error || historyError) && (
              <div style={{ color: 'red', marginBottom: '1rem', padding: '0 1.5rem' }}>
                {error && <div>{error}</div>}
                {historyError && <div>{historyError}</div>}
              </div>
            )}

            {/* No sentences message */}
            <div className="text-center text-gray-600 py-8">
              {viewingHistoricalState 
                ? "This historical state has no tokenized content to display."
                : "No sentences found. Please ensure the document has been tokenized in the Text Editor."}
            </div>
          </div>
        )}

        {!loading && activeDocument && processedSentences.length > 0 && (
          <>
            {/* Breadcrumbs and title section */}
            <div style={{ padding: '1rem 1.5rem' }}>
              <DocumentTabs 
                projectId={projectId}
                documentId={documentId}
                project={project}
                document={activeDocument}
              />
              
              {/* History controls */}
              <div className="flex items-center justify-between mt-4">
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleOpenHistory}
                    className="flex items-center gap-2 px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    History
                  </button>
                  
                  {selectedHistoryEntry && (
                    <div className="flex items-center gap-2 px-3 py-2 bg-yellow-100 text-yellow-800 rounded-md border border-yellow-200">
                      {loadingHistorical ? (
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="m4 12a8 8 0 818-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 714 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      )}
                      <span className="text-sm font-medium">
                        {loadingHistorical ? 'Loading Historical State...' : 'Viewing Historical State'}
                      </span>
                      <span className="text-xs">
                        {selectedHistoryEntry && new Date(selectedHistoryEntry.time).toLocaleString()}
                      </span>
                    </div>
                  )}
                </div>
                
                {viewingHistoricalState && (
                  <button
                    onClick={() => handleSelectHistoryEntry(null)}
                    className="px-3 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                  >
                    Return to Current
                  </button>
                )}
              </div>
            </div>

            {/* Error display */}
            {(error || historyError) && (
              <div style={{ color: 'red', marginBottom: '1rem', padding: '0 1.5rem' }}>
                {error && <div>{error}</div>}
                {historyError && <div>{historyError}</div>}
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
                  onAnnotationUpdate={viewingHistoricalState ? null : handleAnnotationUpdate}
                  onFeatureDelete={viewingHistoricalState ? null : handleFeatureDelete}
                  onRelationCreate={viewingHistoricalState ? null : handleRelationCreate}
                  onRelationUpdate={viewingHistoricalState ? null : handleRelationUpdate}
                  onRelationDelete={viewingHistoricalState ? null : handleRelationDelete}
                  sentenceIndex={index}
                  totalTokensBefore={totalTokensBefore}
                  readOnly={viewingHistoricalState}
                />
              );
            })}
          </>
        )}
      </div>
    </div>
  );
};