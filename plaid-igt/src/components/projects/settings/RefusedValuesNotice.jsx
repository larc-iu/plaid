import { Notice } from '@ui/components/shared/Notice.jsx';
import { t, tx } from '@ui/lib/i18n.js';
import {
  REFUSED_LEAD,
  REFUSED_TITLE,
  countWord,
  unlistedParts,
  withMore,
} from './refusedValues.js';

const mono = (c) => <span className="font-mono">{c}</span>;

// One value and its count, the parts of it not in the list in mono.
const ValueText = ({ v }) => {
  const parts = unlistedParts(v);
  if (!parts) {
    return (
      <>
        <span className="font-mono">{String(v.value)}</span> ({v.count})
      </>
    );
  }
  return tx('<mono>{value}</mono> ({n}, <mono>{parts}</mono> not listed)', {
    value: String(v.value),
    n: v.count,
    parts,
    mono,
  });
};

// A settings save not made because values in use are not in a closed list:
// each field's count and most frequent values, as `refusedBySave` gives them,
// and of a composite value the parts not in the list.
export const RefusedValuesNotice = ({ fields, className }) => (
  <Notice tone="warning" role="alert" className={className} data-testid="tagset-refused">
    <div>
      {t(REFUSED_TITLE)}. {t(REFUSED_LEAD)}
    </div>
    {fields.map((f) => (
      <div key={f.layerId}>
        {tx('<b>{field}</b>: {total}, {values}', {
          field: f.field,
          total: countWord(f.count, f.noun),
          values: withMore(
            f,
            f.values.map((v, i) => (
              <span key={i}>
                {i > 0 && ', '}
                <ValueText v={v} />
              </span>
            )),
            { nodes: true },
          ),
          b: (c) => <span className="font-medium">{c}</span>,
        })}
      </div>
    ))}
  </Notice>
);
