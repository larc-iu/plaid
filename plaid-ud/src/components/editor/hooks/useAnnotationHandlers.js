import { useCallback } from 'react';
import { useAuth } from '../../../contexts/AuthContext.jsx';

export const useAnnotationHandlers = (document, setDocument, setError, layerInfo, refreshData) => {
  const { getClient } = useAuth();

  const handleAnnotationUpdate = useCallback(async (tokenId, field, value) => {
    try {
      const client = getClient();
      if (!client) return;
      
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
        
        spanResult = await client.spans.create(targetLayer.id, [tokenId], value);
        
        // Update local state
        setDocument(prevDocument => {
          const updatedDocument = JSON.parse(JSON.stringify(prevDocument));
          const textLayer = updatedDocument.textLayers?.[0];
          const tokenLayer = textLayer?.tokenLayers?.[0];
          const spanLayers = tokenLayer?.spanLayers || [];
          
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

          // Update local state
          setDocument(prevDocument => {
            const updatedDocument = JSON.parse(JSON.stringify(prevDocument));
            const textLayer = updatedDocument.textLayers?.[0];
            const tokenLayer = textLayer?.tokenLayers?.[0];
            const spanLayers = tokenLayer?.spanLayers || [];
            
            spanLayers.forEach(layer => {
              if (layer.spans) {
                const spanIndex = layer.spans.findIndex(span => span.id === existingSpan.id);
                if (spanIndex !== -1) {
                  layer.spans[spanIndex].value = value;
                }
              }
            });
            
            return updatedDocument;
          });
          
        } else if (targetLayer) {
          // Create new span
          spanResult = await client.spans.create(targetLayer.id, [tokenId], value);
          
          // Update local state
          setDocument(prevDocument => {
            const updatedDocument = JSON.parse(JSON.stringify(prevDocument));
            const textLayer = updatedDocument.textLayers?.[0];
            const tokenLayer = textLayer?.tokenLayers?.[0];
            const spanLayers = tokenLayer?.spanLayers || [];
            
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
          
        } else {
          console.warn(`Layer for ${field} not found, cannot create annotation`);
          return;
        }
      }

      setError('');
      
    } catch (error) {
      console.error(`Failed to update ${field}:`, error);
      setError(`Failed to update ${field}: ${error.message}`);
      await refreshData();
    }
  }, [layerInfo, document]);

  const handleFeatureDelete = useCallback(async (spanId) => {
    try {
      const client = getClient();
      if (!client) return;
      
      await client.spans.delete(spanId);
      
      setDocument(prevDocument => {
        const updatedDocument = JSON.parse(JSON.stringify(prevDocument));
        const textLayer = updatedDocument.textLayers?.[0];
        const tokenLayer = textLayer?.tokenLayers?.[0];
        const spanLayers = tokenLayer?.spanLayers || [];
        
        spanLayers.forEach(layer => {
          if (layer.name === 'Features' && layer.spans) {
            layer.spans = layer.spans.filter(span => span.id !== spanId);
          }
        });
        
        return updatedDocument;
      });
      
      setError('');
      
    } catch (error) {
      console.error('Failed to delete feature:', error);
      setError(`Failed to delete feature: ${error.message}`);
      await refreshData();
    }
  }, [layerInfo]);

  const handleRelationCreate = useCallback(async (sourceSpanId, targetSpanId, deprel) => {
    try {
      const client = getClient();
      if (!client) return;
      
      if (!layerInfo.relationLayer) {
        setError('Relation layer not found. Please ensure the project is properly configured.');
        return;
      }

      if (!layerInfo.lemmaLayer) {
        setError('Lemma layer not found. Cannot create dependency relation.');
        return;
      }

      const ensureLemmaSpan = async (candidateId) => {
        if (!candidateId || candidateId === 'ROOT') {
          return null;
        }

        const lemmaLayer = layerInfo.lemmaLayer;
        const lemmaSpans = lemmaLayer.spans || [];

        // Direct match on span ID
        const existingById = lemmaSpans.find(span => span.id === candidateId);
        if (existingById) {
          return existingById.id;
        }

        // Match by token membership
        const tokenId = candidateId;
        const existingByToken = lemmaSpans.find(span => {
          const spanTokensRaw = span.tokens && span.tokens.length > 0 ? span.tokens : (span.begin ? [span.begin] : []);
          const spanTokens = Array.isArray(spanTokensRaw) ? spanTokensRaw : [];
          return spanTokens.some(tokenEntry => {
            if (!tokenEntry) return false;
            if (typeof tokenEntry === 'string') {
              return tokenEntry === tokenId;
            }
            if (typeof tokenEntry === 'object') {
              return tokenEntry.id === tokenId || tokenEntry.tokenId === tokenId || tokenEntry.token === tokenId;
            }
            return false;
          });
        });
        if (existingByToken) {
          return existingByToken.id;
        }

        if (!lemmaLayer.id) {
          setError('Lemma layer is missing an identifier. Cannot create lemma span.');
          return null;
        }

        const textLayer = document?.textLayers?.[0];
        const rawText = textLayer?.text;
        const textBody = typeof rawText === 'string' ? rawText : rawText?.body || '';
        const tokenLayer = textLayer?.tokenLayers?.[0];
        const token = tokenLayer?.tokens?.find(t => t.id === tokenId);
        const hasOffsets = token && typeof token.begin === 'number' && typeof token.end === 'number' && typeof textBody === 'string';
        const lemmaValue = hasOffsets
          ? textBody.substring(token.begin, token.end)
          : token?.form || token?.text || '';

        const apiResponse = await client.spans.create(lemmaLayer.id, [tokenId], lemmaValue);
        const createdSpanId = apiResponse.id || apiResponse;
        const createdSpan = {
          id: createdSpanId,
          tokens: [tokenId],
          value: lemmaValue
        };

        // Update layerInfo cache immediately to avoid duplicate creations within this call
        if (layerInfo.lemmaLayer) {
          if (!layerInfo.lemmaLayer.spans) {
            layerInfo.lemmaLayer.spans = [];
          }
          const alreadyCached = layerInfo.lemmaLayer.spans.some(span => span.id === createdSpanId);
          if (!alreadyCached) {
            layerInfo.lemmaLayer.spans.push({ ...createdSpan });
          }
        }

        // Update local document state so derived hooks receive the new span
        setDocument(prevDocument => {
          const updatedDocument = JSON.parse(JSON.stringify(prevDocument));
          const updatedTextLayer = updatedDocument.textLayers?.[0];
          const updatedTokenLayer = updatedTextLayer?.tokenLayers?.[0];
          const lemmaLayerDoc = updatedTokenLayer?.spanLayers?.find(layer => layer.id === lemmaLayer.id);

          if (lemmaLayerDoc) {
            if (!lemmaLayerDoc.spans) {
              lemmaLayerDoc.spans = [];
            }
            const existsIndex = lemmaLayerDoc.spans.findIndex(span => span.id === createdSpanId);
            if (existsIndex === -1) {
              lemmaLayerDoc.spans.push({ ...createdSpan });
            }
          }

          return updatedDocument;
        });

        return createdSpanId;
      };

      const resolvedSourceId = await ensureLemmaSpan(sourceSpanId);
      const resolvedTargetId = await ensureLemmaSpan(targetSpanId);

      if (!resolvedSourceId || !resolvedTargetId) {
        console.warn('Unable to create relation because lemma spans could not be resolved:', {
          sourceSpanId,
          targetSpanId
        });
        return;
      }

      // First, find and delete any existing incoming relations to the target
      const existingRelations = layerInfo.relationLayer.relations || [];
      const incomingRelations = existingRelations.filter(rel => rel.target === resolvedTargetId);
      
      for (const existingRel of incomingRelations) {
        try {
          await client.relations.delete(existingRel.id);
        } catch (error) {
          console.warn('Failed to delete existing relation:', error);
        }
      }
      
      let relation = null;
      
      // For ROOT relations (self-pointing), we'll use a special handling
      if (resolvedSourceId === resolvedTargetId) {
        const apiResponse = await client.relations.create(
          layerInfo.relationLayer.id,
          resolvedTargetId,
          resolvedTargetId,
          deprel || 'root'
        );
        
        relation = {
          id: apiResponse.id || apiResponse,
          source: resolvedTargetId,
          target: resolvedTargetId,
          value: deprel || 'root'
        };
      } else {
        const apiResponse = await client.relations.create(
          layerInfo.relationLayer.id,
          resolvedSourceId,
          resolvedTargetId,
          deprel || 'dep'
        );
        
        relation = {
          id: apiResponse.id || apiResponse,
          source: resolvedSourceId,
          target: resolvedTargetId,
          value: deprel || 'dep'
        };
      }

      // Update local state
      setDocument(prevDocument => {
        const updatedDocument = JSON.parse(JSON.stringify(prevDocument));
        const textLayer = updatedDocument.textLayers?.[0];
        const tokenLayer = textLayer?.tokenLayers?.[0];
        const lemmaLayer = tokenLayer?.spanLayers?.find(l => l.name === 'Lemma');
        
        if (lemmaLayer) {
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
          lemmaLayer.relationLayers[0].relations = lemmaLayer.relationLayers[0].relations.filter(
            rel => rel.target !== resolvedTargetId
          );
          
          // Add the new relation
          lemmaLayer.relationLayers[0].relations.push(relation);
        }
        
        return updatedDocument;
      });
      
      setError('');
    } catch (error) {
      console.error('Failed to create relation:', error);
      setError(`Failed to create relation: ${error.message}`);
      await refreshData();
    }
  }, [layerInfo]);

  const handleRelationUpdate = useCallback(async (relationId, deprel) => {
    try {
      const client = getClient();
      if (!client) return;
      
      await client.relations.update(relationId, deprel);
      
      setDocument(prevDocument => {
        const updatedDocument = JSON.parse(JSON.stringify(prevDocument));
        const textLayer = updatedDocument.textLayers?.[0];
        const tokenLayer = textLayer?.tokenLayers?.[0];
        const lemmaLayer = tokenLayer?.spanLayers?.find(l => l.name === 'Lemma');
        
        if (lemmaLayer && lemmaLayer.relationLayers?.[0]?.relations) {
          const relationIndex = lemmaLayer.relationLayers[0].relations.findIndex(r => r.id === relationId);
          if (relationIndex !== -1) {
            lemmaLayer.relationLayers[0].relations[relationIndex].value = deprel;
          }
        }
        
        return updatedDocument;
      });
      
      setError('');
    } catch (error) {
      console.error('Failed to update relation:', error);
      setError(`Failed to update relation: ${error.message}`);
      await refreshData();
    }
  }, [layerInfo]);

  const handleRelationDelete = useCallback(async (relationId) => {
    try {
      const client = getClient();
      if (!client) return;
      
      await client.relations.delete(relationId);
      
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
      await refreshData();
    }
  }, [layerInfo]);

  const handleMwtCreate = useCallback(async (tokenIds, form) => {
    try {
      const client = getClient();
      if (!client) return;
      
      if (!layerInfo.mwtLayer) {
        console.warn('MWT layer not found, cannot create multi-word token');
        return;
      }
      
      if (!tokenIds || tokenIds.length < 2) {
        throw new Error('Multi-word token requires at least 2 tokens');
      }
      
      // Validate tokens are contiguous (optional check for good UX)
      const sortedTokenIds = [...tokenIds].sort((a, b) => a.localeCompare(b));
      
      const spanResult = await client.spans.create(layerInfo.mwtLayer.id, tokenIds, form);
      
      // Update local state
      setDocument(prevDocument => {
        const updatedDocument = JSON.parse(JSON.stringify(prevDocument));
        const textLayer = updatedDocument.textLayers?.[0];
        const tokenLayer = textLayer?.tokenLayers?.[0];
        const spanLayers = tokenLayer?.spanLayers || [];
        
        const mwtLayerDoc = spanLayers.find(layer => layer.id === layerInfo.mwtLayer.id);
        if (mwtLayerDoc) {
          if (!mwtLayerDoc.spans) {
            mwtLayerDoc.spans = [];
          }
          mwtLayerDoc.spans.push({
            ...spanResult,
            tokens: tokenIds,
            value: form
          });
        }
        
        return updatedDocument;
      });
      
      setError('');
      
    } catch (error) {
      console.error('Failed to create MWT:', error);
      setError(`Failed to create multi-word token: ${error.message}`);
      await refreshData();
    }
  }, [layerInfo]);

  const handleMwtUpdate = useCallback(async (spanId, form) => {
    try {
      const client = getClient();
      if (!client) return;
      
      await client.spans.update(spanId, form);
      
      // Update local state
      setDocument(prevDocument => {
        const updatedDocument = JSON.parse(JSON.stringify(prevDocument));
        const textLayer = updatedDocument.textLayers?.[0];
        const tokenLayer = textLayer?.tokenLayers?.[0];
        const spanLayers = tokenLayer?.spanLayers || [];
        
        spanLayers.forEach(layer => {
          if (layer.name === 'Multi-word Tokens' && layer.spans) {
            const spanIndex = layer.spans.findIndex(span => span.id === spanId);
            if (spanIndex !== -1) {
              layer.spans[spanIndex].value = form;
            }
          }
        });
        
        return updatedDocument;
      });
      
      setError('');
      
    } catch (error) {
      console.error('Failed to update MWT:', error);
      setError(`Failed to update multi-word token: ${error.message}`);
      await refreshData();
    }
  }, [layerInfo]);

  const handleMwtDelete = useCallback(async (spanId) => {
    try {
      const client = getClient();
      if (!client) return;
      
      await client.spans.delete(spanId);
      
      // Update local state
      setDocument(prevDocument => {
        const updatedDocument = JSON.parse(JSON.stringify(prevDocument));
        const textLayer = updatedDocument.textLayers?.[0];
        const tokenLayer = textLayer?.tokenLayers?.[0];
        const spanLayers = tokenLayer?.spanLayers || [];
        
        spanLayers.forEach(layer => {
          if (layer.name === 'Multi-word Tokens' && layer.spans) {
            layer.spans = layer.spans.filter(span => span.id !== spanId);
          }
        });
        
        return updatedDocument;
      });
      
      setError('');
      
    } catch (error) {
      console.error('Failed to delete MWT:', error);
      setError(`Failed to delete multi-word token: ${error.message}`);
      await refreshData();
    }
  }, [layerInfo]);

  return {
    handleAnnotationUpdate,
    handleFeatureDelete,
    handleRelationCreate,
    handleRelationUpdate,
    handleRelationDelete,
    handleMwtCreate,
    handleMwtUpdate,
    handleMwtDelete
  };
};
