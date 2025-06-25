import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { SentenceRow } from './SentenceRow';

export const AnnotationEditor = () => {
  const { projectId, documentId } = useParams();
  const [document, setDocument] = useState(null);
  const [project, setProject] = useState(null);
  const [sentences, setSentences] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { getClient } = useAuth();

  // Fetch initial data
  const fetchData = async () => {
    try {
      setLoading(true);
      const client = getClient();
      if (!client) {
        window.location.href = '/login';
        return;
      }

      // Get project and document with all layer data
      const [projectData, documentData] = await Promise.all([
        client.projects.get(projectId),
        client.documents.get(documentId, true)
      ]);
      setProject(projectData);
      setDocument(documentData);
      setError('');
    } catch (err) {
      if (err.status === 401) {
        window.location.href = '/login';
        return;
      }
      setError('Failed to load document: ' + (err.message || 'Unknown error'));
      console.error('Error fetching data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [projectId, documentId]);

  // Reprocess sentences when document changes (for optimistic updates)
  useEffect(() => {
    if (document) {
      const processedSentences = processSentences(document);
      setSentences(processedSentences);
    }
  }, [document]);


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

  // Get layer information for annotations
  const getLayerInfo = () => {
    if (!document) return {};
    
    const textLayer = document.textLayers?.[0];
    const tokenLayer = textLayer?.tokenLayers?.[0];
    const spanLayers = tokenLayer?.spanLayers || [];
    
    const lemmaLayer = spanLayers.find(layer => layer.name === 'Lemma');
    const uposLayer = spanLayers.find(layer => layer.name === 'UPOS');
    const xposLayer = spanLayers.find(layer => layer.name === 'XPOS');
    const featuresLayer = spanLayers.find(layer => layer.name === 'Features');
    
    // Get relation layer (attached to lemma layer)
    const relationLayer = lemmaLayer?.relationLayers?.[0];
    
    return {
      lemmaLayer,
      uposLayer,
      xposLayer,
      featuresLayer,
      relationLayer,
      textLayer,
      tokenLayer
    };
  };

  // Handle annotation updates with optimistic updates
  const handleAnnotationUpdate = async (tokenId, field, value, skipOptimisticUpdate = false) => {
    try {
      const client = getClient();
      const layerInfo = getLayerInfo();
      
      let targetLayer, spans;
      
      switch (field) {
        case 'lemma':
          targetLayer = layerInfo.lemmaLayer;
          spans = targetLayer?.spans || [];
          break;
        case 'upos':
          targetLayer = layerInfo.uposLayer;
          spans = targetLayer?.spans || [];
          break;
        case 'xpos':
          targetLayer = layerInfo.xposLayer;
          spans = targetLayer?.spans || [];
          break;
        case 'features':
          targetLayer = layerInfo.featuresLayer;
          spans = targetLayer?.spans || [];
          break;
        default:
          throw new Error(`Unknown field: ${field}`);
      }

      let spanResult;
      
      // For features, always create a new span (multiple features per token allowed)
      if (field === 'features') {
        if (!targetLayer) {
          console.warn(`Layer for ${field} not found, cannot create annotation`);
          return;
        }
        
        // Always create new span for features
        spanResult = await client.spans.create(targetLayer.id, [tokenId], value);
        
        // Only do optimistic update if not skipping (to preserve focus)
        if (!skipOptimisticUpdate) {
          setDocument(prevDocument => {
            const updatedDocument = JSON.parse(JSON.stringify(prevDocument));
            const textLayer = updatedDocument.textLayers?.[0];
            const tokenLayer = textLayer?.tokenLayers?.[0];
            const spanLayers = tokenLayer?.spanLayers || [];
            
            // Find the features layer and add the new span
            const featuresLayerDoc = spanLayers.find(layer => layer.id === targetLayer.id);
            if (featuresLayerDoc) {
              if (!featuresLayerDoc.spans) {
                featuresLayerDoc.spans = [];
              }
              featuresLayerDoc.spans.push({
                ...spanResult,
                tokens: [tokenId],
                value: value
              });
            }
            
            return updatedDocument;
          });
        }
        
      } else {
        // For other fields (lemma, upos, xpos), find existing span or create new one
        const existingSpan = spans.find(span => {
          if (span.tokens && span.tokens.length > 0) {
            return span.tokens.includes(tokenId);
          }
          return span.begin === tokenId;
        });
        
        if (existingSpan) {
          // Update existing span
          spanResult = await client.spans.update(existingSpan.id, value);
          
          // Only do optimistic update if not skipping (to preserve focus)
          if (!skipOptimisticUpdate) {
            setDocument(prevDocument => {
              const updatedDocument = JSON.parse(JSON.stringify(prevDocument));
              const textLayer = updatedDocument.textLayers?.[0];
              const tokenLayer = textLayer?.tokenLayers?.[0];
              const spanLayers = tokenLayer?.spanLayers || [];
              
              // Find the correct layer and update the span
              spanLayers.forEach(layer => {
                if (layer.spans) {
                  const spanIndex = layer.spans.findIndex(span => span.id === existingSpan.id);
                  if (spanIndex !== -1) {
                    layer.spans[spanIndex] = {
                      ...layer.spans[spanIndex],
                      value: value
                    };
                  }
                }
              });
              
              return updatedDocument;
            });
          }
          
        } else if (targetLayer) {
          // Create new span
          spanResult = await client.spans.create(targetLayer.id, [tokenId], value);
          
          // Only do optimistic update if not skipping (to preserve focus)
          if (!skipOptimisticUpdate) {
            setDocument(prevDocument => {
              const updatedDocument = JSON.parse(JSON.stringify(prevDocument));
              const textLayer = updatedDocument.textLayers?.[0];
              const tokenLayer = textLayer?.tokenLayers?.[0];
              const spanLayers = tokenLayer?.spanLayers || [];
              
              // Find the correct layer and add the new span
              const targetLayerDoc = spanLayers.find(layer => layer.id === targetLayer.id);
              if (targetLayerDoc) {
                if (!targetLayerDoc.spans) {
                  targetLayerDoc.spans = [];
                }
                targetLayerDoc.spans.push({
                  ...spanResult,
                  tokens: [tokenId],
                  value: value
                });
              }
              
              return updatedDocument;
            });
          }
          
        } else {
          // Need to create the layer first
          console.warn(`Layer for ${field} not found, cannot create annotation`);
          return;
        }
      }

      // Clear any previous errors on successful update
      setError('');
      
    } catch (error) {
      console.error(`Failed to update ${field}:`, error);
      setError(`Failed to update ${field}: ${error.message}`);
      // On error, refresh the data to ensure consistency
      await fetchData();
    }
  };

  // Handle feature deletion
  const handleFeatureDelete = async (spanId) => {
    try {
      const client = getClient();
      
      // Delete the span
      await client.spans.delete(spanId);
      
      // Optimistically remove the feature span from local state
      setDocument(prevDocument => {
        const updatedDocument = JSON.parse(JSON.stringify(prevDocument));
        const textLayer = updatedDocument.textLayers?.[0];
        const tokenLayer = textLayer?.tokenLayers?.[0];
        const spanLayers = tokenLayer?.spanLayers || [];
        
        // Find features layer and remove the span
        spanLayers.forEach(layer => {
          if (layer.name === 'Features' && layer.spans) {
            layer.spans = layer.spans.filter(span => span.id !== spanId);
          }
        });
        
        return updatedDocument;
      });
      
      // Clear any previous errors
      setError('');
      
    } catch (error) {
      console.error('Failed to delete feature:', error);
      setError(`Failed to delete feature: ${error.message}`);
      // On error, refresh the data to ensure consistency
      await fetchData();
    }
  };

  // Handle relation creation
  const handleRelationCreate = async (sourceSpanId, targetSpanId, deprel) => {
    try {
      const client = getClient();
      const layerInfo = getLayerInfo();
      
      if (!layerInfo.relationLayer) {
        setError('Relation layer not found. Please ensure the project is properly configured.');
        return;
      }
      
      // First, find and delete any existing incoming relations to the target
      const existingRelations = layerInfo.relationLayer.relations || [];
      const incomingRelations = existingRelations.filter(rel => rel.target === targetSpanId);
      
      // Delete existing incoming relations
      for (const existingRel of incomingRelations) {
        try {
          await client.relations.delete(existingRel.id);
        } catch (error) {
          console.warn('Failed to delete existing relation:', error);
        }
      }
      
      
      let relation = null;
      
      // For ROOT relations (self-pointing), we'll use a special handling
      if (sourceSpanId === targetSpanId) {
        // First, delete any existing incoming relations to the target span
        const targetIncomingRelations = existingRelations.filter(rel => rel.target === targetSpanId);
        for (const existingRel of targetIncomingRelations) {
          try {
            await client.relations.delete(existingRel.id);
          } catch (error) {
            console.warn('Failed to delete existing incoming relation to target:', error);
          }
        }
        
        // Create a self-pointing relation (source = target) to represent ROOT
        const apiResponse = await client.relations.create(
          layerInfo.relationLayer.id,
          targetSpanId,
          targetSpanId,
          deprel || 'root'
        );
        
        relation = {
          id: apiResponse.id || apiResponse,
          source: targetSpanId,
          target: targetSpanId,
          value: deprel || 'root'
        };
      } else {
        // Create the relation - API returns only ID, so construct full object
        const apiResponse = await client.relations.create(
          layerInfo.relationLayer.id,
          sourceSpanId,
          targetSpanId,
          deprel || 'dep'
        );
        
        relation = {
          id: apiResponse.id || apiResponse,
          source: sourceSpanId,
          target: targetSpanId,
          value: deprel || 'dep'
        };
      }
      
      // Optimistically update local state
      setDocument(prevDocument => {
        const updatedDocument = JSON.parse(JSON.stringify(prevDocument));
        const textLayer = updatedDocument.textLayers?.[0];
        const tokenLayer = textLayer?.tokenLayers?.[0];
        const lemmaLayer = tokenLayer?.spanLayers?.find(l => l.name === 'Lemma');
        
        if (lemmaLayer) {
          // Ensure relation layer structure exists
          if (!lemmaLayer.relationLayers) {
            lemmaLayer.relationLayers = [];
          }
          if (!lemmaLayer.relationLayers[0]) {
            lemmaLayer.relationLayers[0] = {
              id: layerInfo.relationLayer.id,
              name: 'Relation',
              relations: []
            };
          }
          if (!lemmaLayer.relationLayers[0].relations) {
            lemmaLayer.relationLayers[0].relations = [];
          }
          
          // Remove any existing incoming relations in local state
          if (sourceSpanId === targetSpanId) {
            // For ROOT relations, remove any existing incoming relations to the target
            lemmaLayer.relationLayers[0].relations = lemmaLayer.relationLayers[0].relations.filter(
              rel => rel.target !== targetSpanId
            );
            
            // Also remove any existing self-pointing relations (other ROOT relations)
            lemmaLayer.relationLayers[0].relations = lemmaLayer.relationLayers[0].relations.filter(
              rel => !(rel.source === targetSpanId && rel.target === targetSpanId)
            );
          } else {
            // For regular relations, remove any existing incoming relations to the target
            lemmaLayer.relationLayers[0].relations = lemmaLayer.relationLayers[0].relations.filter(
              rel => rel.target !== targetSpanId
            );
            
            // Also remove any existing ROOT relations (self-pointing) to the target
            lemmaLayer.relationLayers[0].relations = lemmaLayer.relationLayers[0].relations.filter(
              rel => !(rel.source === targetSpanId && rel.target === targetSpanId)
            );
          }
          
          // Add the new relation
          lemmaLayer.relationLayers[0].relations.push(relation);
        }
        
        return updatedDocument;
      });
      
      setError('');
    } catch (error) {
      console.error('Failed to create relation:', error);
      setError(`Failed to create relation: ${error.message}`);
      await fetchData();
    }
  };

  // Handle relation update
  const handleRelationUpdate = async (relationId, deprel) => {
    try {
      const client = getClient();
      
      // Update the relation value (DEPREL)
      const updatedRelation = await client.relations.update(relationId, deprel);
      
      // Optimistically update local state
      setDocument(prevDocument => {
        const updatedDocument = JSON.parse(JSON.stringify(prevDocument));
        const textLayer = updatedDocument.textLayers?.[0];
        const tokenLayer = textLayer?.tokenLayers?.[0];
        const lemmaLayer = tokenLayer?.spanLayers?.find(l => l.name === 'Lemma');
        
        if (lemmaLayer && lemmaLayer.relationLayers?.[0]?.relations) {
          const relationIndex = lemmaLayer.relationLayers[0].relations.findIndex(r => r.id === relationId);
          if (relationIndex !== -1) {
            lemmaLayer.relationLayers[0].relations[relationIndex] = {
              ...lemmaLayer.relationLayers[0].relations[relationIndex],
              value: deprel
            };
          }
        }
        
        return updatedDocument;
      });
      
      setError('');
    } catch (error) {
      console.error('Failed to update relation:', error);
      setError(`Failed to update relation: ${error.message}`);
      await fetchData();
    }
  };

  // Handle relation deletion
  const handleRelationDelete = async (relationId) => {
    try {
      const client = getClient();
      const layerInfo = getLayerInfo();
      
      // First check if this is a ROOT relation by finding the actual relation
      const allRelations = layerInfo.relationLayer?.relations || [];
      const relationToDelete = allRelations.find(rel => rel.id === relationId);
      
      // Delete the relation (both ROOT and regular relations are just relations)
      await client.relations.delete(relationId);
      
      // Optimistically update local state
      setDocument(prevDocument => {
        const updatedDocument = JSON.parse(JSON.stringify(prevDocument));
        const textLayer = updatedDocument.textLayers?.[0];
        const tokenLayer = textLayer?.tokenLayers?.[0];
        const lemmaLayer = tokenLayer?.spanLayers?.find(l => l.name === 'Lemma');
        
        if (lemmaLayer && lemmaLayer.relationLayers?.[0]?.relations) {
          lemmaLayer.relationLayers[0].relations = lemmaLayer.relationLayers[0].relations.filter(
            r => r.id !== relationId
          );
        }
        
        
        return updatedDocument;
      });
      
      setError('');
    } catch (error) {
      console.error('Failed to delete relation:', error);
      setError(`Failed to delete relation: ${error.message}`);
      await fetchData();
    }
  };

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