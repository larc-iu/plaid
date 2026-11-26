// A cited sentence from an app this one cannot draw: the place it names and
// the sentence's text, when the citation carries it. Used by PLAIN_ASSISTANT
// (plainCitations.js) in place of the app's own card.
import { t, tx } from '../../lib/i18n.js';

export const PlainCitationCard = ({ c }) => (
  <div className="my-2 rounded-md border px-3 py-2 text-sm">
    <div className="text-xs font-medium text-muted-foreground">
      {c.documentName
        ? tx('<bdi>{name}</bdi>, sentence {n}', {
            name: c.documentName,
            n: c.sentence,
            bdi: (x) => <bdi>{x}</bdi>,
          })
        : t('document, sentence {n}', { n: c.sentence })}
    </div>
    {typeof c.text === 'string' && c.text && (
      <p dir="auto" className="mt-1 font-text">
        {c.text}
      </p>
    )}
  </div>
);
