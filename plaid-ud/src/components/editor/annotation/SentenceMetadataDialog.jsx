import { useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@ui/components/ui/dialog';
import { MetadataFields } from '../../common/MetadataFields.jsx';
import { metadataRows, metadataFieldError } from '../../../utils/udMetadata.js';

// Everything CoNLL-U writes above a sentence: `# sent_id`, `# text_en`, the
// fields this project declares and whatever else an import brought along. It is
// a dialog rather than a strip under the grid because a GUM sentence carries
// sixteen of these, and sixteen boxes laid across the editor bury the
// annotation they sit under.
//
// `# text` is not here: the exporter writes it from the document body, so a
// field that could edit it would silently desync the two.
export const SentenceMetadataDialog = ({
  open,
  onOpenChange,
  label,
  fields,
  values,
  readOnly,
  onCommit,
}) => {
  const rows = metadataRows(fields, values, 'sentence');
  // A sentence's `# k = v` lines are open-ended in CoNLL-U, so a reader can
  // write one this project never declared. The same rules apply as to a
  // declared field: `text` is the document's, `sent_id` is already here, and a
  // name has to survive a round trip through the format and the query engine.
  const validateName = useCallback(
    (name, taken) => metadataFieldError(name, 'sentence', taken),
    [],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Sentence metadata</DialogTitle>
          <DialogDescription>
            {readOnly
              ? `The CoNLL-U comment lines on ${label}.`
              : `The CoNLL-U comment lines on ${label}. Each field saves as you leave it; ` +
                'clearing one removes it.'}
          </DialogDescription>
        </DialogHeader>

        <MetadataFields
          rows={rows}
          values={values}
          readOnly={readOnly}
          onCommit={onCommit}
          validateName={validateName}
        />
      </DialogContent>
    </Dialog>
  );
};
