import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { ServiceSummary } from './ServiceSummary.jsx';
import { ServiceParamForm } from './ServiceParamForm.jsx';

// A spot's method and its options: the one block every run dialog uses, and
// the reason a built-in and a registered service look the same on screen.
// "Method" rather than "Service" or "Algorithm" because the list holds both.
export function ServiceMethodRow({ spot, disabled = false, label = 'Method', emptyHint }) {
  const { options, selection, choose, service, builtin, params } = spot;
  // What the chosen method does, in a line. A service's longer summary stays
  // behind the info popover.
  const description = service?.description || builtin?.description || null;
  if (!options.length) {
    return emptyHint ? <p className="text-sm text-muted-foreground">{emptyHint}</p> : null;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Label className="text-xs">{label}</Label>
        {service && <ServiceSummary service={service} />}
      </div>
      {/* One method is not a choice, so it is stated rather than offered. */}
      {options.length === 1 ? (
        <p className="text-sm">{options[0].label}</p>
      ) : (
        <Select value={selection ?? ''} onValueChange={choose} disabled={disabled}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {params.schema.length > 0 && (
        <>
          <ServiceParamForm
            schema={params.schema}
            values={params.values}
            errors={params.errors}
            onChange={params.setParam}
            disabled={disabled}
          />
          {params.isDirty && (
            <button
              type="button"
              onClick={params.reset}
              disabled={disabled}
              className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Reset options
            </button>
          )}
        </>
      )}
    </div>
  );
}
