import { Info } from 'lucide-react';
import Markdown from 'react-markdown';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { getServiceSummary } from '@larc-iu/plaid-client';

// Compact, lightly-styled markdown renderers. Inline styles keep them
// independent of the app's CSS reset / design system. react-markdown does not
// render raw HTML and sanitizes link protocols, so a service-supplied summary
// can't inject markup.
const mdComponents = {
  h1: ({ node: _node, ...p }) => <div style={{ fontWeight: 600, fontSize: '0.95rem', margin: '0.5em 0 0.2em' }} {...p} />,
  h2: ({ node: _node, ...p }) => <div style={{ fontWeight: 600, fontSize: '0.9rem', margin: '0.5em 0 0.2em' }} {...p} />,
  h3: ({ node: _node, ...p }) => <div style={{ fontWeight: 600, fontSize: '0.85rem', margin: '0.5em 0 0.2em' }} {...p} />,
  p: ({ node: _node, ...p }) => <p style={{ margin: '0.4em 0' }} {...p} />,
  ul: ({ node: _node, ...p }) => <ul style={{ margin: '0.3em 0', paddingLeft: '1.2em', listStyle: 'disc' }} {...p} />,
  ol: ({ node: _node, ...p }) => <ol style={{ margin: '0.3em 0', paddingLeft: '1.2em' }} {...p} />,
  li: ({ node: _node, ...p }) => <li style={{ margin: '0.15em 0' }} {...p} />,
  a: ({ node: _node, ...p }) => <a target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb', textDecoration: 'underline' }} {...p} />,
  code: ({ node: _node, ...p }) => <code style={{ background: 'rgba(0,0,0,0.06)', padding: '0 0.25em', borderRadius: 3 }} {...p} />,
  blockquote: ({ node: _node, ...p }) => <blockquote style={{ margin: '0.4em 0', paddingLeft: '0.8em', borderLeft: '3px solid rgba(0,0,0,0.15)', opacity: 0.85 }} {...p} />,
};

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
          <Markdown components={mdComponents}>{summary}</Markdown>
        </div>
      </PopoverContent>
    </Popover>
  );
}
