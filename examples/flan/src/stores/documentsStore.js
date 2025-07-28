import { proxy } from 'valtio';
import { parseDocument } from '../utils/documentParser';

const documentsStore = proxy({});

const newUiState = () => {
  return {
    history: {
      viewingHistorical: false,
      open: false,
      selectedEntry: null,
      auditEntries: [],
      loadingAudit: false,
      hasLoadedAudit: false,
      auditError: null
    },
    tokenize: {
      helpOpen: false,
      algorithm: '',
      algorithmOptions: [],
      isTokenizing: false,
      tokenizationProgress: 0,
      currentOperation: '',
      hasRestoredCache: false
    },
    metadata: {
      isEditing: false,
      saving: false,
      deleting: false,
      deleteModalOpen: false,
      editedName: '',
      editedMetadata: {}
    },
    baseline: {
      isEditing: false,
      saving: false,
      editedText: ''
    },
    media: {
      // Playback state
      currentTime: 0,
      duration: 0,
      isPlaying: false,
      volume: 0.8,
      
      // Timeline state
      pixelsPerSecond: 25,
      selection: null, // {start, end}
      playingSelection: null,
      popoverOpened: false,
      
      // ASR state
      asrAlgorithm: '',
      asrAlgorithmOptions: [],
      transcriptionProgress: 0,
      currentOperation: '',
      
      // Upload state
      isUploading: false
    },
    analyze: {
      saving: false,
      refreshing: false,
      selectedVocab: null
    },
    loading: false,
    error: null,
    activeTab: 'metadata'
  };
}

// Helper functions for complex operations that are used in multiple places
export const loadDocument = async (projectId, documentId, client) => {
  documentsStore[projectId] = documentsStore[projectId] || {};
  documentsStore[projectId][documentId] = documentsStore[projectId]?.[documentId] || {};
  const docProxy = documentsStore[projectId][documentId]
  docProxy.ui = docProxy?.ui || newUiState()

  try {
    docProxy.ui.error = null;

    const [documentData, projectData] = await Promise.all([
      client.documents.get(documentId, true),
      client.projects.get(projectId)
    ]);

    // Load vocabularies associated with this project
    let projectVocabularies = {};
    try {
      const projectVocabIds = projectData.vocabs?.map(vocab => vocab.id) || [];
      if (projectVocabIds.length > 0) {
        const vocabulariesWithItems = await Promise.all(
          projectVocabIds.map(async (vocabId) => {
            try {
              return await client.vocabLayers.get(vocabId, true);
            } catch (error) {
              console.warn(`Error fetching vocab ${vocabId}:`, error);
              return null;
            }
          })
        );
        
        projectVocabularies = vocabulariesWithItems
          .filter(vocab => vocab !== null)
          .reduce((acc, vocab) => {
            acc[vocab.id] = vocab;
            return acc;
          }, {});
      }
    } catch (vocabError) {
      console.warn('Error loading vocabularies:', vocabError);
    }

    const parsed = parseDocument(documentData, client, projectData);
    parsed.project = projectData;
    parsed.vocabularies = projectVocabularies;
    Object.assign(documentsStore[projectId][documentId], parsed)
  } catch (error) {
    throw error;
  }
};

export const loadHistoricalDocument = async (projectId, documentId, timestamp, client) => {
  const docProxy = documentsStore[projectId][documentId]

  try {
    const [historicalDocument, projectData] = await Promise.all([
      client.documents.get(documentId, true, timestamp),
      client.projects.get(projectId)
    ]);

    // Load vocabularies for historical documents too
    let projectVocabularies = {};
    try {
      const projectVocabIds = projectData.vocabs?.map(vocab => vocab.id) || [];
      if (projectVocabIds.length > 0) {
        const vocabulariesWithItems = await Promise.all(
          projectVocabIds.map(async (vocabId) => {
            try {
              return await client.vocabLayers.get(vocabId, true);
            } catch (error) {
              console.warn(`Error fetching vocab ${vocabId}:`, error);
              return null;
            }
          })
        );
        
        projectVocabularies = vocabulariesWithItems
          .filter(vocab => vocab !== null)
          .reduce((acc, vocab) => {
            acc[vocab.id] = vocab;
            return acc;
          }, {});
      }
    } catch (vocabError) {
      console.warn('Error loading vocabularies:', vocabError);
    }

    const parsed = parseDocument(historicalDocument, client, projectData);
    parsed.project = projectData;
    parsed.vocabularies = projectVocabularies;
    Object.assign(documentsStore[projectId][documentId], parsed)
    docProxy.ui.history.viewingHistorical = true;
  } catch (error) {
    throw error;
  }
};

export const loadAuditLog = async (projectId, documentId, client) => {
  const docProxy = documentsStore[projectId][documentId];
  
  try {
    docProxy.ui.history.loadingAudit = true;
    docProxy.ui.history.auditError = null;
    
    const auditData = await client.documents.audit(documentId);
    docProxy.ui.history.auditEntries = auditData || [];
    docProxy.ui.history.hasLoadedAudit = true;
  } catch (error) {
    docProxy.ui.history.auditError = 'Failed to load audit log: ' + (error.message || 'Unknown error');
    console.error('Error fetching audit log:', error);
  } finally {
    docProxy.ui.history.loadingAudit = false;
  }
};

export default documentsStore;