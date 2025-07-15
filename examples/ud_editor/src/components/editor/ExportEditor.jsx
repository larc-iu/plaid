import { useState, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useDocumentData } from './hooks/useDocumentData.js';
import { DocumentTabs } from './DocumentTabs.jsx';

export const ExportEditor = () => {
  const { projectId, documentId } = useParams();
  const [copiedToClipboard, setCopiedToClipboard] = useState(false);
  
  const { 
    document, 
    project, 
    loading, 
    error 
  } = useDocumentData(projectId, documentId);

  // Generate CoNLL-U format from document data
  const conlluContent = useMemo(() => {
    if (!document) return '';

    const textLayer = document.textLayers?.[0];
    const text = textLayer?.text;
    const tokenLayer = textLayer?.tokenLayers?.[0];
    const tokens = tokenLayer?.tokens || [];
    
    if (!text?.body || tokens.length === 0) {
      return '# No tokenized content available';
    }

    // Get all span layers
    const spanLayers = tokenLayer?.spanLayers || [];
    const lemmaLayer = spanLayers.find(layer => layer.name === 'Lemma');
    const uposLayer = spanLayers.find(layer => layer.name === 'UPOS');
    const xposLayer = spanLayers.find(layer => layer.name === 'XPOS');
    const featuresLayer = spanLayers.find(layer => layer.name === 'Features');
    const sentenceLayer = spanLayers.find(layer => layer.name === 'Sentence');
    const mwtLayer = spanLayers.find(layer => layer.name === 'Multi-word Tokens');
    
    // Get relation layer
    const relationLayer = lemmaLayer?.relationLayers?.[0];
    const relations = relationLayer?.relations || [];
    
    // Sort tokens by position, then by precedence if available
    const sortedTokens = [...tokens].sort((a, b) => {
      if (a.begin !== b.begin) return a.begin - b.begin;
      // Use precedence if available, otherwise maintain order
      const aPrecedence = a.precedence ?? 0;
      const bPrecedence = b.precedence ?? 0;
      return aPrecedence - bPrecedence;
    });
    
    // Find sentence boundaries
    const sentenceSpans = sentenceLayer?.spans || [];
    const sentenceStartTokenIds = new Set(
      sentenceSpans.map(span => {
        if (span.tokens && span.tokens.length > 0) {
          return span.tokens[0];
        }
        return span.begin;
      }).filter(id => id != null)
    );

    // Group tokens into sentences
    const tokenSentences = [];
    let currentSentence = [];
    
    for (const token of sortedTokens) {
      if (sentenceStartTokenIds.has(token.id) && currentSentence.length > 0) {
        tokenSentences.push(currentSentence);
        currentSentence = [];
      }
      currentSentence.push(token);
    }
    
    if (currentSentence.length > 0) {
      tokenSentences.push(currentSentence);
    }

    // If no sentence boundaries, treat all tokens as one sentence
    if (tokenSentences.length === 0 && sortedTokens.length > 0) {
      tokenSentences.push(sortedTokens);
    }

    // Helper function to get span value for a token
    const getSpanValue = (tokenId, layer) => {
      if (!layer?.spans) return null;
      
      const span = layer.spans.find(span => {
        const spanTokens = span.tokens || [span.begin];
        return spanTokens.includes(tokenId);
      });
      
      return span?.value || null;
    };

    // Helper function to get feature spans for a token
    const getFeatureSpans = (tokenId) => {
      if (!featuresLayer?.spans) return [];
      
      return featuresLayer.spans.filter(span => {
        const spanTokens = span.tokens || [span.begin];
        return spanTokens.includes(tokenId) && span.value;
      });
    };

    // Helper function to serialize features
    const serializeFeatures = (featureSpans) => {
      if (featureSpans.length === 0) return '_';
      
      // Sort features alphabetically by value for consistency
      const sortedFeatures = featureSpans
        .map(span => span.value)
        .sort();
      
      return sortedFeatures.join('|');
    };

    // Helper function to get MWT spans for sentence tokens
    const getMwtSpansForSentence = (sentenceTokens) => {
      if (!mwtLayer?.spans) return [];
      
      const sentenceTokenIds = sentenceTokens.map(t => t.id);
      return mwtLayer.spans.filter(span => {
        const spanTokens = span.tokens || [];
        // Check if any of the span's tokens are in this sentence
        return spanTokens.some(tokenId => sentenceTokenIds.includes(tokenId));
      }).map(span => {
        const spanTokens = span.tokens || [];
        // Find start and end positions within this sentence
        const startIndex = Math.min(...spanTokens.map(tokenId => sentenceTokenIds.indexOf(tokenId)).filter(idx => idx !== -1));
        const endIndex = Math.max(...spanTokens.map(tokenId => sentenceTokenIds.indexOf(tokenId)).filter(idx => idx !== -1));
        
        // Compute form from constituent tokens
        const mwtTokens = spanTokens
          .map(tokenId => sentenceTokens.find(t => t.id === tokenId))
          .filter(Boolean)
          .sort((a, b) => a.begin - b.begin);
        const form = mwtTokens.map(token => text.body.slice(token.begin, token.end)).join('');
        
        return {
          start: startIndex + 1, // Convert to 1-based
          end: endIndex + 1,     // Convert to 1-based
          form: form,
          misc: span.metadata?.misc || '_'
        };
      }).sort((a, b) => a.start - b.start); // Sort by start position
    };

    // Helper function to find incoming relation for a token
    const findIncomingRelation = (tokenId) => {
      if (!lemmaLayer?.spans || !relations.length) return { head: '_', deprel: '_' };
      
      // Find lemma span for this token
      const lemmaSpan = lemmaLayer.spans.find(span => {
        const spanTokens = span.tokens || [span.begin];
        return spanTokens.includes(tokenId);
      });
      
      if (!lemmaSpan) return { head: '_', deprel: '_' };
      
      // Find relation where this lemma span is the target
      const incomingRelation = relations.find(rel => rel.target === lemmaSpan.id);
      
      if (!incomingRelation) return { head: '_', deprel: '_' };
      
      // Check if this is a root edge (self-referencing relation)
      if (incomingRelation.source === incomingRelation.target) {
        return { head: 0, deprel: incomingRelation.value || '_' };
      }
      
      // Find source lemma span
      const sourceSpan = lemmaLayer.spans.find(span => span.id === incomingRelation.source);
      if (!sourceSpan) return { head: '_', deprel: '_' };
      
      // Find first token of source span
      const sourceTokenId = sourceSpan.tokens?.[0] || sourceSpan.begin;
      if (!sourceTokenId) return { head: '_', deprel: '_' };
      
      // Find the position of source token in the current sentence
      const sentenceTokenIds = tokenSentences.flat().map(t => t.id);
      const sourceIndex = sentenceTokenIds.indexOf(sourceTokenId);
      const targetIndex = sentenceTokenIds.indexOf(tokenId);
      
      // Both tokens must be in the same sentence
      let currentSentenceStartIndex = 0;
      for (const sentence of tokenSentences) {
        const sentenceTokenIds = sentence.map(t => t.id);
        const sentenceSourceIndex = sentenceTokenIds.indexOf(sourceTokenId);
        const sentenceTargetIndex = sentenceTokenIds.indexOf(tokenId);
        
        if (sentenceTargetIndex !== -1 && sentenceSourceIndex !== -1) {
          // Both tokens are in this sentence
          return {
            head: sentenceSourceIndex + 1, // 1-based index
            deprel: incomingRelation.value || '_'
          };
        }
        
        currentSentenceStartIndex += sentence.length;
      }
      
      // Tokens are in different sentences or not found
      return { head: '_', deprel: '_' };
    };

    // Generate CoNLL-U output
    const output = [];
    
    // Add document metadata
    output.push(`# newdoc id = ${document.name || 'unknown'}`);
    
    // Process each sentence
    tokenSentences.forEach((sentenceTokens, sentenceIndex) => {
      // Add blank line before sentence (except for first sentence)
      if (sentenceIndex > 0) {
        output.push('');
      }
      
      // Add sentence metadata
      output.push(`# sent_id = ${document.name || 'unknown'}-${sentenceIndex + 1}`);
      
      // Find the sentence span for this sentence to get metadata
      let hasTextMetadata = false;
      if (sentenceSpans.length > 0 && sentenceTokens.length > 0) {
        const firstTokenId = sentenceTokens[0].id;
        const sentenceSpan = sentenceSpans.find(span => {
          const spanTokens = span.tokens || [span.begin];
          return spanTokens.includes(firstTokenId);
        });
        
        // Add sentence metadata if found
        if (sentenceSpan && sentenceSpan.metadata) {
          const metadata = sentenceSpan.metadata;
          
          // Sort metadata keys alphabetically (excluding special keys that go at top)
          const sortedKeys = Object.keys(metadata).sort();
          
          sortedKeys.forEach(key => {
            const value = metadata[key];
            if (key === 'text') {
              hasTextMetadata = true;
            }
            if (value === true) {
              // Handle boolean metadata (just the key)
              output.push(`# ${key}`);
            } else {
              // Handle key-value metadata
              output.push(`# ${key} = ${value}`);
            }
          });
        }
      }
      
      // Add sentence text only if not already provided in metadata
      if (!hasTextMetadata) {
        const sentenceText = sentenceTokens.map(token => 
          text.body.substring(token.begin, token.end)
        ).join(' ');
        output.push(`# text = ${sentenceText}`);
      }
      
      // Get MWT spans for this sentence
      const mwtSpans = getMwtSpansForSentence(sentenceTokens);
      
      // Process each token with MWT line insertion
      sentenceTokens.forEach((token, tokenIndex) => {
        const id = tokenIndex + 1;
        
        // Check if we need to output MWT lines before this token
        const mwtStartingHere = mwtSpans.filter(mwt => mwt.start === id);
        for (const mwt of mwtStartingHere) {
          // Output MWT line: "start-end\tform\t_\t_\t_\t_\t_\t_\t_\tmisc"
          const mwtRow = [
            `${mwt.start}-${mwt.end}`,
            mwt.form,
            '_',
            '_',
            '_',
            '_',
            '_',
            '_',
            '_',
            mwt.misc
          ].join('\t');
          output.push(mwtRow);
        }
        
        // Output regular token line
        const form = text.body.substring(token.begin, token.end);
        const lemma = getSpanValue(token.id, lemmaLayer) || '_';
        const upos = getSpanValue(token.id, uposLayer) || '_';
        const xpos = getSpanValue(token.id, xposLayer) || '_';
        const feats = serializeFeatures(getFeatureSpans(token.id));
        
        const { head, deprel } = findIncomingRelation(token.id);
        const deps = (head === 0 || deprel === '_') ? '_' : `${head}:${deprel}`;
        const misc = '_';
        
        // Format as tab-separated values
        const row = [
          id,
          form,
          lemma,
          upos,
          xpos,
          feats,
          head,
          deprel,
          deps,
          misc
        ].join('\t');
        
        output.push(row);
      });
    });
    
    return output.join('\n');
  }, [document]);

  const handleCopyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(conlluContent);
      setCopiedToClipboard(true);
      setTimeout(() => setCopiedToClipboard(false), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  const handleDownload = () => {
    const blob = new Blob([conlluContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${document?.name || 'document'}.conllu`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return <div className="text-center text-gray-600 py-8">Loading document...</div>;
  }

  if (!document || !project) {
    return (
      <div className="rounded-md bg-red-50 p-4">
        <p className="text-sm text-red-800">Document or project not found</p>
      </div>
    );
  }

  return (
    <div>
      <DocumentTabs 
        projectId={projectId}
        documentId={documentId}
        project={project}
        document={document}
      />

      <div className="mb-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">CoNLL-U Export</h3>
        
        {error && (
          <div className="rounded-md bg-red-50 p-4 mb-4">
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        <div className="flex gap-3 mb-4">
          <button
            onClick={handleCopyToClipboard}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
            </svg>
            {copiedToClipboard ? 'Copied!' : 'Copy to Clipboard'}
          </button>
          
          <button
            onClick={handleDownload}
            className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
            </svg>
            Download .conllu
          </button>
        </div>

        <div className="border border-gray-300 rounded-md">
          <textarea
            className="w-full p-4 font-mono text-sm bg-gray-50 rounded-md resize-y"
            value={conlluContent}
            readOnly
            rows={20}
            style={{ minHeight: '400px' }}
          />
        </div>
      </div>
    </div>
  );
};