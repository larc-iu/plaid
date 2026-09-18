import React, { useEffect, useState } from 'react';
import { SentenceBlock } from './SentenceBlock.jsx';
import { readProjectLanguage } from '../../../utils/umrLayerUtils.js';
import { loadFrames } from '../../../domain/lexicon.js';

// The frame file of the project's language, once it has loaded; null for a
// language without one, or until it arrives.
const NO_PROBLEMS = Object.freeze([]);

const useFrames = (languageTag) => {
  const [frames, setFrames] = useState(null);
  useEffect(() => {
    let live = true;
    setFrames(null);
    loadFrames(languageTag).then((f) => live && setFrames(f));
    return () => {
      live = false;
    };
  }, [languageTag]);
  return frames;
};

// The document as a column of sentence blocks. Reads the document it is
// handed, live or a snapshot, so a past state draws as readily as the
// present one.
export const UmrCanvas = ({ doc, readOnly = true }) => {
  const frames = useFrames(readProjectLanguage(doc.project));
  const graph = doc.graph;
  const problems = doc.problemsBySentence;
  const sentences = graph.sentences;
  if (sentences.length === 0) {
    return (
      <p className="py-10 text-center text-muted-foreground">
        No sentences. Import a .umr file, or add text to this document in Plaid IGT or Plaid UD.
      </p>
    );
  }
  return (
    <div className="umr-canvas-list">
      {sentences.map((sentence) => (
        <SentenceBlock
          key={sentence.tokenId}
          doc={doc}
          sentence={sentence}
          nodesById={graph.nodesById}
          dataVersion={doc.dataVersion}
          direction={doc.textDirection}
          readOnly={readOnly}
          frames={frames}
          problems={problems.get(sentence.index) || NO_PROBLEMS}
        />
      ))}
    </div>
  );
};
