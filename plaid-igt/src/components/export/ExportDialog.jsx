import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ExportRunner } from './ExportRunner.jsx';

// Project-page export: pick a saved preset, choose the scope (whole project or
// selected documents), run. Presets are configured under Settings → Export.
export const ExportDialog = ({ open, onOpenChange, ...runnerProps }) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-xl">
      <DialogHeader className="sr-only">
        <DialogTitle>Export</DialogTitle>
      </DialogHeader>
      {open && (
        <ExportRunner
          onDone={() => onOpenChange(false)}
          onClose={() => onOpenChange(false)}
          {...runnerProps}
        />
      )}
    </DialogContent>
  </Dialog>
);
