import { Notice } from '@ui/components/shared/Notice.jsx';

// A settings save not made because values in use are not in a closed list:
// each field's count and most frequent values, as `refusedBySave` gives them.
export const RefusedValuesNotice = ({ fields, className }) => (
  <Notice tone="warning" role="alert" className={className} data-testid="tagset-refused">
    <div>Not saved. These values are in use and not in the list:</div>
    {fields.map((f) => (
      <div key={f.layerId}>
        <span className="font-medium">{f.field}</span>: {f.count}{' '}
        {f.count === 1 ? 'annotation' : 'annotations'},{' '}
        {f.values.map((v, i) => (
          <span key={i}>
            {i > 0 && ', '}
            <span className="font-mono">{String(v.value)}</span> ({v.count})
          </span>
        ))}
        {f.valueCount > f.values.length && `, and ${f.valueCount - f.values.length} more`}
      </div>
    ))}
  </Notice>
);
