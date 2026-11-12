import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface CopyButtonProps {
  /** What the button copies, e.g. "Copy code": its tooltip and accessible name. */
  label: string;
  /** Whether this button's value was just copied; shows a tick in place of the copy icon. */
  copied: boolean;
  onCopy: () => void;
}

/** An icon button that copies a value and confirms it. Pair it with `useCopyFeedback`. */
export function CopyButton({ label, copied, onCopy }: CopyButtonProps) {
  return (
    <Button
      variant={copied ? 'secondary' : 'ghost'}
      size="icon"
      className="h-8 w-8 shrink-0"
      onClick={onCopy}
      title={copied ? 'Copied' : label}
      aria-label={copied ? `Copied: ${label}` : label}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
    </Button>
  );
}
