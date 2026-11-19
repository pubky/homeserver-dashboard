'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ButtonSpinner } from '@/components/ui/button-spinner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Play, Copy, Check, Server, Globe, BarChart3, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCopyFeedback } from '@/hooks/useCopyFeedback';
import type { ApiEndpoint, EndpointGroup } from './ApiExplorer.types';

// All three homeserver ports are reached through same-origin dashboard proxies
// (the browser cannot resolve compose-internal hostnames like "homeserver").
const ADMIN_PROXY_BASE = '/api/admin';
const WEBDAV_PROXY_BASE = '/api/webdav';
const CLIENT_PROXY_BASE = '/api/client-proxy';
const METRICS_PROXY_BASE = '/api/metrics-proxy';

const ADMIN_ENDPOINTS: ApiEndpoint[] = [
  {
    method: 'GET',
    path: '/',
    description: 'Root endpoint (public, no auth)',
    server: 'admin',
    requiresAuth: false,
  },
  {
    method: 'GET',
    path: '/info',
    description: 'Get homeserver information and statistics',
    server: 'admin',
    requiresAuth: true,
  },
  {
    method: 'GET',
    path: '/generate_signup_token',
    description: 'Generate a new signup token (invite code)',
    server: 'admin',
    requiresAuth: true,
  },
  {
    method: 'POST',
    path: '/users/{pubkey}/disable',
    description: 'Disable a user account (ban)',
    server: 'admin',
    requiresAuth: true,
  },
  {
    method: 'POST',
    path: '/users/{pubkey}/enable',
    description: 'Enable a previously disabled user account',
    server: 'admin',
    requiresAuth: true,
  },
  {
    method: 'GET',
    path: '/users?limit=20',
    description: 'List accounts with usage, status and limits (cursor pagination; state, sort_by, reverse)',
    server: 'admin',
    requiresAuth: true,
  },
  {
    method: 'DELETE',
    path: '/webdav/{pubkey}/pub/example.txt',
    description: 'Delete a file or entry by WebDAV path',
    server: 'admin',
    requiresAuth: true,
  },
  // WebDAV endpoints (use Basic Auth, not X-Admin-Password)
  {
    method: 'GET',
    path: '/dav/{pubkey}/pub/file.txt',
    description: 'WebDAV: Read a file (requires Basic Auth: admin:password)',
    server: 'admin',
    requiresAuth: true,
  },
  {
    method: 'PUT',
    path: '/dav/{pubkey}/pub/file.txt',
    description: 'WebDAV: Upload/update a file (requires Basic Auth: admin:password)',
    server: 'admin',
    requiresAuth: true,
    exampleBody: 'File content (binary)',
  },
  {
    method: 'DELETE',
    path: '/dav/{pubkey}/pub/file.txt',
    description: 'WebDAV: Delete a file (requires Basic Auth: admin:password)',
    server: 'admin',
    requiresAuth: true,
  },
];

const CLIENT_ENDPOINTS: ApiEndpoint[] = [
  {
    method: 'GET',
    path: '/',
    description: 'Root endpoint',
    server: 'client',
    requiresAuth: false,
  },
  {
    method: 'POST',
    path: '/signup',
    description: 'Create a new user account (requires signup_token query param if token_required)',
    server: 'client',
    requiresAuth: false,
    exampleBody: 'AuthToken binary (application/octet-stream)',
  },
  {
    method: 'POST',
    path: '/session',
    description: 'Authenticate and create a session for existing user',
    server: 'client',
    requiresAuth: false,
    exampleBody: 'AuthToken binary (application/octet-stream)',
  },
  {
    method: 'GET',
    path: '/events/',
    description: 'Get paginated event feed (supports ?limit=10&user=pubkey&reverse=false)',
    server: 'client',
    requiresAuth: false,
  },
  {
    method: 'GET',
    path: '/events-stream',
    description: 'Live SSE event stream (supports ?live=true&user=pubkey)',
    server: 'client',
    requiresAuth: false,
  },
  {
    method: 'GET',
    path: '/{pubkey}/session',
    description: 'Get current session information',
    server: 'client',
    requiresAuth: true,
  },
  {
    method: 'DELETE',
    path: '/{pubkey}/session',
    description: 'Sign out (delete session)',
    server: 'client',
    requiresAuth: true,
  },
  {
    method: 'GET',
    path: '/{pubkey}/pub/file.txt',
    description: 'Read a file or list directory',
    server: 'client',
    requiresAuth: true,
  },
  {
    method: 'HEAD',
    path: '/{pubkey}/pub/file.txt',
    description: 'Get file metadata without body',
    server: 'client',
    requiresAuth: true,
  },
  {
    method: 'PUT',
    path: '/{pubkey}/pub/file.txt',
    description: 'Upload or update a file',
    server: 'client',
    requiresAuth: true,
    exampleBody: 'File content (binary)',
  },
  {
    method: 'DELETE',
    path: '/{pubkey}/pub/file.txt',
    description: 'Delete a file or directory',
    server: 'client',
    requiresAuth: true,
  },
];

const METRICS_ENDPOINTS: ApiEndpoint[] = [
  {
    method: 'GET',
    path: '/metrics',
    description: 'Prometheus metrics endpoint',
    server: 'metrics',
    requiresAuth: false,
  },
];

const ENDPOINT_GROUPS: EndpointGroup[] = [
  {
    server: 'admin',
    name: 'Admin Server',
    description: 'Administrative operations (Port 6288)',
    baseUrl: ADMIN_PROXY_BASE,
    endpoints: ADMIN_ENDPOINTS,
  },
  {
    server: 'client',
    name: 'Client Server',
    description: 'User-facing API (Port 6286/6287)',
    baseUrl: CLIENT_PROXY_BASE,
    endpoints: CLIENT_ENDPOINTS,
  },
  {
    server: 'metrics',
    name: 'Metrics Server',
    description: 'Prometheus metrics (Port 6289)',
    baseUrl: METRICS_PROXY_BASE,
    endpoints: METRICS_ENDPOINTS,
  },
];

/**
 * Maps a server group plus an endpoint path to the same-origin proxy URL.
 * Plain string concatenation on a normalized path: the previous regex-based
 * slash collapsing turned "http://" into "http:/" and broke absolute URLs.
 */
export function resolveRequestUrl(server: 'admin' | 'client' | 'metrics', path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;

  if (server === 'admin') {
    // WebDAV endpoints go through the WebDAV proxy, which adds the /dav prefix.
    if (normalized === '/dav' || normalized.startsWith('/dav/')) {
      const rest = normalized.slice('/dav'.length);
      return `${WEBDAV_PROXY_BASE}${rest || '/'}`;
    }
    return `${ADMIN_PROXY_BASE}${normalized}`;
  }
  if (server === 'client') {
    return `${CLIENT_PROXY_BASE}${normalized}`;
  }
  return `${METRICS_PROXY_BASE}${normalized}`;
}

export function ApiExplorer() {
  const [selectedServer, setSelectedServer] = useState<'admin' | 'client' | 'metrics'>('admin');
  const [selectedEndpoint, setSelectedEndpoint] = useState<string>('');
  const [customMethod, setCustomMethod] = useState<
    'GET' | 'POST' | 'DELETE' | 'PUT' | 'HEAD' | 'PROPFIND' | 'MKCOL' | 'MOVE' | 'COPY'
  >('GET');
  const [customPath, setCustomPath] = useState('');
  const [requestBody, setRequestBody] = useState('');
  const [response, setResponse] = useState<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    error?: string;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const { copiedKey, copy, reset: resetCopied } = useCopyFeedback();

  const currentGroup = ENDPOINT_GROUPS.find((g) => g.server === selectedServer) || ENDPOINT_GROUPS[0];
  const currentEndpoints = currentGroup.endpoints;
  // The preset picked in the dropdown (undefined for custom requests); reused
  // wherever we need its method/path/exampleBody instead of re-scanning the list.
  const selectedPreset = currentEndpoints.find((e) => `${e.method} ${e.path}` === selectedEndpoint);

  const handleServerChange = (server: 'admin' | 'client' | 'metrics') => {
    setSelectedServer(server);
    setSelectedEndpoint('');
    setCustomPath('');
    setRequestBody('');
    setResponse(null);
  };

  const handlePresetSelect = (value: string) => {
    setSelectedEndpoint(value);
    const endpoint = currentEndpoints.find((e) => `${e.method} ${e.path}` === value);
    if (endpoint) {
      setCustomMethod(endpoint.method);
      setCustomPath(endpoint.path);
      setRequestBody(endpoint.exampleBody || '');
    }
  };

  const handleSendRequest = async () => {
    setIsLoading(true);
    setResponse(null);
    resetCopied();

    try {
      const path = selectedPreset?.path || customPath;
      const method = selectedPreset?.method || customMethod;
      const endpoint =
        selectedPreset ?? currentEndpoints.find((e) => `${e.method} ${e.path}` === `${customMethod} ${customPath}`);

      // Every group goes through a same-origin proxy route.
      const url = resolveRequestUrl(selectedServer, path);
      const headers: Record<string, string> = {};

      // Set content type only if there's a body
      if (method !== 'GET' && method !== 'HEAD' && requestBody.trim()) {
        // Check if it's binary (AuthToken) or JSON
        if (endpoint?.exampleBody?.includes('binary') || endpoint?.exampleBody?.includes('octet-stream')) {
          headers['Content-Type'] = 'application/octet-stream';
        } else {
          headers['Content-Type'] = 'application/json';
        }
      }

      // Admin auth is handled server-side by the proxy routes. Authenticated
      // client endpoints need session cookies the explorer cannot mint; those
      // requests go through but the homeserver will answer 401.

      // WebDAV methods that may need XML bodies
      const webdavMethods = ['PROPFIND', 'MKCOL', 'MOVE', 'COPY'];
      const needsBody = method !== 'GET' && method !== 'HEAD' && requestBody.trim();
      const isWebDAV = webdavMethods.includes(method);

      // For WebDAV methods, use POST with X-HTTP-Method-Override header
      let httpMethod = method;
      if (isWebDAV && selectedServer === 'admin') {
        headers['X-HTTP-Method-Override'] = method;
        httpMethod = 'POST';
      }

      const init: RequestInit = {
        method: httpMethod,
        headers,
      };

      if (needsBody) {
        // For binary endpoints, try to handle base64 or send as-is
        if (headers['Content-Type'] === 'application/octet-stream') {
          // If it looks like base64, decode it
          try {
            const decoded = atob(requestBody.trim());
            const bytes = new Uint8Array(decoded.length);
            for (let i = 0; i < decoded.length; i++) {
              bytes[i] = decoded.charCodeAt(i);
            }
            init.body = bytes;
          } catch {
            // Not base64, send as text (will be converted to bytes by fetch)
            init.body = requestBody;
          }
        } else if (isWebDAV) {
          // WebDAV methods typically use XML
          if (!headers['Content-Type']) {
            headers['Content-Type'] = 'application/xml; charset=utf-8';
          }
          init.body = requestBody;
        } else {
          // JSON endpoint: sent verbatim (the server validates).
          init.body = requestBody;
        }
      }

      const res = await fetch(url, init);
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let bodyText = '';
      const contentType = res.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        try {
          const json = await res.json();
          bodyText = JSON.stringify(json, null, 2);
        } catch {
          bodyText = await res.text();
        }
      } else {
        bodyText = await res.text();
      }

      setResponse({
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
        body: bodyText,
      });
    } catch (error) {
      setResponse({
        status: 0,
        statusText: 'Error',
        headers: {},
        body: '',
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopyResponse = async () => {
    if (!response) return;
    const text = `Status: ${response.status} ${response.statusText}\n\nHeaders:\n${JSON.stringify(response.headers, null, 2)}\n\nBody:\n${response.body}`;
    await copy(text);
  };

  const getStatusColor = (status: number) => {
    if (status >= 200 && status < 300) return 'text-green-600';
    if (status >= 400 && status < 500) return 'text-yellow-600';
    if (status >= 500) return 'text-red-600';
    return 'text-muted-foreground';
  };

  const getServerIcon = (server: 'admin' | 'client' | 'metrics') => {
    switch (server) {
      case 'admin':
        return <Server className="h-4 w-4" />;
      case 'client':
        return <Globe className="h-4 w-4" />;
      case 'metrics':
        return <BarChart3 className="h-4 w-4" />;
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2">
            API Explorer
            <Badge
              variant="outline"
              className="border-dashed text-xs font-normal"
              title="This tab may be replaced by a full API reference."
            >
              <Info className="mr-1 h-3 w-3" />
              Temporary
            </Badge>
          </CardTitle>
          <CardDescription>Test homeserver API endpoints across all servers</CardDescription>
        </CardHeader>

        {/* Inset separator between the header and the content (lighter than a full divider) */}
        <div className="mx-6 h-px bg-border/60" />

        <CardContent className="space-y-4 pt-4">
          {/* Server Selection */}
          <div className="space-y-2">
            <Label>Server</Label>
            <Select value={selectedServer} onValueChange={handleServerChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENDPOINT_GROUPS.map((group) => (
                  <SelectItem key={group.server} value={group.server}>
                    <div className="flex items-center gap-2">
                      {getServerIcon(group.server)}
                      <div className="flex flex-col">
                        <span className="font-medium">{group.name}</span>
                        <span className="text-xs text-muted-foreground">{group.description}</span>
                      </div>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs break-all text-muted-foreground sm:break-normal">
              Base URL: <code className="font-mono break-all">{currentGroup.baseUrl}</code>
            </p>
          </div>

          {/* Endpoint Selection */}
          <div className="space-y-2">
            <Label>Preset Endpoints</Label>
            <Select value={selectedEndpoint} onValueChange={handlePresetSelect}>
              <SelectTrigger>
                <SelectValue placeholder="Select an endpoint or use custom" />
              </SelectTrigger>
              <SelectContent>
                {currentEndpoints.map((endpoint) => (
                  <SelectItem key={`${endpoint.method} ${endpoint.path}`} value={`${endpoint.method} ${endpoint.path}`}>
                    <div className="flex flex-col">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold">{endpoint.method}</span>
                        <span className="font-mono text-sm">{endpoint.path}</span>
                        {endpoint.requiresAuth && (
                          <span className="rounded bg-yellow-100 px-1.5 py-0.5 text-xs text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
                            Auth
                          </span>
                        )}
                      </div>
                      <span className="mt-1 text-xs text-muted-foreground">{endpoint.description}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Method</Label>
              <Select
                value={customMethod}
                onValueChange={(v) => setCustomMethod(v as 'GET' | 'POST' | 'DELETE' | 'PUT' | 'HEAD')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GET">GET</SelectItem>
                  <SelectItem value="POST">POST</SelectItem>
                  <SelectItem value="PUT">PUT</SelectItem>
                  <SelectItem value="DELETE">DELETE</SelectItem>
                  <SelectItem value="HEAD">HEAD</SelectItem>
                  <SelectItem value="PROPFIND">PROPFIND</SelectItem>
                  <SelectItem value="MKCOL">MKCOL</SelectItem>
                  <SelectItem value="MOVE">MOVE</SelectItem>
                  <SelectItem value="COPY">COPY</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Path</Label>
              <Input
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                placeholder="/info"
                className="font-mono text-xs sm:text-sm"
              />
            </div>
          </div>

          {(customMethod === 'POST' ||
            customMethod === 'PUT' ||
            customMethod === 'DELETE' ||
            customMethod === 'PROPFIND' ||
            customMethod === 'MKCOL' ||
            customMethod === 'MOVE' ||
            customMethod === 'COPY') && (
            <div className="space-y-2">
              <Label>
                Request Body
                {selectedPreset?.exampleBody?.includes('binary') && (
                  <span className="ml-2 text-xs text-muted-foreground">(Binary/Base64 for AuthToken endpoints)</span>
                )}
              </Label>
              <Textarea
                value={requestBody}
                onChange={(e) => setRequestBody(e.target.value)}
                placeholder={
                  selectedPreset?.exampleBody?.includes('binary')
                    ? 'Base64-encoded binary data or raw bytes'
                    : customMethod === 'PROPFIND' ||
                        customMethod === 'MKCOL' ||
                        customMethod === 'MOVE' ||
                        customMethod === 'COPY'
                      ? '<?xml version="1.0"?><d:propfind>...</d:propfind> (WebDAV XML)'
                      : '{"key": "value"} or file content'
                }
                className="font-mono text-sm"
                rows={6}
              />
              {selectedPreset?.exampleBody && (
                <p className="text-xs text-muted-foreground">Example: {selectedPreset.exampleBody}</p>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button onClick={handleSendRequest} disabled={isLoading || !customPath} className="flex-1">
              {isLoading ? (
                <>
                  <ButtonSpinner className="mr-2" />
                  Sending...
                </>
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" />
                  Send Request
                </>
              )}
            </Button>
          </div>

          {response && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Response</Label>
                <Button variant="ghost" size="sm" onClick={handleCopyResponse}>
                  {copiedKey ? (
                    <>
                      <Check className="mr-2 h-4 w-4" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="mr-2 h-4 w-4" />
                      Copy
                    </>
                  )}
                </Button>
              </div>
              <div className="space-y-3 rounded-md border bg-muted/50 p-4">
                <div>
                  <span className="text-sm font-semibold">Status: </span>
                  <span className={cn('font-mono text-sm', getStatusColor(response.status))}>
                    {response.status} {response.statusText}
                  </span>
                </div>
                {response.error ? (
                  <Alert variant="destructive">
                    <AlertDescription>{response.error}</AlertDescription>
                  </Alert>
                ) : (
                  <>
                    <div>
                      <span className="text-sm font-semibold">Headers:</span>
                      <pre className="mt-1 max-h-32 overflow-x-auto rounded bg-background p-2 font-mono text-xs">
                        {JSON.stringify(response.headers, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <span className="text-sm font-semibold">Body:</span>
                      <pre className="mt-1 max-h-96 overflow-x-auto rounded bg-background p-2 font-mono text-xs break-words">
                        {response.body || '(empty)'}
                      </pre>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
