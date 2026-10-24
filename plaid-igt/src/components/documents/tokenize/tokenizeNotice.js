// What a finished Tokenize says when the tokenizer found nothing to do: the
// reason code a service reports with zero counts (R23). Any other result gets
// the fixed copy (null).
//
// Pure, so it is tested on its own.
const NOTHING = {
  'no-text': 'The document has no text.',
  'no-words': 'No words found in the text.',
};

export const tokenizeNotice = (result) =>
  NOTHING[result?.reason]
    ? { level: 'warning', title: 'Nothing to tokenize', message: NOTHING[result.reason] }
    : null;
