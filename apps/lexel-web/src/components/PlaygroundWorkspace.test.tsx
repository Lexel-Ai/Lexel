import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InstallTabs } from './InstallTabs';
import { PlaygroundWorkspace } from './PlaygroundWorkspace';

afterEach(() => {
  cleanup();
});

describe('PlaygroundWorkspace', () => {
  it('loads the client Tier 0 engine, detects issues, applies safe fixes, and supports empty state', async () => {
    render(<PlaygroundWorkspace />);

    await waitFor(() => {
      expect(screen.getByLabelText('Draft input')).toBeTruthy();
    });

    expect(screen.getByText(/Slop Meter/i)).toBeTruthy();
    expect(screen.getByText(/0 bytes sent/i)).toBeTruthy();

    // Apply safe Tier 0 fixes and check UndoToast appears
    const applyBtn = screen.getByRole('button', { name: 'Apply safe Tier 0 fixes' });
    fireEvent.click(applyBtn);

    await waitFor(() => {
      expect(screen.getByText(/Revert to original/i)).toBeTruthy();
    });

    // Clear editor to verify honest empty state with recovery CTA
    fireEvent.click(screen.getByRole('button', { name: 'Clear editor' }));
    expect(screen.getByText('The editor is empty')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load AI-Slop LinkedIn sample' })).toBeTruthy();
  });

  it('adds and removes personal crutch words', async () => {
    render(<PlaygroundWorkspace />);

    await waitFor(() => {
      expect(screen.getByLabelText('Personal crutch-word bans')).toBeTruthy();
    });

    const input = screen.getByLabelText('Personal crutch-word bans');
    fireEvent.change(input, { target: { value: 'literally' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    expect(screen.getByText('literally')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove crutch word literally' }));
    expect(screen.queryByText('literally')).toBeNull();
  });
});

describe('InstallTabs', () => {
  it('switches platform tabs via click and keyboard arrows', () => {
    render(<InstallTabs />);

    const unixTab = screen.getByRole('tab', { name: 'Linux & macOS' });
    const winTab = screen.getByRole('tab', { name: 'Windows (PowerShell)' });

    expect(unixTab.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(unixTab, { key: 'ArrowRight' });
    expect(winTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(/install\.ps1/)).toBeTruthy();
  });
});
