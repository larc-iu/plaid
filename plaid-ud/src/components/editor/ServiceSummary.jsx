import { Info } from 'lucide-react';
import { getServiceSummary } from '@larc-iu/plaid-client';
import { SafeMarkdown } from '@ui/components/ui/markdown';
import { Button } from '@ui/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@ui/components/ui/popover';

// Info popover showing a service's self-provided summary (markdown via
// extras.summary, else the short description). The summary is written by
// whoever wrote the service, so it goes through the shared SafeMarkdown, which
// renders no raw HTML and sanitizes link protocols.
export function ServiceSummary({ service }) {
  const summary = getServiceSummary(service);
  if (!service || !summary) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="tw h-7 w-7 text-muted-foreground"
          aria-label={`About ${service.serviceName || 'service'}`}
        >
          <Info className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-80 w-96 overflow-y-auto">
        {service.serviceName && <p className="mb-1 text-sm font-semibold">{service.serviceName}</p>}
        <SafeMarkdown className="text-sm text-muted-foreground">{summary}</SafeMarkdown>
      </PopoverContent>
    </Popover>
  );
}
