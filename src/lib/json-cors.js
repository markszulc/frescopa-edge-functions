export function createJsonCorsHeaders(req, allowedOrigins, extra) {
  const origin = req.headers.get('origin') || '';
  const headers = new Headers({ 'content-type': 'application/json', vary: 'Origin', ...extra });
  if (allowedOrigins.test(origin)) headers.set('access-control-allow-origin', origin);
  return headers;
}
