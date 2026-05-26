import { useState, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useLayerInfo } from './hooks/useLayerInfo.js';
import { getUdLayerInfo, missingUdLayerLabels, containsToken } from '../../utils/udLayerUtils.js';
import { TokenVisualizer } from './TokenVisualizer.jsx';
import { DocumentTabs } from './DocumentTabs.jsx';

export const TextEditor = () => {
  const { projectId, documentId } = useParams();
  const [document, setDocument] = useState(null);
  const [project, setProject] = useState(null);
  const [textContent, setTextContent] = useState('');
  const [originalTokenizedText, setOriginalTokenizedText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [lastSaved, setLastSaved] = useState(null);
  const { getClient } = useAuth();
  const layerInfo = useLayerInfo(document);

  const loadDocument = async () => {
    const client = getClient();
    if (!client) {
      window.location.href = '/login';
      return;
    }
    const [projectData, documentData] = await Promise.all([
      client.projects.get(projectId),
      client.documents.get(documentId, true) // includes all layer data
    ]);
    setProject(projectData);
    setDocument(documentData);

    const info = getUdLayerInfo(documentData);
    const text = info.textLayer?.text;
    if (text?.body) {
      setTextContent(text.body);
      const hasTokens = (info.sentenceTokenLayer?.tokens || []).length > 0
        || (info.wordTokenLayer?.tokens || []).length > 0;
      if (hasTokens && !originalTokenizedText) {
        setOriginalTokenizedText(text.body);
      }
    }
    setError('');
  };

  // Fetch initial data (with loading screen)
  const fetchData = async () => {
    try {
      setLoading(true);
      await loadDocument();
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

  // Refresh data without loading screen (after operations)
  const refreshData = async () => {
    try {
      await loadDocument();
    } catch (err) {
      if (err.status === 401) {
        window.location.href = '/login';
        return;
      }
      setError('Failed to load document: ' + (err.message || 'Unknown error'));
      console.error('Error fetching data:', err);
    }
  };

  useEffect(() => {
    fetchData();
  }, [projectId, documentId]);

  // Fix #8: the misconfig state used to be funneled through `setError`, which
  // (a) clobbered operational errors and (b) never cleared itself. The misconfig
  // banner is now derived from `layerInfo` directly in the render path; the red
  // error banner is reserved for op-level errors set via `setError`.

  const contains = containsToken;

  // Helper data derived from the three-layer token hierarchy.
  // Memoized — fix #10: avoid recomputing this per call (handlers called it
  // multiple times and render called it once more on top).
  const layerData = useMemo(() => {
    if (!document) return { layerInfo };

    const {
      textLayer,
      sentenceTokenLayer,
      wordTokenLayer,
      morphemeTokenLayer,
      lemmaLayer,
      formLayer,
      relationLayer
    } = layerInfo;

    const text = textLayer?.text;
    const sentenceTokens = sentenceTokenLayer?.tokens || [];
    const wordTokens = wordTokenLayer?.tokens || [];
    const morphemeTokens = morphemeTokenLayer?.tokens || [];

    // morpheme id -> Form span value (overrides the text substring for display)
    const morphemeForms = new Map();
    (formLayer?.spans || []).forEach(span => {
      const tokenId = Array.isArray(span.tokens) && span.tokens.length > 0 ? span.tokens[0] : null;
      if (tokenId != null && span.value != null) morphemeForms.set(tokenId, span.value);
    });

    return {
      layerInfo,
      textLayer,
      text,
      sentenceTokenLayer,
      wordTokenLayer,
      morphemeTokenLayer,
      sentenceTokens,
      wordTokens,
      morphemeTokens,
      lemmaLayer,
      formLayer,
      relationLayer,
      morphemeForms
    };
  }, [document, layerInfo]);

  // Compatibility shim so handler code reads `const { ... } = getLayerData();`
  // unchanged. Returns the memoized object.
  const getLayerData = () => layerData;

  // Save text function
  const saveText = async () => {
    if (!textContent.trim() || saving) return;
    try {
      setSaving(true);
      const client = getClient();
      const { textLayer, text } = getLayerData();

      if (text?.id) {
        await client.texts.update(text.id, textContent);
      } else if (textLayer?.id) {
        await client.texts.create(textLayer.id, documentId, textContent);
      }

      setLastSaved(new Date());
      setError('');
      setOriginalTokenizedText(textContent);
      await refreshData();
    } catch (err) {
      setError('Failed to save text: ' + (err.message || 'Unknown error'));
      console.error('Error saving text:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleTextChange = (e) => {
    setTextContent(e.target.value);
    if (lastSaved) setLastSaved(null);
  };

  // Tokenize: build the full sentence > word > morpheme hierarchy top-down.
  const handleTokenize = async () => {
    const {
      text,
      sentenceTokenLayer,
      wordTokenLayer,
      morphemeTokenLayer,
      lemmaLayer,
      sentenceTokens,
      wordTokens,
      morphemeTokens
    } = getLayerData();

    if (!textContent.trim()) {
      setError('Please enter some text before tokenizing');
      return;
    }
    if (!text?.id) {
      setError('Please save the text first before tokenizing');
      return;
    }
    if (!sentenceTokenLayer?.id || !wordTokenLayer?.id || !morphemeTokenLayer?.id) {
      setError('Token layers are not fully configured');
      return;
    }
    if (sentenceTokens.length || wordTokens.length || morphemeTokens.length) {
      setError('Tokens already exist. Use "Clear Tokens" before re-tokenizing.');
      return;
    }

    if (saving) return;
    try {
      setSaving(true);
      setError('');
      const client = getClient();
      const body = textContent;
      const len = body.length;

      // 1. Sentences: a gap-free partition of [0, len). Runs of newlines end a sentence
      //    and are kept with the preceding sentence so there are no gaps.
      const sentenceRanges = [];
      let start = 0;
      const newlineRun = /\n+/g;
      let m;
      while ((m = newlineRun.exec(body)) !== null) {
        sentenceRanges.push([start, m.index + m[0].length]);
        start = m.index + m[0].length;
      }
      if (start < len) sentenceRanges.push([start, len]);
      if (sentenceRanges.length === 0) sentenceRanges.push([0, len]);

      // 2. Words: non-whitespace runs.
      const wordRanges = [];
      let idx = 0;
      for (const part of body.split(/(\s+)/)) {
        if (part.trim()) wordRanges.push([idx, idx + part.length]);
        idx += part.length;
      }

      // Create the token hierarchy atomically in one batch (sentences -> words ->
      // morphemes). Batch ops run sequentially server-side, so each nested layer
      // sees the one above it; if any step fails the whole hierarchy rolls back
      // (no orphaned tokens). The batch returns each op's ids, so we read the
      // morpheme ids back for the lemma spans.
      client.beginBatch();
      client.tokens.bulkCreate(sentenceRanges.map(([begin, end]) => ({
        tokenLayerId: sentenceTokenLayer.id, text: text.id, begin, end
      })));
      let morphemeResultIndex = -1;
      if (wordRanges.length > 0) {
        client.tokens.bulkCreate(wordRanges.map(([begin, end]) => ({
          tokenLayerId: wordTokenLayer.id, text: text.id, begin, end
        })));
        client.tokens.bulkCreate(wordRanges.map(([begin, end]) => ({
          tokenLayerId: morphemeTokenLayer.id, text: text.id, begin, end
        })));
        morphemeResultIndex = 2; // [sentences, words, morphemes]
      }
      const batchResults = await client.submitBatch();
      const morphemeIds = morphemeResultIndex >= 0
        ? (batchResults[morphemeResultIndex]?.body?.ids || [])
        : [];

      // Default lemma spans on morphemes (lemma = surface form), in a follow-up
      // call since they depend on the new morpheme ids.
      if (lemmaLayer?.id && morphemeIds.length) {
        const lemmaOps = morphemeIds.map((tokenId, i) => ({
          spanLayerId: lemmaLayer.id,
          tokens: [tokenId],
          value: body.substring(wordRanges[i][0], wordRanges[i][1])
        }));
        try {
          await client.spans.bulkCreate(lemmaOps);
        } catch (lemmaError) {
          console.error('Failed to create lemma spans:', lemmaError);
        }
      }

      setOriginalTokenizedText(textContent);
      await refreshData();
    } catch (err) {
      setError('Failed to create tokens: ' + (err.message || 'Unknown error'));
      console.error('Error tokenizing:', err);
      await fetchData();
    } finally {
      setSaving(false);
    }
  };

  // Clear all tokens by deleting the sentence (root) tokens — cascades to words,
  // morphemes, spans and relations server-side.
  const handleClearTokens = async () => {
    const { sentenceTokens, wordTokens, morphemeTokens } = getLayerData();

    if (!confirm('Are you sure you want to clear all tokens? This action cannot be undone.')) {
      return;
    }

    if (saving) return;
    try {
      setSaving(true);
      const client = getClient();
      if (sentenceTokens.length > 0) {
        await client.tokens.bulkDelete(sentenceTokens.map(t => t.id));
      } else if (wordTokens.length > 0) {
        await client.tokens.bulkDelete(wordTokens.map(t => t.id));
      } else if (morphemeTokens.length > 0) {
        await client.tokens.bulkDelete(morphemeTokens.map(t => t.id));
      }
      setOriginalTokenizedText('');
      await refreshData();
    } catch (err) {
      setError('Failed to clear tokens: ' + (err.message || 'Unknown error'));
      console.error('Error clearing tokens:', err);
      await fetchData();
    } finally {
      setSaving(false);
    }
  };

  // Toggle a sentence boundary at a character position (a word's begin offset).
  // The sentence layer is partitioning, so this is a split (add) or merge (remove).
  const handleSentenceBoundaryToggle = async (charPos) => {
    if (saving) return;
    try {
      setSaving(true);
      const client = getClient();
      const { sentenceTokens, morphemeTokens, lemmaLayer, relationLayer } = getLayerData();

      const startsHere = sentenceTokens.find(s => s.begin === charPos);
      if (startsHere) {
        // Remove the boundary: merge with the preceding sentence. Merging only
        // widens a sentence, so no dependency relation can become invalid.
        const prevSent = sentenceTokens.find(s => s.end === charPos);
        if (!prevSent) return;
        await client.tokens.merge(prevSent.id, startsHere.id);
        setDocument(prev => {
          const next = JSON.parse(JSON.stringify(prev));
          const info = getUdLayerInfo(next);
          if (info.sentenceTokenLayer?.tokens) {
            const p = info.sentenceTokenLayer.tokens.find(t => t.id === prevSent.id);
            if (p) p.end = startsHere.end;
            info.sentenceTokenLayer.tokens = info.sentenceTokenLayer.tokens.filter(t => t.id !== startsHere.id);
          }
          return next;
        });
        return;
      }

      // Add a boundary: split the containing sentence at charPos.
      const containing = sentenceTokens.find(s => s.begin < charPos && charPos < s.end);
      if (!containing) return;

      // Any dependency relation whose endpoints land on opposite sides of charPos
      // would cross the new sentence boundary; delete those in the same atomic
      // batch as the split so a relation never spans two sentences. (UD relations
      // are sentence-internal — an app-level invariant the server doesn't model,
      // so the client maintains it here.)
      const beginByMorpheme = new Map(morphemeTokens.map(t => [t.id, t.begin]));
      const beginByLemmaSpan = new Map();
      (lemmaLayer?.spans || []).forEach(span => {
        const tid = Array.isArray(span.tokens) && span.tokens.length > 0 ? span.tokens[0] : span.begin;
        if (tid != null && beginByMorpheme.has(tid)) beginByLemmaSpan.set(span.id, beginByMorpheme.get(tid));
      });
      const crossing = (relationLayer?.relations || []).filter(rel => {
        if (rel.source === rel.target) return false; // root self-loop never crosses
        const s = beginByLemmaSpan.get(rel.source);
        const t = beginByLemmaSpan.get(rel.target);
        if (s == null || t == null) return false;
        return (s < charPos) !== (t < charPos);
      });

      client.beginBatch();
      client.tokens.split(containing.id, charPos);
      crossing.forEach(rel => client.relations.delete(rel.id));
      const res = await client.submitBatch();
      const newRightSentId = res[0]?.body?.id;
      const removedRelIds = new Set(crossing.map(r => r.id));
      setDocument(prev => {
        const next = JSON.parse(JSON.stringify(prev));
        const info = getUdLayerInfo(next);
        if (info.sentenceTokenLayer?.tokens) {
          const s = info.sentenceTokenLayer.tokens.find(t => t.id === containing.id);
          const oldEnd = containing.end;
          if (s) s.end = charPos;
          if (newRightSentId) {
            info.sentenceTokenLayer.tokens.push({ id: newRightSentId, begin: charPos, end: oldEnd });
          }
        }
        if (info.relationLayer?.relations && removedRelIds.size) {
          info.relationLayer.relations = info.relationLayer.relations.filter(r => !removedRelIds.has(r.id));
        }
        return next;
      });
    } catch (error) {
      console.error('Sentence boundary toggle failed:', error);
      setError('Failed to update sentence boundary: ' + (error.message || 'Unknown error'));
      await fetchData();
    } finally {
      setSaving(false);
    }
  };

  // Set a word's morphemes from a list of forms. One form = an ordinary word;
  // multiple forms = a multiword token. Every morpheme spans the FULL word extent
  // (overlap allowed); a Form span carries each morpheme's surface form.
  //
  // Two-batch atomicity: (1) delete-old + create-new morphemes run as ONE atomic
  // batch — the word is never left half-updated. (2) Form and Lemma spans for
  // the new morphemes run as a SECOND atomic batch, because batch ops cannot
  // reference ids produced earlier in the same batch (the new morpheme ids
  // come back from batch #1, so the spans must follow).
  const handleSetWordMorphemes = async (word, forms) => {
    if (saving) return;
    try {
      setSaving(true);
      const client = getClient();
      const { text, morphemeTokenLayer, lemmaLayer, formLayer, morphemeTokens } = getLayerData();
      if (!morphemeTokenLayer?.id || !text?.id) {
        throw new Error('Morpheme layer not configured');
      }

      const cleanForms = forms.map(f => (f || '').trim()).filter(f => f.length > 0);
      if (cleanForms.length === 0) return;

      // Batch 1 — atomic morpheme replacement.
      const existing = morphemeTokens.filter(m => contains(word, m));
      client.beginBatch();
      if (existing.length) client.tokens.bulkDelete(existing.map(m => m.id));
      client.tokens.bulkCreate(cleanForms.map((_, i) => ({
        tokenLayerId: morphemeTokenLayer.id,
        text: text.id,
        begin: word.begin,
        end: word.end,
        precedence: i
      })));
      const setResults = await client.submitBatch();
      const ids = setResults[setResults.length - 1]?.body?.ids || [];

      // Batch 2 — atomic Form + Lemma spans for the new morphemes (single
      // beginBatch/submitBatch so they cannot half-apply against each other).
      const wordSubstring = textContent.substring(word.begin, word.end);
      const formOps = [];
      const lemmaOps = [];
      ids.forEach((tokenId, i) => {
        const form = cleanForms[i];
        // A Form span is only needed when the form differs from the substring
        // (i.e. real MWT components); 1:1 words fall back to the substring.
        if (formLayer?.id && (cleanForms.length > 1 || form !== wordSubstring)) {
          formOps.push({ spanLayerId: formLayer.id, tokens: [tokenId], value: form });
        }
        if (lemmaLayer?.id) {
          lemmaOps.push({ spanLayerId: lemmaLayer.id, tokens: [tokenId], value: form });
        }
      });
      if (formOps.length || lemmaOps.length) {
        client.beginBatch();
        if (formOps.length) client.spans.bulkCreate(formOps);
        if (lemmaOps.length) client.spans.bulkCreate(lemmaOps);
        await client.submitBatch();
      }

      await refreshData();
    } catch (error) {
      console.error('Failed to set word morphemes:', error);
      setError('Failed to set morphemes: ' + (error.message || 'Unknown error'));
      await fetchData();
    } finally {
      setSaving(false);
    }
  };

  // Delete a word token (cascades its morphemes and their spans).
  const handleWordDelete = async (wordId) => {
    if (saving) return;
    try {
      setSaving(true);
      const client = getClient();
      const { wordTokens, morphemeTokens, lemmaLayer } = getLayerData();
      const word = wordTokens.find(w => w.id === wordId);
      const removedMorphIds = new Set(word ? morphemeTokens.filter(m => contains(word, m)).map(m => m.id) : []);
      const removedLemmaSpanIds = new Set(
        (lemmaLayer?.spans || [])
          .filter(s => Array.isArray(s.tokens) && s.tokens.some(t => removedMorphIds.has(t)))
          .map(s => s.id)
      );
      await client.tokens.delete(wordId);
      // Optimistic local cascade (mirrors server cascade); no refetch on success.
      setDocument(prev => {
        const next = JSON.parse(JSON.stringify(prev));
        const info = getUdLayerInfo(next);
        if (info.wordTokenLayer?.tokens) {
          info.wordTokenLayer.tokens = info.wordTokenLayer.tokens.filter(t => t.id !== wordId);
        }
        if (info.morphemeTokenLayer?.tokens) {
          info.morphemeTokenLayer.tokens = info.morphemeTokenLayer.tokens.filter(t => !removedMorphIds.has(t.id));
        }
        (info.morphemeTokenLayer?.spanLayers || []).forEach(sl => {
          if (Array.isArray(sl.spans)) {
            sl.spans = sl.spans.filter(s => !(Array.isArray(s.tokens) && s.tokens.some(t => removedMorphIds.has(t))));
          }
        });
        if (info.relationLayer?.relations) {
          info.relationLayer.relations = info.relationLayer.relations.filter(r => !removedLemmaSpanIds.has(r.source) && !removedLemmaSpanIds.has(r.target));
        }
        return next;
      });
    } catch (error) {
      console.error('Word deletion failed:', error);
      setError('Failed to delete word: ' + (error.message || 'Unknown error'));
      await fetchData();
    } finally {
      setSaving(false);
    }
  };

  // Manually create a word (e.g. from a text selection) plus its 1:1 morpheme
  // and a default lemma. Word + morpheme go in one atomic batch (the morpheme
  // nests in the just-created word); the lemma span follows since it needs the
  // morpheme id.
  const handleWordCreate = async (begin, end) => {
    if (saving) return;
    try {
      const client = getClient();
      const { text, sentenceTokenLayer, wordTokenLayer, morphemeTokenLayer, lemmaLayer, sentenceTokens } = getLayerData();
      if (!text?.id || !sentenceTokenLayer?.id || !wordTokenLayer?.id || !morphemeTokenLayer?.id) {
        throw new Error('Token layers are not fully configured');
      }
      // Fix #3: a word must land inside some sentence (Sentences is a
      // partitioning layer). If sentences already tile the doc but the
      // selection falls outside every one, refuse — adding a new sentence into
      // an already-tiled doc would break partitioning. Only when no sentences
      // exist yet do we transparently create one covering the whole text.
      const selRange = { begin, end };
      if (sentenceTokens.length > 0 && !sentenceTokens.some(s => contains(s, selRange))) {
        setError('Selection must be inside an existing sentence');
        return;
      }
      setSaving(true);
      client.beginBatch();
      if (sentenceTokens.length === 0) {
        client.tokens.bulkCreate([{ tokenLayerId: sentenceTokenLayer.id, text: text.id, begin: 0, end: textContent.length }]);
      }
      client.tokens.bulkCreate([{ tokenLayerId: wordTokenLayer.id, text: text.id, begin, end }]);
      client.tokens.bulkCreate([{ tokenLayerId: morphemeTokenLayer.id, text: text.id, begin, end }]);
      const res = await client.submitBatch();
      const sentenceId = sentenceTokens.length === 0 ? res[0]?.body?.ids?.[0] : null;
      const wordId = res[res.length - 2]?.body?.ids?.[0];
      const morphemeId = res[res.length - 1]?.body?.ids?.[0];
      let lemmaSpanId = null;
      if (lemmaLayer?.id && morphemeId) {
        try {
          const lr = await client.spans.bulkCreate([{ spanLayerId: lemmaLayer.id, tokens: [morphemeId], value: textContent.substring(begin, end) }]);
          lemmaSpanId = lr?.ids?.[0] || null;
        } catch (lemmaError) {
          console.error('Failed to create lemma span:', lemmaError);
        }
      }
      // Optimistic local update — no refetch on success.
      setDocument(prev => {
        const next = JSON.parse(JSON.stringify(prev));
        const info = getUdLayerInfo(next);
        if (sentenceId && info.sentenceTokenLayer) {
          if (!Array.isArray(info.sentenceTokenLayer.tokens)) info.sentenceTokenLayer.tokens = [];
          info.sentenceTokenLayer.tokens.push({ id: sentenceId, begin: 0, end: textContent.length });
        }
        if (wordId && info.wordTokenLayer) {
          if (!Array.isArray(info.wordTokenLayer.tokens)) info.wordTokenLayer.tokens = [];
          info.wordTokenLayer.tokens.push({ id: wordId, begin, end });
        }
        if (morphemeId && info.morphemeTokenLayer) {
          if (!Array.isArray(info.morphemeTokenLayer.tokens)) info.morphemeTokenLayer.tokens = [];
          info.morphemeTokenLayer.tokens.push({ id: morphemeId, begin, end });
        }
        if (lemmaSpanId && morphemeId && info.lemmaLayer) {
          if (!Array.isArray(info.lemmaLayer.spans)) info.lemmaLayer.spans = [];
          info.lemmaLayer.spans.push({ id: lemmaSpanId, tokens: [morphemeId], value: textContent.substring(begin, end) });
        }
        return next;
      });
      // After the very first manual creation, treat the current text as the
      // tokenized baseline (mirrors what tokenize does), so the dirty banner
      // doesn't fire just because tokens now exist.
      if (!originalTokenizedText) setOriginalTokenizedText(textContent);
    } catch (error) {
      console.error('Word creation failed:', error);
      setError('Failed to create word: ' + (error.message || 'Unknown error'));
      await fetchData();
    } finally {
      setSaving(false);
    }
  };

  // Adjust a word's character extent (boundary editing). Keep its morphemes in
  // lockstep by resizing them to the new extent too — all in one atomic batch so
  // the word and its morphemes never disagree. On success we mutate local state
  // directly (no refetch) so keyboard nudges stay snappy.
  const handleWordUpdate = async (wordId, begin, end) => {
    if (saving) return;
    try {
      setSaving(true);
      const client = getClient();
      const { wordTokens, morphemeTokens } = getLayerData();
      const word = wordTokens.find(w => w.id === wordId);
      const morphIds = word ? morphemeTokens.filter(m => contains(word, m)).map(m => m.id) : [];
      client.beginBatch();
      client.tokens.update(wordId, begin, end);
      morphIds.forEach(mid => client.tokens.update(mid, begin, end));
      await client.submitBatch();
      // Optimistic local update — no refetch on success.
      setDocument(prev => {
        const next = JSON.parse(JSON.stringify(prev));
        const info = getUdLayerInfo(next);
        const w = info.wordTokenLayer?.tokens?.find(t => t.id === wordId);
        if (w) { w.begin = begin; w.end = end; }
        morphIds.forEach(mid => {
          const m = info.morphemeTokenLayer?.tokens?.find(t => t.id === mid);
          if (m) { m.begin = begin; m.end = end; }
        });
        return next;
      });
    } catch (error) {
      console.error('Word update failed:', error);
      setError('Failed to update word: ' + (error.message || 'Unknown error'));
      await fetchData();
    } finally {
      setSaving(false);
    }
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

  const { sentenceTokens, wordTokens, morphemeTokens, morphemeForms } = getLayerData();

  // Check if text is dirty (different from what was tokenized or saved)
  const isTextDirty = originalTokenizedText && textContent !== originalTokenizedText;
  // Any tokens at all — including orphan morphemes — block re-tokenizing and
  // surface the Clear button, matching the handler's guard.
  const hasTokens = sentenceTokens.length > 0 || wordTokens.length > 0 || morphemeTokens.length > 0;

  // Detect projects whose token layers exist but were created without the
  // expected overlap-mode + parent chain (e.g. via an older plaid-client bundle
  // that silently dropped those args). The data model is recoverable but server
  // enforcement of nesting/partitioning won't kick in.
  //
  // Field names: the server stores `:token-layer/overlap-mode` and
  // `:token-layer/parent-token-layer`; plaid-client transforms them to
  // `overlapMode` and `parentTokenLayer` (namespace stripped, kebab→camel).
  // If neither field is even present we warn — the layer is structurally
  // unexpected and the misconfig check would silently false-positive.
  const layerHasShape = (l) =>
    !l || (Object.prototype.hasOwnProperty.call(l, 'overlapMode')
      && Object.prototype.hasOwnProperty.call(l, 'parentTokenLayer'));
  if (layerInfo.isConfigured
      && (!layerHasShape(layerInfo.sentenceTokenLayer)
          || !layerHasShape(layerInfo.wordTokenLayer)
          || !layerHasShape(layerInfo.morphemeTokenLayer))) {
    console.warn('UD token layer missing expected fields (overlapMode / parentTokenLayer). plaid-client field names may have changed.', {
      sentence: layerInfo.sentenceTokenLayer,
      word: layerInfo.wordTokenLayer,
      morpheme: layerInfo.morphemeTokenLayer
    });
  }
  const layersMisconfigured = Boolean(
    layerInfo.isConfigured &&
    layerInfo.sentenceTokenLayer && layerInfo.wordTokenLayer && layerInfo.morphemeTokenLayer &&
    (layerInfo.sentenceTokenLayer.overlapMode !== 'partitioning' ||
     layerInfo.wordTokenLayer.overlapMode !== 'non-overlapping' ||
     layerInfo.wordTokenLayer.parentTokenLayer !== layerInfo.sentenceTokenLayer.id ||
     layerInfo.morphemeTokenLayer.parentTokenLayer !== layerInfo.wordTokenLayer.id)
  );

  // Fix #8: render the project-misconfig banner directly from layerInfo
  // instead of routing it through `setError`, which clobbered op-level errors.
  const missingLayerLabels = !layerInfo.isConfigured
    ? missingUdLayerLabels(layerInfo.missingLayers)
    : [];

  return (
    <div>
      <DocumentTabs
        projectId={projectId}
        documentId={documentId}
        project={project}
        document={document}
      />

      {error && (
        <div className="mb-3 mx-6 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {missingLayerLabels.length > 0 && (
        <div className="mb-3 mx-6 rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
          Project configuration incomplete: {missingLayerLabels.join(', ')}.
        </div>
      )}

      {layersMisconfigured && (
        <div className="mb-3 mx-6 rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
          This project's token layers are missing their overlap-mode / parent
          configuration (likely created with an older client bundle). Tokenization
          will still work, but server-enforced nesting and partitioning won't.
          Consider recreating the project.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Text Content</h3>
          <textarea
            className="w-full min-h-[300px] p-4 border-2 border-gray-300 rounded-md font-mono text-sm leading-relaxed resize-y focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            value={textContent}
            onChange={handleTextChange}
            placeholder="Enter your text here. Use newlines to separate sentences.

Example:
The quick brown fox jumps over the lazy dog.
This is a second sentence for testing."
            rows={12}
          />

          <div className="flex items-center gap-3 mt-4">
            <button
              onClick={saveText}
              disabled={saving || !textContent.trim()}
              className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? 'Saving...' : 'Save Text'}
            </button>

            <button
              onClick={handleTokenize}
              disabled={saving || !textContent.trim() || isTextDirty || hasTokens}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              title={isTextDirty ? 'Please save text changes before tokenizing' : (hasTokens ? 'Clear tokens before re-tokenizing' : '')}
            >
              {saving ? 'Processing...' : 'Whitespace Tokenize'}
            </button>

            {hasTokens && (
              <button
                onClick={handleClearTokens}
                disabled={saving}
                className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              >
                Clear Tokens
              </button>
            )}

            <div className="ml-auto text-sm font-medium text-gray-600">
              {wordTokens.length} word{wordTokens.length !== 1 ? 's' : ''}, {sentenceTokens.length} sentence{sentenceTokens.length !== 1 ? 's' : ''}
            </div>
          </div>

          <div className="mt-2 text-sm">
            {saving && <span className="text-blue-600 italic">Processing...</span>}
            {!saving && lastSaved && (
              <span className="text-green-600">
                Saved: {lastSaved.toLocaleTimeString()}
              </span>
            )}
            {!saving && !lastSaved && textContent && isTextDirty && (
              <span className="text-yellow-600 italic">Unsaved changes</span>
            )}
          </div>
        </div>

        <div className="border border-gray-200 rounded-md p-4 bg-gray-50">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Token Visualization</h3>
          <TokenVisualizer
            text={textContent}
            originalText={originalTokenizedText}
            sentenceTokens={sentenceTokens}
            wordTokens={wordTokens}
            morphemeTokens={morphemeTokens}
            morphemeForms={morphemeForms}
            onWordCreate={handleWordCreate}
            onWordUpdate={handleWordUpdate}
            onWordDelete={handleWordDelete}
            onSentenceToggle={handleSentenceBoundaryToggle}
            onSetWordMorphemes={handleSetWordMorphemes}
            setError={setError}
          />
        </div>
      </div>
    </div>
  );
};
