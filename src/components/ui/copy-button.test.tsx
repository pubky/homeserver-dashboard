import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CopyButton } from './copy-button';

describe('CopyButton', () => {
  it('is named by its label and copies on click', () => {
    const onCopy = vi.fn();
    render(<CopyButton label="Copy code" copied={false} onCopy={onCopy} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it('says so once copied', () => {
    render(<CopyButton label="Copy code" copied onCopy={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Copied: Copy code' }).getAttribute('title')).toBe('Copied');
  });
});
