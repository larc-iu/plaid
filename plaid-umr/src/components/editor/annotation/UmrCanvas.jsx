import React from 'react';
import { SentenceBlock } from './SentenceBlock.jsx';

// The document as a column of sentence blocks. Reads the document it is
// handed, live or a snapshot, so a past state draws as readily as the
// present one.
export const UmrCanvas = ({ doc, readOnly = true }) => {
  const graph = doc.graph;
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
        />
      ))}
    </div>
  );
};
