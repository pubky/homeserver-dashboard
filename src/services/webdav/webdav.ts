import type { WebDavFile, WebDavDirectory, WebDavError } from './webdav.types';

/**
 * WebDAV service for interacting with the homeserver's WebDAV endpoint.
 * Handles PROPFIND (list), GET (read), PUT (write), DELETE, MKCOL (create directory).
 *
 * All requests go through the dashboard's same-origin proxy; credentials and
 * the upstream /dav base are handled server-side by the API route.
 */
export class WebDavService {
  private baseUrl = '/api/webdav';

  private async request(path: string, init?: RequestInit): Promise<Response> {
    // Normalize path - remove /dav prefix if present since API route handles it
    let normalizedPath = path;
    if (normalizedPath.startsWith('/dav')) {
      normalizedPath = normalizedPath.substring(4);
    }
    if (!normalizedPath.startsWith('/')) {
      normalizedPath = '/' + normalizedPath;
    }

    const url = `${this.baseUrl}${normalizedPath}`;

    // For WebDAV methods that aren't standard HTTP methods, use POST with override header
    const method = init?.method || 'GET';
    const isWebDavMethod = ['PROPFIND', 'MKCOL', 'MOVE', 'COPY'].includes(method);

    const headers: Record<string, string> = {
      ...Object.fromEntries(new Headers(init?.headers).entries()),
    };

    // Add method override header for WebDAV methods
    if (isWebDavMethod) {
      headers['X-HTTP-Method-Override'] = method;
    }

    // Use POST for WebDAV methods, otherwise use the original method
    const httpMethod = isWebDavMethod ? 'POST' : method;

    const response = await fetch(url, {
      ...init,
      method: httpMethod,
      headers,
    });

    if (!response.ok) {
      const envelope = await response
        .clone()
        .json()
        .catch(() => null as { error?: string; type?: string } | null);
      const error: WebDavError = {
        message: envelope?.error ?? `Request failed: ${response.status} ${response.statusText}`,
        status: response.status,
        type: envelope?.type,
      };
      throw error;
    }

    return response;
  }

  /**
   * List directory contents using PROPFIND.
   * @param path WebDAV path (e.g., "/dav/" or "/dav/{pubkey}/pub/")
   * @param depth Depth of listing (0 = self, 1 = self + children, infinity = recursive)
   */
  async listDirectory(path: string, depth: 0 | 1 | 'infinity' = 1): Promise<WebDavDirectory> {
    const normalizedPath = path.endsWith('/') ? path : `${path}/`;

    let response: Response;
    try {
      response = await this.request(normalizedPath, {
        method: 'PROPFIND',
        headers: {
          Depth: depth.toString(),
          'Content-Type': 'application/xml',
        },
        body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:getcontenttype/>
    <d:getcontentlength/>
    <d:getlastmodified/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`,
      });
    } catch (err) {
      // PROPFIND 404 means the collection does not exist yet. For Pubky Homeserver
      // that is functionally an empty directory (the homeserver lazily creates
      // a user's namespace on first write), not a fault, so surface it as an
      // empty result. The FileBrowser renders the standard "directory is
      // empty" state instead of a red error Alert.
      if ((err as { status?: number }).status === 404) {
        return { path: normalizedPath, files: [] };
      }
      throw err;
    }

    const xmlText = await response.text();
    const files = this.parsePropfindResponse(xmlText, normalizedPath);

    return {
      path: normalizedPath,
      files,
    };
  }

  /**
   * Read a file's contents.
   * @param path WebDAV path to the file
   */
  async readFile(path: string): Promise<string> {
    const response = await this.request(path, {
      method: 'GET',
    });
    return await response.text();
  }

  /**
   * Write/upload a file.
   * @param path WebDAV path where to write the file
   * @param content File contents (as string)
   * @param contentType MIME type (default: text/plain)
   */
  async writeFile(path: string, content: string, contentType: string = 'text/plain'): Promise<void> {
    await this.request(path, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
      },
      body: content,
    });
  }

  /**
   * Delete a file or directory.
   * @param path WebDAV path to delete
   */
  async delete(path: string): Promise<void> {
    await this.request(path, {
      method: 'DELETE',
    });
  }

  /**
   * Create a directory.
   * @param path WebDAV path for the new directory (must end with /)
   */
  async createDirectory(path: string): Promise<void> {
    const normalizedPath = path.endsWith('/') ? path : `${path}/`;
    await this.request(normalizedPath, {
      method: 'MKCOL',
    });
  }

  /**
   * Move/rename a file or directory.
   * @param sourcePath Source WebDAV path
   * @param destinationPath Destination WebDAV path
   */
  async move(sourcePath: string, destinationPath: string): Promise<void> {
    // Normalize destination path for API route; the proxy rewrites this
    // same-origin path into the absolute upstream /dav URL.
    let normalizedDest = destinationPath;
    if (normalizedDest.startsWith('/dav')) {
      normalizedDest = normalizedDest.substring(4);
    }
    if (!normalizedDest.startsWith('/')) {
      normalizedDest = '/' + normalizedDest;
    }
    const destUrl = `${this.baseUrl}${normalizedDest}`;

    await this.request(sourcePath, {
      method: 'MOVE',
      headers: {
        Destination: destUrl,
      },
    });
  }

  /**
   * Parse PROPFIND XML response into WebDavFile array.
   */
  private parsePropfindResponse(xmlText: string, basePath: string): WebDavFile[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');

    // Check for parsing errors
    const parserError = doc.querySelector('parsererror');
    if (parserError) {
      console.error('XML parsing error:', parserError.textContent);
      return [];
    }

    const responses = doc.querySelectorAll('response');
    const files: WebDavFile[] = [];

    responses.forEach((response) => {
      const href = response.querySelector('href')?.textContent || '';
      const displayName = response.querySelector('displayname')?.textContent || '';
      const contentType = response.querySelector('getcontenttype')?.textContent || '';
      const contentLength = response.querySelector('getcontentlength')?.textContent;
      const lastModified = response.querySelector('getlastmodified')?.textContent;
      const resourcetype = response.querySelector('resourcetype');
      const isCollection = resourcetype?.querySelector('collection') !== null;

      // Extract relative path from href first (before filtering)
      let path = href;
      if (href.startsWith(this.baseUrl)) {
        path = href.substring(this.baseUrl.length);
      } else if (href.startsWith('http://') || href.startsWith('https://')) {
        // Full URL but doesn't match baseUrl - extract path portion
        try {
          const url = new URL(href);
          path = url.pathname;
          // Remove /dav prefix if present (since baseUrl already includes it)
          if (path.startsWith('/dav')) {
            path = path.substring(4);
          }
        } catch {
          // Invalid URL, use as-is
        }
      }

      // Remove any leading /dav/ from path (shouldn't be there since baseUrl includes /dav)
      // This handles cases where the server returns paths with /dav/ prefix
      while (path.startsWith('/dav/')) {
        path = path.substring(5);
      }
      if (path === '/dav') {
        path = '/';
      }

      // Ensure path starts with /
      if (!path.startsWith('/')) {
        path = '/' + path;
      }

      // Normalize paths for comparison (remove trailing slashes and normalize)
      const normalizeForCompare = (p: string): string => {
        let normalized = p.replace(/\/$/, '') || '/';
        // Remove any /dav prefix
        if (normalized.startsWith('/dav')) {
          normalized = normalized.substring(4) || '/';
        }
        return normalized;
      };

      const basePathForCompare = normalizeForCompare(basePath);
      const pathForCompare = normalizeForCompare(path);

      // Skip if this is the base path itself (the directory we're listing)
      // This is the first item that WebDAV returns - the directory itself
      if (pathForCompare === basePathForCompare) {
        return;
      }

      // Also check if the displayName matches the last part of the basePath
      // This catches cases where the path normalization might differ
      const basePathLastPart = basePath.split('/').filter(Boolean).pop() || '';
      if (basePathLastPart && displayName === basePathLastPart && pathForCompare === basePathForCompare) {
        return;
      }

      // Skip if path is just "/dav" or "/dav/" - this shouldn't appear as a folder
      if (path === '/dav' || path === '/dav/') {
        return;
      }

      // Ensure directories end with /
      if (isCollection && !path.endsWith('/')) {
        path = path + '/';
      }

      files.push({
        displayName: displayName || path.split('/').filter(Boolean).pop() || path,
        contentType: contentType || (isCollection ? 'directory' : 'application/octet-stream'),
        contentLength: contentLength ? parseInt(contentLength, 10) : undefined,
        lastModified,
        isCollection,
        path: path,
      });
    });

    // Sort: directories first, then files, both alphabetically
    files.sort((a, b) => {
      if (a.isCollection && !b.isCollection) return -1;
      if (!a.isCollection && b.isCollection) return 1;
      return a.displayName.localeCompare(b.displayName);
    });

    return files;
  }
}
