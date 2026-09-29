import { Button } from '../ui/button';
import { Notice } from './Notice.jsx';
import { useRetryWhenBack } from '../../hooks/useRetryWhenBack.js';

/**
 * A page's read failed: what failed, and Retry. The read is also tried again
 * when the network comes back or the window gets the focus again, so a page
 * left open through an outage recovers by itself.
 */
export const LoadError = ({ children, onRetry, className }) => {
  useRetryWhenBack(!!onRetry, onRetry);
  return (
    <Notice tone="error" role="alert" className={className}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{children}</span>
        {onRetry && (
          <Button size="sm" variant="outline" onClick={() => onRetry()}>
            Retry
          </Button>
        )}
      </div>
    </Notice>
  );
};
