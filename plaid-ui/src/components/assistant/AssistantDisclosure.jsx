import { Info } from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.jsx';

// What the people running an assistant want its users to know before using
// it: where the model runs, where what is sent to it goes, anything else.
// Plaid cannot know any of that for a given site, so the operator states it
// when starting the assistant (`--disclosure`) and it arrives here in the
// service's `extras.disclosure`, shown in their words and said to be theirs.

const HEADING = 'From the people running this assistant';

/** Shown in a conversation with nothing in it yet, above the app's own empty state. */
export const DisclosureNotice = ({ text }) =>
  text ? (
    <div
      className="rounded-lg border bg-muted/40 px-3 py-2 text-sm"
      data-testid="assistant-disclosure"
    >
      <p className="mb-1 text-xs font-medium text-muted-foreground">{HEADING}</p>
      <p dir="auto" className="whitespace-pre-line">
        {text}
      </p>
    </div>
  ) : null;

/** The same, behind an icon in the header, once the conversation has begun. */
export const DisclosureButton = ({ text }) =>
  text ? (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" title="About this assistant">
          <Info className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 text-sm">
        <p className="mb-1 text-xs font-medium text-muted-foreground">{HEADING}</p>
        <p dir="auto" className="whitespace-pre-line">
          {text}
        </p>
      </PopoverContent>
    </Popover>
  ) : null;
