/**
 * Headers that make a response inert when a browser opens it as a document.
 *
 * Needed most for a body someone else wrote: a file a homeserver user
 * uploaded, or whatever an upstream server answered. Also put on the
 * dashboard's own error responses, which echo parts of the request.
 *
 * The proxies relay such bodies with the upstream's Content-Type, and anyone
 * with an account can upload `x.html`. Served plainly, that file would open as
 * a page on the dashboard's own origin, and its script could call the admin
 * API with the admin's session. These headers make the body inert however it
 * is reached. The dashboard page reads these responses with `fetch`, which
 * none of them affect.
 */
export const INERT_DOCUMENT_HEADERS = {
  // Opened as a document: run no script, load nothing, and be a foreign
  // origin with no access to the dashboard's cookies or API. Not frameable.
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
  // Take the declared type as it is; never guess that some bytes are HTML.
  'X-Content-Type-Options': 'nosniff',
} as const;

/** For a relayed body: the above, plus a download instead of a display, for a browser that ignores the sandbox. */
export const INERT_CONTENT_HEADERS = { ...INERT_DOCUMENT_HEADERS, 'Content-Disposition': 'attachment' } as const;
