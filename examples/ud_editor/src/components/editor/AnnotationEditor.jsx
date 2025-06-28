import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { SentenceRow } from './SentenceRow';
import { VirtualSentenceRow } from './VirtualSentenceRow';
import { useDocumentData } from './hooks/useDocumentData';
import { useLayerInfo } from './hooks/useLayerInfo';
import { useAnnotationHandlers } from './hooks/useAnnotationHandlers';
import { useSentenceData } from './hooks/useSentenceData';
import { useDocumentHistory } from './hooks/useDocumentHistory';
import { useNlpService } from './hooks/useNlpService';
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
    hasLoadedAudit,
    fetchHistoricalDocument,
    clearHistoricalDocument,
    fetchAuditLog
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

  // NLP Service integration
  const {
    isAwake,
    isChecking,
    isParsing,
    connectionStatus,
    parseStatus,
    parseError,
    checkIfAwake,
    requestParse,
    clearParseStatus,
    canParse,
    hasParseResult
  } = useNlpService(projectId, documentId);
  
  // Debug logging
  console.log('Auto Parse button conditions:', {
    isAwake,
    viewingHistoricalState,
    hasActiveDocument: !!activeDocument,
    hasTextLayers: activeDocument?.textLayers?.length > 0,
    hasText: !!activeDocument?.textLayers?.[0]?.text,
    canParse
  });

  // History drawer handlers
  const handleOpenHistory = () => {
    setIsHistoryDrawerOpen(true);
    // Fetch audit log only when drawer is first opened
    if (!hasLoadedAudit) {
      fetchAuditLog();
    }
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

  // Handle parse success - refresh data and clear status after delay
  useEffect(() => {
    if (parseStatus === 'success') {
      // Refresh document data to show new annotations
      refreshData();
      
      // Clear success message after 3 seconds
      const timer = setTimeout(() => {
        clearParseStatus();
      }, 3000);
      
      return () => clearTimeout(timer);
    }
  }, [parseStatus, refreshData, clearParseStatus]);

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
              
              {/* History controls and NLP service */}
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
                  
                  {/* NLP Service Status */}
                  <div className="flex items-center gap-2">
                    {connectionStatus === 'connected' && (
                      <>
                        <div className={`flex items-center gap-2 px-3 py-2 text-sm rounded-md ${
                          isAwake 
                            ? 'bg-green-100 text-green-800 border border-green-200' 
                            : isChecking 
                              ? 'bg-yellow-100 text-yellow-800 border border-yellow-200'
                              : 'bg-gray-100 text-gray-600 border border-gray-200'
                        }`}>
                          {isChecking ? (
                            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                              <path className="opacity-75" fill="currentColor" d="m4 12a8 8 0 818-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 714 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                          ) : isAwake ? (
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                            </svg>
                          ) : (
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                          )}
                          <span className="text-sm font-medium">
                            {isChecking ? 'Checking NLP...' : isAwake ? 'NLP Ready' : 'NLP Offline'}
                          </span>
                        </div>
                        
                        {!isAwake && !isChecking && (
                          <button
                            onClick={checkIfAwake}
                            className="px-3 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                          >
                            Retry
                          </button>
                        )}
                        
                        {/* Auto Parse button - show when service is awake and has text content */}
                        {isAwake && !viewingHistoricalState && activeDocument && activeDocument.textLayers?.[0]?.text && (
                          <button
                            onClick={requestParse}
                            disabled={!canParse || isParsing}
                            className={`flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors ${
                              canParse && !isParsing
                                ? 'bg-green-600 text-white hover:bg-green-700' 
                                : 'bg-gray-400 text-gray-200 cursor-not-allowed'
                            }`}
                          >
                            {isParsing ? (
                              <>
                                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                  <path className="opacity-75" fill="currentColor" d="m4 12a8 8 0 818-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 714 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                                Parsing...
                              </>
                            ) : (
                              <>
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                                </svg>
                                Auto Parse
                              </>
                            )}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                  
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
                
                <div className="flex items-center gap-2">
                  {viewingHistoricalState && (
                    <button
                      onClick={() => handleSelectHistoryEntry(null)}
                      className="px-3 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                    >
                      Return to Current
                    </button>
                  )}
                  
                  {/* Auto Parse button - only show when not viewing historical state and has text content */}
                  {!viewingHistoricalState && activeDocument && activeDocument.textLayers?.[0]?.text && (
                    <button
                      onClick={requestParse}
                      disabled={!canParse || isParsing}
                      className={`flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors ${
                        canParse && !isParsing
                          ? 'bg-green-600 text-white hover:bg-green-700' 
                          : 'bg-gray-400 text-gray-200 cursor-not-allowed'
                      }`}
                    >
                      {isParsing ? (
                        <>
                          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="m4 12a8 8 0 818-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 714 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          Parsing...
                        </>
                      ) : (
                        <>
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                          </svg>
                          Auto Parse
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Error display and parse status */}
            {(error || historyError || parseError) && (
              <div style={{ marginBottom: '1rem', padding: '0 1.5rem' }}>
                {error && <div style={{ color: 'red' }}>{error}</div>}
                {historyError && <div style={{ color: 'red' }}>{historyError}</div>}
                {parseError && <div style={{ color: 'red' }}>Parse Error: {parseError}</div>}
              </div>
            )}
            
            {/* Parse success message */}
            {parseStatus === 'success' && (
              <div style={{ marginBottom: '1rem', padding: '0 1.5rem' }}>
                <div style={{ color: 'green' }}>✓ Document parsed successfully!</div>
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
              
              {/* History controls and NLP service */}
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
                  
                  {/* NLP Service Status */}
                  <div className="flex items-center gap-2">
                    {connectionStatus === 'connected' && (
                      <>
                        <div className={`flex items-center gap-2 px-3 py-2 text-sm rounded-md ${
                          isAwake 
                            ? 'bg-green-100 text-green-800 border border-green-200' 
                            : isChecking 
                              ? 'bg-yellow-100 text-yellow-800 border border-yellow-200'
                              : 'bg-gray-100 text-gray-600 border border-gray-200'
                        }`}>
                          {isChecking ? (
                            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                              <path className="opacity-75" fill="currentColor" d="m4 12a8 8 0 818-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 714 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                          ) : isAwake ? (
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                            </svg>
                          ) : (
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                          )}
                          <span className="text-sm font-medium">
                            {isChecking ? 'Checking NLP...' : isAwake ? 'NLP Ready' : 'NLP Offline'}
                          </span>
                        </div>
                        
                        {!isAwake && !isChecking && (
                          <button
                            onClick={checkIfAwake}
                            className="px-3 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                          >
                            Retry
                          </button>
                        )}
                        
                        {/* Auto Parse button - show when service is awake and has text content */}
                        {isAwake && !viewingHistoricalState && activeDocument && activeDocument.textLayers?.[0]?.text && (
                          <button
                            onClick={requestParse}
                            disabled={!canParse || isParsing}
                            className={`flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors ${
                              canParse && !isParsing
                                ? 'bg-green-600 text-white hover:bg-green-700' 
                                : 'bg-gray-400 text-gray-200 cursor-not-allowed'
                            }`}
                          >
                            {isParsing ? (
                              <>
                                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                  <path className="opacity-75" fill="currentColor" d="m4 12a8 8 0 818-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 714 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                                Parsing...
                              </>
                            ) : (
                              <>
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                                </svg>
                                Auto Parse
                              </>
                            )}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                  
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
                
                <div className="flex items-center gap-2">
                  {viewingHistoricalState && (
                    <button
                      onClick={() => handleSelectHistoryEntry(null)}
                      className="px-3 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                    >
                      Return to Current
                    </button>
                  )}
                  
                  {/* Auto Parse button - only show when not viewing historical state and has text content */}
                  {!viewingHistoricalState && activeDocument && activeDocument.textLayers?.[0]?.text && (
                    <button
                      onClick={requestParse}
                      disabled={!canParse || isParsing}
                      className={`flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors ${
                        canParse && !isParsing
                          ? 'bg-green-600 text-white hover:bg-green-700' 
                          : 'bg-gray-400 text-gray-200 cursor-not-allowed'
                      }`}
                    >
                      {isParsing ? (
                        <>
                          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="m4 12a8 8 0 818-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 714 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          Parsing...
                        </>
                      ) : (
                        <>
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                          </svg>
                          Auto Parse
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Error display and parse status */}
            {(error || historyError || parseError) && (
              <div style={{ marginBottom: '1rem', padding: '0 1.5rem' }}>
                {error && <div style={{ color: 'red' }}>{error}</div>}
                {historyError && <div style={{ color: 'red' }}>{historyError}</div>}
                {parseError && <div style={{ color: 'red' }}>Parse Error: {parseError}</div>}
              </div>
            )}
            
            {/* Parse success message */}
            {parseStatus === 'success' && (
              <div style={{ marginBottom: '1rem', padding: '0 1.5rem' }}>
                <div style={{ color: 'green' }}>✓ Document parsed successfully!</div>
              </div>
            )}

            {/* All sentences displayed vertically */}
            {sentences.map((sentenceData, index) => {
              // Calculate total tokens before this sentence
              const totalTokensBefore = sentences
                .slice(0, index)
                .reduce((total, prevSentence) => total + prevSentence.tokens.length, 0);

              return (
                <VirtualSentenceRow
                  key={sentenceData.id}
                  sentenceData={sentenceData}
                  onAnnotationUpdate={viewingHistoricalState ? null : handleAnnotationUpdate}
                  onFeatureDelete={viewingHistoricalState ? null : handleFeatureDelete}
                  onRelationCreate={viewingHistoricalState ? null : handleRelationCreate}
                  onRelationUpdate={viewingHistoricalState ? null : handleRelationUpdate}
                  onRelationDelete={viewingHistoricalState ? null : handleRelationDelete}
                  sentenceIndex={index}
                  totalTokensBefore={totalTokensBefore}
                  estimatedHeight={250} // Estimated height for placeholder
                />
              );
            })}
          </>
        )}
      </div>
    </div>
  );
};