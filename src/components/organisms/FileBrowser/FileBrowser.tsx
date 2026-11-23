'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useWebDav } from '@/hooks/webdav';
import { useAdminActions } from '@/hooks/admin';
import type { WebDavFile, WebDavError } from '@/services/webdav';
import {
  ClipboardPaste,
  Folder,
  File,
  Trash2,
  RefreshCw,
  ChevronRight,
  Edit2,
  Save,
  Search,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FileBrowserProps } from './FileBrowser.types';

type SortField = 'name' | 'size' | 'date' | 'type';
type SortDirection = 'asc' | 'desc';
type SortOption = { field: SortField; direction: SortDirection };

/** Joins a directory path and a child name with exactly one separator. */
function joinPath(base: string, name: string): string {
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
}

/** What the admin delete takes: a user's pubky (z-base-32), then a path under /pub/. */
const ENTRY_PATH = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}\/pub\/.+/;

/** The sortable table columns (the Name column sorts by entry type so folders
 * group together). The Actions column is not sortable and is rendered apart. */
const SORT_COLUMNS: ReadonlyArray<{ field: SortField; label: string; aria: string }> = [
  { field: 'type', label: 'Name', aria: 'Sort files by name and type' },
  { field: 'size', label: 'Size', aria: 'Sort files by size' },
  { field: 'date', label: 'Modified', aria: 'Sort files by modified date' },
];

function SortHeader({
  field,
  label,
  aria,
  active,
  direction,
  onSort,
}: {
  field: SortField;
  label: string;
  aria: string;
  active: boolean;
  direction: SortDirection;
  onSort: (field: SortField) => void;
}) {
  return (
    <th className="p-2 text-left text-sm font-semibold select-none">
      <button
        type="button"
        className="flex items-center gap-2 rounded px-1 py-1 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onClick={() => onSort(field)}
        aria-label={aria}
      >
        <span>{label}</span>
        {active && (direction === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </th>
  );
}

/** The Delete icon button for one file row, shared by the desktop table and
 * the mobile card (each wraps it in its own layout div). */
function FileRowActions({ file, onDelete }: { file: WebDavFile; onDelete: (file: WebDavFile) => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={(e) => {
        e.stopPropagation();
        onDelete(file);
      }}
      className="h-7 w-7 p-0"
      title="Delete"
      aria-label={`Delete ${file.displayName}`}
    >
      <Trash2 className="h-3 w-3" />
    </Button>
  );
}

export function FileBrowser({ initialPath = '/', diskUsedMB, homeserverPubkey }: FileBrowserProps) {
  const { listDirectory, readFile, writeFile, deleteFile, createDirectory, isLoading, error } = useWebDav();
  const { deleteUrl, isDeletingUrl, deleteUrlError } = useAdminActions();
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [files, setFiles] = useState<WebDavFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<WebDavFile | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [isViewingFile, setIsViewingFile] = useState(false);
  const [isEditingFile, setIsEditingFile] = useState(false);
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [showCreateDirDialog, setShowCreateDirDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showDeleteByPathDialog, setShowDeleteByPathDialog] = useState(false);
  const [deleteByPathInput, setDeleteByPathInput] = useState('');
  const [fileToDelete, setFileToDelete] = useState<WebDavFile | null>(null);
  const [newFileName, setNewFileName] = useState('');
  const [newFileContent, setNewFileContent] = useState('');
  const [newDirName, setNewDirName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [sortOption, setSortOption] = useState<SortOption>({ field: 'type', direction: 'asc' });

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 250);
    return () => clearTimeout(handle);
  }, [searchQuery]);

  // Listing errors are separate from the hook's general `error` state, which is
  // shared with readFile / writeFile / deleteFile / createDirectory.
  // We need the distinction so an action failure on a populated directory
  // doesn't wipe the file list and doesn't show a Retry button that would
  // re-run the listing, not the failed action.
  const [listingError, setListingError] = useState<WebDavError | null>(null);

  const loadDirectory = useCallback(
    async (path: string) => {
      setFiles([]);
      setListingError(null);
      const result = await listDirectory(path);
      if ('directory' in result) {
        setFiles(result.directory.files);
      } else {
        setListingError(result.error);
      }
    },
    [listDirectory],
  );

  useEffect(() => {
    loadDirectory(currentPath);
  }, [currentPath, loadDirectory]);

  // Some homeservers reject a root /dav/ listing but accept /dav/<pubkey>/pub/.
  // Fire that fallback only when the root failure is endpoint-shaped (e.g. 404
  // or upstream_error), not a timeout: a slow homeserver isn't going to be
  // faster at the pub path.
  useEffect(() => {
    if (currentPath === '/' && listingError && listingError.type !== 'timeout' && homeserverPubkey) {
      setCurrentPath(`/${homeserverPubkey}/pub/`);
    }
  }, [listingError, currentPath, homeserverPubkey]);

  const handleFileClick = async (file: WebDavFile) => {
    if (file.isCollection) {
      // Navigate into directory
      setCurrentPath(file.path);
    } else {
      // Open file for viewing
      const content = await readFile(file.path);
      if (content !== null) {
        setFileContent(content);
        setSelectedFile(file);
        setIsViewingFile(true);
        setIsEditingFile(false);
      }
    }
  };

  const handleSave = async () => {
    if (!selectedFile) return;

    setIsSaving(true);
    const success = await writeFile(selectedFile.path, fileContent);
    if (success) {
      setIsEditingFile(false);
      // Reload directory to refresh file list
      await loadDirectory(currentPath);
    }
    setIsSaving(false);
  };

  const handleUpload = async () => {
    if (!newFileName.trim()) return;

    // Validate path structure
    if (!canCreateFiles) {
      setValidationError("Cannot create files at root level. Navigate to a user's /pub/ directory first.");
      setShowUploadDialog(false);
      setTimeout(() => setValidationError(null), 5000);
      return;
    }

    setIsSaving(true);
    setValidationError(null);
    const uploadPath = joinPath(currentPath, newFileName);

    const success = await writeFile(uploadPath, newFileContent);
    if (success) {
      setShowUploadDialog(false);
      setNewFileName('');
      setNewFileContent('');
      await loadDirectory(currentPath);
    }
    setIsSaving(false);
  };

  const handleCreateDirectory = async () => {
    if (!newDirName.trim()) return;

    // Validate path structure
    if (!canCreateFiles) {
      setValidationError("Cannot create directories at root level. Navigate to a user's /pub/ directory first.");
      setShowCreateDirDialog(false);
      setTimeout(() => setValidationError(null), 5000);
      return;
    }

    setIsSaving(true);
    setValidationError(null);
    const dirPath = `${joinPath(currentPath, newDirName)}/`;

    const success = await createDirectory(dirPath);
    if (success) {
      setShowCreateDirDialog(false);
      setNewDirName('');
      await loadDirectory(currentPath);
    }
    setIsSaving(false);
  };

  const beginDelete = (file: WebDavFile) => {
    setFileToDelete(file);
    setShowDeleteDialog(true);
  };

  const handleDelete = async () => {
    if (!fileToDelete) return;

    setIsSaving(true);
    const success = await deleteFile(fileToDelete.path);
    if (success) {
      setShowDeleteDialog(false);
      setFileToDelete(null);
      await loadDirectory(currentPath);
      if (selectedFile?.path === fileToDelete.path) {
        setIsViewingFile(false);
        setSelectedFile(null);
      }
    }
    setIsSaving(false);
  };

  const normalizeAdminDeletePath = (raw: string): string => {
    let value = raw.trim();
    if (!value) return '';

    // Support pasting full URLs
    if (/^https?:\/\//i.test(value)) {
      try {
        value = new URL(value).pathname;
      } catch {
        // fall through
      }
    }

    // Allow users to paste /dav/... or /webdav/... paths; normalize to entry_path
    const davMarker = '/dav/';
    const webdavMarker = '/webdav/';
    if (value.includes(davMarker)) {
      value = value.split(davMarker).slice(1).join(davMarker);
    }
    if (value.includes(webdavMarker)) {
      value = value.split(webdavMarker).slice(1).join(webdavMarker);
    }

    value = value.replace(/^\/+/, '');
    value = value.replace(/^dav\/+/, '');
    value = value.replace(/^webdav\/+/, '');

    return value;
  };

  const deleteByPathEntry = normalizeAdminDeletePath(deleteByPathInput);
  const isDeleteByPathEntryValid = ENTRY_PATH.test(deleteByPathEntry);

  const handleDeleteByPath = async () => {
    if (!isDeleteByPathEntryValid) return;

    try {
      await deleteUrl(deleteByPathEntry);
      setShowDeleteByPathDialog(false);
      setDeleteByPathInput('');
      await loadDirectory(currentPath);
    } catch {
      // error surfaced via deleteUrlError
    }
  };

  const handleSort = (field: SortField) => {
    setSortOption((current) => {
      // If clicking the same field, toggle direction; otherwise, set to ascending
      if (current.field === field) {
        return { field, direction: current.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { field, direction: 'asc' };
    });
  };

  // Filter and sort files
  const filteredAndSortedFiles = files
    .filter((file) => {
      if (!debouncedSearchQuery) return true;
      const query = debouncedSearchQuery.toLowerCase();
      return file.displayName.toLowerCase().includes(query);
    })
    .sort((a, b) => {
      let comparison = 0;

      switch (sortOption.field) {
        case 'name':
          comparison = a.displayName.localeCompare(b.displayName);
          break;
        case 'size':
          comparison = (a.contentLength || 0) - (b.contentLength || 0);
          break;
        case 'date':
          comparison = (a.lastModified || '').localeCompare(b.lastModified || '');
          break;
        case 'type':
          // Folders first, then files, both alphabetically
          if (a.isCollection && !b.isCollection) return -1;
          if (!a.isCollection && b.isCollection) return 1;
          comparison = a.displayName.localeCompare(b.displayName);
          break;
      }

      return sortOption.direction === 'asc' ? comparison : -comparison;
    });

  const pathParts = currentPath.split('/').filter(Boolean);
  const breadcrumbs = [
    { name: '/', path: '/' },
    ...pathParts.map((part, index) => {
      const path = '/' + pathParts.slice(0, index + 1).join('/') + (index < pathParts.length - 1 ? '/' : '');
      return { name: part, path };
    }),
  ];

  // Check if we're in a valid location for creating files/directories
  // Must be inside a user's /pub/ directory (path contains /pub/)
  const canCreateFiles = currentPath.includes('/pub/') || currentPath.match(/^\/[^/]+\/pub\/?$/);

  const formatFileSize = (bytes?: number): string => {
    if (!bytes) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (dateStr?: string): string => {
    if (!dateStr) return '-';
    try {
      return new Date(dateStr).toLocaleString();
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>File Browser</CardTitle>
              <CardDescription>Browse and manage files</CardDescription>
            </div>
            <div className="flex gap-2">
              {typeof diskUsedMB === 'number' && (
                <Badge variant="secondary" className="text-xs font-normal">
                  Disk Used: {diskUsedMB} MB
                </Badge>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowDeleteByPathDialog(true)}
                disabled={isDeletingUrl}
                title="Delete an entry by pasting its path"
                aria-label="Delete"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={() => loadDirectory(currentPath)} disabled={isLoading}>
                <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
              </Button>
            </div>
          </div>
        </CardHeader>

        {/* Inset separator between the header and the content (lighter than a full divider) */}
        <div className="mx-6 h-px bg-border/60" />

        <CardContent className="space-y-4 pt-4">
          {/* Search + Actions */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative sm:flex-1">
              <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="file-browser-search"
                aria-label="Search files"
                placeholder="Search files"
                className="pr-16 pl-9"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1">
                {searchQuery ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => setSearchQuery('')}
                    title="Clear"
                    aria-label="Clear search"
                  >
                    <span className="sr-only">Clear</span>✕
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={async () => {
                      try {
                        const text = await navigator.clipboard.readText();
                        setSearchQuery(text);
                      } catch {
                        // ignore clipboard errors
                      }
                    }}
                    title="Paste from clipboard"
                    aria-label="Paste from clipboard into search"
                  >
                    <ClipboardPaste className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Breadcrumbs */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-1 overflow-x-auto pb-2 text-xs sm:gap-2 sm:pb-0 sm:text-sm">
              {breadcrumbs.map((crumb, index) => (
                <div key={index} className="flex shrink-0 items-center gap-1 sm:gap-2">
                  {index > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCurrentPath(crumb.path)}
                    className="h-6 px-1.5 text-xs sm:px-2 sm:text-sm"
                  >
                    {crumb.name}
                  </Button>
                </div>
              ))}
            </div>

            {canCreateFiles && (
              <div className="flex flex-wrap gap-2 sm:shrink-0 sm:justify-end">
                <Button variant="outline" size="sm" onClick={() => setShowCreateDirDialog(true)} disabled={isLoading}>
                  New Folder
                </Button>
                <Button variant="outline" size="sm" onClick={() => setShowUploadDialog(true)} disabled={isLoading}>
                  New File
                </Button>
              </div>
            )}
          </div>

          {/* Listing error: type-aware copy + Retry. Hides the file list because
              the listing it would render is either empty or stale. */}
          {listingError && (
            <Alert variant="destructive">
              <AlertTitle>
                {listingError.type === 'timeout'
                  ? "Couldn't reach the homeserver"
                  : listingError.type === 'upstream_error'
                    ? "Couldn't connect to the homeserver"
                    : 'Error'}
              </AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-2">
                <span>
                  {listingError.type === 'timeout'
                    ? 'It may be slow or unreachable. Try again in a moment.'
                    : listingError.type === 'upstream_error'
                      ? 'Check that the homeserver is running, then retry.'
                      : listingError.message}
                </span>
                <Button size="sm" variant="outline" onClick={() => loadDirectory(currentPath)} disabled={isLoading}>
                  <RefreshCw className="mr-1 h-4 w-4" />
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {/* Action error (open / save / delete / upload). Keeps the file
              list visible so the user does not lose their place; no Retry button
              because a listing retry would not redo the failed action. */}
          {error && !listingError && (
            <Alert variant="destructive">
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          )}

          {/* Inline form validation (e.g. invalid file names). */}
          {validationError && (
            <Alert variant="destructive">
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{validationError}</AlertDescription>
            </Alert>
          )}

          {/* File list, skeleton, and empty state hide ONLY on a listing error
              (the listing didn't produce anything to show). Action errors render
              above but the file list keeps rendering its last-known state. */}
          {!listingError && isLoading && files.length === 0 ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !listingError && filteredAndSortedFiles.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              <Folder className="mx-auto mb-2 h-12 w-12 opacity-50" />
              <p>{files.length === 0 ? 'This directory is empty' : `No files match "${debouncedSearchQuery}"`}</p>
            </div>
          ) : !listingError ? (
            <>
              {/* Desktop Table View */}
              <div className="hidden overflow-x-auto rounded-md border md:block">
                <table className="w-full">
                  <thead>
                    <tr className="border-b">
                      {SORT_COLUMNS.map((col) => (
                        <SortHeader
                          key={col.field}
                          {...col}
                          active={sortOption.field === col.field}
                          direction={sortOption.direction}
                          onSort={handleSort}
                        />
                      ))}
                      <th className="p-2 text-right text-sm font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAndSortedFiles.map((file) => (
                      <tr key={file.path} className="border-b hover:bg-muted/50">
                        <td className="p-2">
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 rounded text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                            onClick={() => handleFileClick(file)}
                            aria-label={`${file.isCollection ? 'Open folder' : 'Open file'} ${file.displayName}`}
                          >
                            {file.isCollection ? (
                              <Folder className="h-4 w-4 text-brand" />
                            ) : (
                              <File className="h-4 w-4 text-muted-foreground" />
                            )}
                            <span className="truncate font-medium">{file.displayName}</span>
                          </button>
                        </td>
                        <td className="p-2 text-sm text-muted-foreground">
                          {file.isCollection ? '-' : formatFileSize(file.contentLength)}
                        </td>
                        <td className="p-2 text-sm text-muted-foreground">{formatDate(file.lastModified)}</td>
                        <td className="p-2">
                          <div className="flex justify-end gap-1">
                            <FileRowActions file={file} onDelete={beginDelete} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile Card View */}
              <div className="space-y-2 md:hidden">
                {filteredAndSortedFiles.map((file) => (
                  <div
                    key={file.path}
                    role="button"
                    tabIndex={0}
                    className="cursor-pointer rounded-md border bg-muted/50 p-3 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    onClick={() => handleFileClick(file)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        void handleFileClick(file);
                      }
                    }}
                    aria-label={`${file.isCollection ? 'Open folder' : 'Open file'} ${file.displayName}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        {file.isCollection ? (
                          <Folder className="h-4 w-4 shrink-0 text-brand" />
                        ) : (
                          <File className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{file.displayName}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            {!file.isCollection && <span>{formatFileSize(file.contentLength)}</span>}
                            {!file.isCollection && file.contentLength && <span>•</span>}
                            <span>{formatDate(file.lastModified)}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1" onClick={(e) => e.stopPropagation()}>
                        <FileRowActions file={file} onDelete={beginDelete} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* File Viewer/Editor Dialog */}
      <Dialog open={isViewingFile} onOpenChange={setIsViewingFile}>
        <DialogContent className="max-h-[80vh] max-w-[calc(100vw-2rem)] sm:max-w-[min(56rem,calc(100vw-4rem))]">
          <DialogHeader>
            <DialogTitle>{selectedFile?.displayName}</DialogTitle>
            <DialogDescription>{selectedFile?.path}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {isEditingFile ? (
              <Textarea
                value={fileContent}
                onChange={(e) => setFileContent(e.target.value)}
                className="min-h-[300px] font-mono text-xs sm:min-h-[400px] sm:text-sm"
                placeholder="File content..."
              />
            ) : (
              <div className="max-h-[50vh] overflow-auto rounded-md border bg-muted/50 p-3 sm:max-h-[60vh] sm:p-4">
                <pre className="font-mono text-xs wrap-break-word whitespace-pre-wrap sm:text-sm">{fileContent}</pre>
              </div>
            )}
          </div>
          <DialogFooter>
            {isEditingFile ? (
              <Button onClick={handleSave} disabled={isSaving}>
                <Save className="mr-2 h-4 w-4" />
                {isSaving ? 'Saving...' : 'Save'}
              </Button>
            ) : (
              <Button onClick={() => setIsEditingFile(true)}>
                <Edit2 className="mr-2 h-4 w-4" />
                Edit
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New File Dialog */}
      <Dialog open={showUploadDialog} onOpenChange={setShowUploadDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New File</DialogTitle>
            <DialogDescription className="break-all">Create a new file in {currentPath}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-file-name">File Name</Label>
              <div className="relative">
                <Input
                  id="new-file-name"
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  placeholder="example.txt"
                  className="pr-16"
                />
                <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1">
                  {newFileName ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 rounded-full bg-transparent text-muted-foreground hover:bg-muted/30"
                      onClick={() => setNewFileName('')}
                      title="Clear"
                      aria-label="Clear file name"
                    >
                      <span className="sr-only">Clear</span>✕
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 rounded-full bg-transparent text-muted-foreground hover:bg-muted/30"
                      onClick={async () => {
                        try {
                          const text = await navigator.clipboard.readText();
                          setNewFileName(text);
                        } catch {
                          // ignore clipboard errors
                        }
                      }}
                      title="Paste from clipboard"
                      aria-label="Paste file name from clipboard"
                    >
                      <ClipboardPaste className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-file-content">Content</Label>
              <Textarea
                id="new-file-content"
                value={newFileContent}
                onChange={(e) => setNewFileContent(e.target.value)}
                placeholder="File content..."
                rows={8}
                className="font-mono text-xs sm:text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowUploadDialog(false)} disabled={isSaving}>
              Cancel
            </Button>
            <Button onClick={handleUpload} disabled={!newFileName.trim() || isSaving}>
              {isSaving ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Directory Dialog */}
      <Dialog open={showCreateDirDialog} onOpenChange={setShowCreateDirDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Directory</DialogTitle>
            <DialogDescription className="break-all">Create a new directory in {currentPath}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-directory-name">Directory Name</Label>
              <div className="relative">
                <Input
                  id="new-directory-name"
                  value={newDirName}
                  onChange={(e) => setNewDirName(e.target.value)}
                  placeholder="new-folder"
                  className="pr-16"
                />
                <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1">
                  {newDirName ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 rounded-full bg-transparent text-muted-foreground hover:bg-muted/30"
                      onClick={() => setNewDirName('')}
                      title="Clear"
                      aria-label="Clear directory name"
                    >
                      <span className="sr-only">Clear</span>✕
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 rounded-full bg-transparent text-muted-foreground hover:bg-muted/30"
                      onClick={async () => {
                        try {
                          const text = await navigator.clipboard.readText();
                          setNewDirName(text);
                        } catch {
                          // ignore clipboard errors
                        }
                      }}
                      title="Paste from clipboard"
                      aria-label="Paste directory name from clipboard"
                    >
                      <ClipboardPaste className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreateDirDialog(false)} disabled={isSaving}>
              Cancel
            </Button>
            <Button onClick={handleCreateDirectory} disabled={!newDirName.trim() || isSaving}>
              {isSaving ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {fileToDelete?.isCollection ? 'Directory' : 'File'}</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{fileToDelete?.displayName}</strong>?
              {fileToDelete?.isCollection && ' This will delete all contents.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDeleteDialog(false)} disabled={isSaving}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isSaving}>
              {isSaving ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete by Path Dialog (Admin) */}
      <Dialog open={showDeleteByPathDialog} onOpenChange={setShowDeleteByPathDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete by path</DialogTitle>
            <DialogDescription>
              Paste an entry path to delete (destructive). You can paste a full URL or a path like{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">/dav/&lt;pubkey&gt;/pub/file.txt</code>.
            </DialogDescription>
          </DialogHeader>

          {deleteUrlError && (
            <Alert variant="destructive">
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{deleteUrlError.message}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="delete-by-path">Path</Label>
            <div className="relative">
              <Input
                id="delete-by-path"
                value={deleteByPathInput}
                onChange={(e) => setDeleteByPathInput(e.target.value)}
                placeholder="/dav/<pubkey>/pub/file.txt"
                onKeyDown={(e) => {
                  // Destructive action: never fire on Enter. The Delete
                  // button below is the only trigger.
                  if (e.key === 'Enter') e.preventDefault();
                }}
                className="pr-16"
              />
              <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1">
                {deleteByPathInput ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 rounded-full bg-transparent text-muted-foreground hover:bg-muted/30"
                    onClick={() => setDeleteByPathInput('')}
                    title="Clear"
                    aria-label="Clear path input"
                  >
                    <span className="sr-only">Clear</span>✕
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 rounded-full bg-transparent text-muted-foreground hover:bg-muted/30"
                    onClick={async () => {
                      try {
                        const text = await navigator.clipboard.readText();
                        setDeleteByPathInput(text);
                      } catch {
                        // ignore clipboard errors
                      }
                    }}
                    title="Paste from clipboard"
                    aria-label="Paste delete path from clipboard"
                  >
                    <ClipboardPaste className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
          </div>

          {isDeleteByPathEntryValid && (
            <p className="text-xs text-muted-foreground" data-testid="delete-by-path-preview">
              Will delete:{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs break-all">{deleteByPathEntry}</code>
            </p>
          )}
          {deleteByPathEntry && !isDeleteByPathEntryValid && (
            <p className="text-xs text-destructive" data-testid="delete-by-path-invalid">
              Not an entry path: it needs a user&apos;s pubky, then a path under /pub/.
            </p>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDeleteByPathDialog(false)} disabled={isDeletingUrl}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteByPath}
              disabled={!isDeleteByPathEntryValid || isDeletingUrl}
            >
              {isDeletingUrl ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {filteredAndSortedFiles.length > 0 && files.length > filteredAndSortedFiles.length && (
        <div className="text-sm text-muted-foreground">
          Showing <strong>{filteredAndSortedFiles.length}</strong> of <strong>{files.length}</strong> files
        </div>
      )}
    </div>
  );
}
