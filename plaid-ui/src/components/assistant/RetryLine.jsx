import { RotateCcw } from 'lucide-react';
import { Button } from '../ui/button.jsx';

// The line under a turn that has no answer (`retryNote` in resume.js says
// which), with Retry beside it. A read-only transcript passes no `onRetry`
// and gets the line alone.
export const RetryLine = ({ note, onRetry = null, disabled = false }) => (
  <div className="flex items-center gap-3 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
    <span className="flex-1">{note}</span>
    {onRetry && (
      <Button type="button" size="sm" variant="outline" onClick={onRetry} disabled={disabled}>
        <RotateCcw className="h-4 w-4" /> Retry
      </Button>
    )}
  </div>
);
