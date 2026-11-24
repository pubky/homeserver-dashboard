import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileBrowser } from './FileBrowser';
import type { WebDavFile } from '@/services/webdav';

const listDirectory = vi.fn();
const readFile = vi.fn();
const deleteFile = vi.fn();
const deleteUrl = vi.fn();

vi.mock('@/hooks/webdav', () => ({
  useWebDav: () => ({
    listDirectory,
    readFile,
    writeFile: vi.fn(),
    deleteFile,
    createDirectory: vi.fn(),
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@/hooks/admin', () => ({
  useAdminActions: () => ({ deleteUrl, isDeletingUrl: false, deleteUrlError: null }),
}));

const USER = 'o4dksfbqk85ogzdb5osziw6befigbuxmuxkuxq8434q89uj56uyy';

const files: WebDavFile[] = [
  {
    displayName: 'notes.txt',
    path: '/pk1/pub/notes.txt',
    isCollection: false,
    contentType: 'text/plain',
    contentLength: 12,
    lastModified: '2026-06-12T10:00:00.000Z',
  },
];

function renderBrowser() {
  return render(<FileBrowser initialPath="/pk1/pub/" />);
}

async function dialog() {
  await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
  return within(screen.getByRole('dialog'));
}

async function openDeleteByPathDialog() {
  renderBrowser();
  await waitFor(() => expect(screen.getByLabelText('Delete')).toBeTruthy());
  fireEvent.click(screen.getByLabelText('Delete'));
  return dialog();
}

describe('FileBrowser dialogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listDirectory.mockResolvedValue({ directory: { files } });
    deleteFile.mockResolvedValue(true);
    deleteUrl.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('delete confirmation offers Cancel; cancelling closes without deleting', async () => {
    renderBrowser();
    await waitFor(() => expect(screen.getAllByLabelText('Delete notes.txt').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByLabelText('Delete notes.txt')[0]);
    const d = await dialog();
    expect(d.getByRole('button', { name: 'Delete' })).toBeTruthy();
    fireEvent.click(d.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('shows folder names decoded in the breadcrumbs and the New File dialog', async () => {
    render(<FileBrowser initialPath="/pk1/pub/my%20folder/" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'my folder' })).toBeTruthy());
    // The listing is still asked for by the path the homeserver sent.
    expect(listDirectory).toHaveBeenCalledWith('/pk1/pub/my%20folder/');

    fireEvent.click(screen.getByRole('button', { name: 'New File' }));
    const d = await dialog();
    expect(d.getByText('Create a new file in /pk1/pub/my folder/')).toBeTruthy();
  });

  it('shows the folder name decoded in the New Folder dialog', async () => {
    render(<FileBrowser initialPath="/pk1/pub/my%20folder/" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'New Folder' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'New Folder' }));
    const d = await dialog();
    expect(d.getByText('Create a new directory in /pk1/pub/my folder/')).toBeTruthy();
  });

  it('shows an opened file under its decoded path, and reads it by the path the homeserver sent', async () => {
    const file: WebDavFile = { ...files[0], displayName: 'my notes.txt', path: '/pk1/pub/my%20notes.txt' };
    listDirectory.mockResolvedValue({ directory: { files: [file] } });
    readFile.mockResolvedValue('hello');
    renderBrowser();
    await waitFor(() => expect(screen.getAllByLabelText('Open file my notes.txt').length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByLabelText('Open file my notes.txt')[0]);
    const d = await dialog();
    expect(d.getByText('/pk1/pub/my notes.txt')).toBeTruthy();
    expect(readFile).toHaveBeenCalledWith('/pk1/pub/my%20notes.txt');
  });

  it('New File dialog offers Cancel', async () => {
    renderBrowser();
    await waitFor(() => expect(screen.getByRole('button', { name: 'New File' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New File' }));
    const d = await dialog();
    fireEvent.click(d.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Create Directory dialog offers Cancel', async () => {
    renderBrowser();
    await waitFor(() => expect(screen.getByRole('button', { name: 'New Folder' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New Folder' }));
    const d = await dialog();
    fireEvent.click(d.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('offers no Rename on a row', async () => {
    renderBrowser();
    await waitFor(() => expect(screen.getAllByLabelText('Delete notes.txt').length).toBeGreaterThan(0));
    expect(screen.queryByLabelText('Rename notes.txt')).toBeNull();
  });

  it('delete-by-path shows the normalized target, ignores Enter, and deletes only on the button click', async () => {
    renderBrowser();
    await waitFor(() => expect(screen.getByLabelText('Delete')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Delete'));
    const d = await dialog();

    const input = d.getByLabelText('Path');
    fireEvent.change(input, { target: { value: `https://example.com/dav/${USER}/pub/file.txt` } });

    // The normalized entry path is shown before anything is deleted.
    expect(d.getByTestId('delete-by-path-preview').textContent).toContain(`${USER}/pub/file.txt`);

    // Enter must not fire the destructive call.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(deleteUrl).not.toHaveBeenCalled();

    fireEvent.click(d.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteUrl).toHaveBeenCalledWith(`${USER}/pub/file.txt`));
  });

  it('delete-by-path reads the listing again once the entry is deleted', async () => {
    const d = await openDeleteByPathDialog();
    expect(listDirectory).toHaveBeenCalledTimes(1);
    fireEvent.change(d.getByLabelText('Path'), { target: { value: `/dav/${USER}/pub/file.txt` } });

    fireEvent.click(d.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(listDirectory).toHaveBeenCalledTimes(2);
  });

  it('delete-by-path keeps the dialog and the listing as they are when the delete fails', async () => {
    deleteUrl.mockRejectedValue(new Error('Entry not found'));
    const d = await openDeleteByPathDialog();
    fireEvent.change(d.getByLabelText('Path'), { target: { value: `${USER}/pub/file.txt` } });

    fireEvent.click(d.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteUrl).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(listDirectory).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['garbage'],
    ['pk1/pub/file.txt'],
    [`${USER}/`],
    [`${USER}/notes.txt`],
    [`${USER.replace('o', 'l')}/pub/file.txt`],
  ])('delete-by-path offers neither a preview nor Delete for %s', async (value) => {
    const d = await openDeleteByPathDialog();

    fireEvent.change(d.getByLabelText('Path'), { target: { value } });

    expect(d.queryByTestId('delete-by-path-preview')).toBeNull();
    expect(d.getByTestId('delete-by-path-invalid')).toBeTruthy();
    const button = d.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(deleteUrl).not.toHaveBeenCalled();
  });

  it('delete-by-path offers Cancel', async () => {
    renderBrowser();
    await waitFor(() => expect(screen.getByLabelText('Delete')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Delete'));
    const d = await dialog();
    fireEvent.click(d.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deleteUrl).not.toHaveBeenCalled();
  });
});
