import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { SafeMarkdown } from '@/components/ui/markdown';
import { getServiceSummary } from '@larc-iu/plaid-client';

// Info popover showing a service's self-provided summary (markdown via
// extras.summary, else the short description).
export function ServiceSummary({ service }) {
  const summary = getServiceSummary(service);
  if (!service || !summary) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground"
          aria-label={`About ${service.serviceName || 'this service'}`}
        >
          <Info className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 max-h-80 overflow-auto">
        {service.serviceName && (
          <div className="text-sm font-medium mb-1">{service.serviceName}</div>
        )}
        <div className="text-sm text-muted-foreground">
          <SafeMarkdown>{summary}</SafeMarkdown>
        </div>
      </PopoverContent>
    </Popover>
  );
}
