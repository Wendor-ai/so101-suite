// HTTP client with a pluggable in-browser mock (demo mode). Pages only ever call api.get / api.post.
let mock = null;

export class ApiError extends Error {
  constructor(message, status = 0, body = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

const sentence = (body, fallback) => (body && typeof body === 'object' && (body.error || body.message)) || fallback;

async function http(method, path, body) {
  let r;
  try {
    r = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError('Cannot reach the SO-101 app. Is it still running?', 0);
  }
  const isJson = (r.headers.get('content-type') || '').includes('json');
  const data = isJson ? await r.json().catch(() => null) : await r.text();
  if (!r.ok) throw new ApiError(sentence(data, `The app answered ${r.status}`), r.status, data);
  return data;
}

// The mock may return plain JSON, or {status, json} to signal an error the way the real server would.
async function viaMock(method, path, body) {
  const out = await (method === 'GET' ? mock.get(path) : mock.post(path, body));
  if (out && typeof out === 'object' && typeof out.status === 'number' && 'json' in out) {
    if (out.status >= 400) throw new ApiError(sentence(out.json, `Request failed (${out.status})`), out.status, out.json);
    return out.json;
  }
  return out;
}

export const api = {
  use(m) { mock = m; },
  get demo() { return !!mock; },
  get mock() { return mock; },
  get: (path) => (mock ? viaMock('GET', path) : http('GET', path)),
  post: (path, body) => (mock ? viaMock('POST', path, body || {}) : http('POST', path, body || {})),
};
