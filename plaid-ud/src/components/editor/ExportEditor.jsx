import { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useDocumentData } from './hooks/useDocumentData.js';
import { useSentenceData } from './hooks/useSentenceData.js';
import { getUdLayerInfo, missingUdLayerLabels } from '../../utils/udLayerUtils.js';
import { DocumentTabs } from './DocumentTabs.jsx';

const UNDERSCORE = '_';

export const ExportEditor = () => {
  const { projectId, documentId } = useParams();
  const [copiedToClipboard, setCopiedToClipboard] = useState(false);

  const {
    document: doc,
    project,
    loading,
    error
  } = useDocumentData(projectId, documentId);

  // Reuse the annotation read model: each sentence row's `tokens` are morphemes
  // (the numbered CoNLL-U rows), grouped under words (multiword tokens).
  const sentenceData = useSentenceData(doc);

  // Generate CoNLL-U format from document data
  const conlluContent = useMemo(() => {
    if (!doc) return '';

    const layerInfo = getUdLayerInfo(doc);
    if (!layerInfo.isConfigured) {
      const missing = missingUdLayerLabels(layerInfo.missingLayers);
      const missingList = missing.length > 0 ? missing.join(', ') : 'required UD layers';
      return `# Project configuration incomplete: ${missingList}`;
    }

    if (!sentenceData || sentenceData.length === 0) {
      return '# No tokenized content available';
    }

    const esc = (v) => (v == null || v === '') ? UNDERSCORE : String(v);
    const serializeFeats = (feats) => {
      if (!feats || feats.length === 0) return UNDERSCORE;
      const values = feats.map(f => f.value).filter(Boolean).sort();
      return values.length > 0 ? values.join('|') : UNDERSCORE;
    };

    const output = [];
    output.push(`# newdoc id = ${doc.name || 'unknown'}`);

    sentenceData.forEach((sentence, sentIdx) => {
      if (sentIdx > 0) output.push('');

      const morphemes = sentence.tokens; // ordered; one per CoNLL-U numbered row

      // lemma span id -> 1-based row id (for head resolution)
      const idByLemmaSpanId = new Map();
      morphemes.forEach((m, i) => {
        if (m.spanIds?.lemma) idByLemmaSpanId.set(m.spanIds.lemma, i + 1);
      });

      // incoming dependency relation per target lemma span id
      const incomingByTarget = new Map();
      (sentence.relations || []).forEach(rel => incomingByTarget.set(rel.target, rel));

      // Prefer a `sent_id` carried on the sentence token's metadata (round-tripped
      // from import); otherwise synthesize one from the doc name + index.
      const sentMeta = sentence.sentenceToken?.metadata || {};
      const sentIdFromMeta = sentMeta.sent_id;
      if (sentIdFromMeta) {
        output.push(`# sent_id = ${sentIdFromMeta}`);
      } else {
        output.push(`# sent_id = ${doc.name || 'unknown'}-${sentIdx + 1}`);
      }
      // Emit any arbitrary `# k = v` metadata carried on the sentence token,
      // sorted alphabetically (matches the original exporter's behavior). If
      // the metadata supplies `text`, the loop emits it; otherwise we fall back
      // to the sentence's substring of the document body. Don't join morpheme
      // forms — MWT morphemes share a span and would yield wrong text
      // (e.g. "de les" instead of "des"). Skip `sent_id` (already emitted above).
      let hasTextMetadata = false;
      Object.keys(sentMeta).sort().forEach(key => {
        if (key === 'sent_id') return;
        const value = sentMeta[key];
        if (key === 'text') hasTextMetadata = true;
        if (value === true) output.push(`# ${key}`);
        else output.push(`# ${key} = ${value}`);
      });
      if (!hasTextMetadata) {
        output.push(`# text = ${(sentence.text || '').trim()}`);
      }

      let i = 0;
      while (i < morphemes.length) {
        const word = morphemes[i].word;

        // Gather consecutive morphemes belonging to the same word (a multiword
        // token has more than one).
        let groupLen = 1;
        if (word) {
          while (i + groupLen < morphemes.length && morphemes[i + groupLen].word?.id === word.id) {
            groupLen += 1;
          }
        }

        // Multiword-token line spanning the group. The surface form for an MWT
        // must come from the word token's persisted metadata (`form`), set by
        // the importer — slicing the body can be wrong (e.g. "del" vs "de el"
        // when the morphemes share the word's full extent). Fall back to the
        // body substring only if the metadata is missing. Also carry the
        // original MISC (e.g. SpaceAfter=No, Typo=Yes) from word metadata.
        if (groupLen > 1) {
          const wordMeta = morphemes[i].word?.metadata || {};
          const fallbackForm = morphemes[i].wordForm || UNDERSCORE;
          const surfaceForm = wordMeta.form || fallbackForm;
          const mwtMisc = wordMeta.misc || UNDERSCORE;
          output.push([
            `${i + 1}-${i + groupLen}`, surfaceForm,
            UNDERSCORE, UNDERSCORE, UNDERSCORE, UNDERSCORE, UNDERSCORE, UNDERSCORE, UNDERSCORE, mwtMisc
          ].join('\t'));
        }

        // One line per morpheme.
        for (let k = 0; k < groupLen; k++) {
          const m = morphemes[i + k];
          const id = i + k + 1;
          const form = m.tokenForm || UNDERSCORE;
          const lemma = esc(m.lemma?.value);
          const upos = esc(m.upos?.value);
          const xpos = esc(m.xpos?.value);
          const feats = serializeFeats(m.feats);

          let head = UNDERSCORE;
          let deprel = UNDERSCORE;
          const rel = m.spanIds?.lemma ? incomingByTarget.get(m.spanIds.lemma) : null;
          if (rel) {
            if (rel.source === rel.target) {
              head = 0;
              deprel = rel.value || UNDERSCORE;
            } else {
              const h = idByLemmaSpanId.get(rel.source);
              if (h != null) {
                head = h;
                deprel = rel.value || UNDERSCORE;
              }
            }
          }
          const deps = (head === UNDERSCORE || deprel === UNDERSCORE) ? UNDERSCORE : `${head}:${deprel}`;

          output.push([id, form, lemma, upos, xpos, feats, head, deprel, deps, UNDERSCORE].join('\t'));
        }

        i += groupLen;
      }
    });

    return output.join('\n');
  }, [doc, sentenceData]);

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
    const a = window.document.createElement('a');
    a.href = url;
    a.download = `${doc?.name || 'document'}.conllu`;
    window.document.body.appendChild(a);
    a.click();
    window.document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return <div className="text-center text-gray-600 py-8">Loading document...</div>;
  }

  if (!doc || !project) {
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
        document={doc}
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
