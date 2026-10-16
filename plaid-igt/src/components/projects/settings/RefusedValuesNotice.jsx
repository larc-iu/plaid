import { Notice } from '@ui/components/shared/Notice.jsx';
import {
  REFUSED_LEAD,
  REFUSED_TITLE,
  countWord,
  moreText,
  unlistedParts,
} from './refusedValues.js';

// A settings save not made because values in use are not in a closed list:
// each field's count and most frequent values, as `refusedBySave` gives them,
// and of a composite value the parts not in the list.
export const RefusedValuesNotice = ({ fields, className }) => (
  <Notice tone="warning" role="alert" className={className} data-testid="tagset-refused">
    <div>
      {REFUSED_TITLE}. {REFUSED_LEAD}
    </div>
    {fields.map((f) => (
      <div key={f.layerId}>
        <span className="font-medium">{f.field}</span>: {countWord(f.count)},{' '}
        {f.values.map((v, i) => {
          const parts = unlistedParts(v);
          return (
            <span key={i}>
              {i > 0 && ', '}
              <span className="font-mono">{String(v.value)}</span> ({v.count}
              {parts && (
                <>
                  , <span className="font-mono">{parts}</span> not listed
                </>
              )}
              )
            </span>
          );
        })}
        {moreText(f)}
      </div>
    ))}
  </Notice>
);
