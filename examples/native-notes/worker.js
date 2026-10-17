// Plain Cloudflare Worker: DB and SESSION_SECRET belong to this app/environment only.
const COOKIE = '__Host-notes_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const MAX_FILE_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const base64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const random = size => base64(crypto.getRandomValues(new Uint8Array(size)));
const now = () => new Date().toISOString();

function response(body, status = 200, cookie) {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });
  if (cookie) headers.set('set-cookie', cookie);
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}
function sessionCookie(token, seconds = SESSION_SECONDS) {
  return `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
}
function tokenFrom(request) {
  let found = null;
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const pair = part.trim(), split = pair.indexOf('='), name = pair.slice(0, split);
    if (name.toLowerCase() !== COOKIE.toLowerCase()) continue;
    if (name !== COOKIE || found !== null) return null;
    const token = pair.slice(split + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    found = token;
  }
  return found;
}
async function tokenHash(secret, token) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(token))));
}
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return base64(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: 100000 }, key, 256)));
}
function equalHash(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}
async function currentSession(request, env) {
  const token = tokenFrom(request);
  if (!token) return null;
  const hash = await tokenHash(env.SESSION_SECRET, token);
  return await env.DB.prepare('SELECT s.token_hash,u.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').bind(hash, now()).first();
}
async function bodyOf(request) {
  if (Number(request.headers.get('content-length') ?? 0) > 4096) return null;
  const reader = request.body?.getReader(); if (!reader) return {};
  const chunks = []; let length = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > 4096) { await reader.cancel(); return null; } chunks.push(next.value); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  try {
    const type = (request.headers.get('content-type') ?? '').split(';')[0];
    if (type === 'application/json') { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
    if (type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(text));
  } catch { return null; }
  return null;
}
async function openSession(env, userId) {
  const token = random(32), created = now(), expires = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await tokenHash(env.SESSION_SECRET, token), userId, expires, created).run();
  return token;
}

function fileMetadata(row) {
  return { id: row.id, filename: row.filename, content_type: row.content_type, size: row.size, state: row.state, error_code: row.error_code, created_at: row.created_at };
}
async function files(request, env, session, path) {
  if (!session) return response({ error: 'sign_in_required' }, 401);
  if (!env.FILES) return response({ error: 'file_store_unavailable' }, 503);
  const id = path.slice('/api/files/'.length);
  if (path === '/api/files' && request.method === 'GET') {
    const result = await env.DB.prepare('SELECT id,filename,content_type,size,state,error_code,created_at FROM attachments WHERE user_id=? ORDER BY created_at DESC,id LIMIT 100').bind(session.id).all();
    const usage = await env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN state='ready' THEN size ELSE 0 END),0) AS stored_bytes,COALESCE(SUM(CASE WHEN state='ready' THEN 1 ELSE 0 END),0) AS ready_files,COALESCE(SUM(CASE WHEN state<>'ready' THEN 1 ELSE 0 END),0) AS pending_files,COALESCE(SUM(CASE WHEN state<>'ready' THEN size ELSE 0 END),0) AS unconfirmed_bytes FROM attachments WHERE user_id=?").bind(session.id).first();
    return response({ files: result.results.map(fileMetadata), usage, max_upload_bytes: MAX_FILE_BYTES });
  }
  if (path === '/api/files' && request.method === 'POST') {
    if (!request.body) return response({ error: 'upload_body_required' }, 400);
    const length = Number(request.headers.get('content-length'));
    if (!request.headers.has('content-length') || !Number.isSafeInteger(length) || length < 1) return response({ error: 'upload_length_required' }, 411);
    if (length > MAX_FILE_BYTES) return response({ error: 'file_too_large', max_upload_bytes: MAX_FILE_BYTES }, 413);
    let filename;
    try { filename = decodeURIComponent(request.headers.get('x-file-name') ?? 'attachment'); } catch { return response({ error: 'invalid_filename' }, 400); }
    if (!filename || filename.length > 120 || /[\\/\u0000-\u001f\u007f]/u.test(filename)) return response({ error: 'invalid_filename' }, 400);
    const contentType = request.headers.get('content-type') ?? 'application/octet-stream';
    if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(contentType) || contentType.length > 120) return response({ error: 'invalid_file_type' }, 400);
    const id = crypto.randomUUID(), key = `users/${session.id}/${id}`, created = now();
    await env.DB.prepare("INSERT INTO attachments(id,user_id,object_key,filename,content_type,size,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'uploading',?,?)").bind(id, session.id, key, filename, contentType, length, created, created).run();
    // FixedLengthStream both preserves R2's known-length streaming contract and rejects truncated/oversized bodies.
    const stream = new FixedLengthStream(length);
    const abort = new AbortController(); let copied, timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; abort.abort(); }, 30_000);
    try {
      copied = request.body.pipeTo(stream.writable, { signal: abort.signal });
      const [object] = await Promise.all([env.FILES.put(key, stream.readable, { httpMetadata: { contentType }, customMetadata: { attachment: id } }), copied]);
      if (!object || object.size !== length) throw new Error('incomplete upload');
      await env.DB.prepare("UPDATE attachments SET state='ready',etag=?,updated_at=? WHERE id=? AND user_id=? AND state='uploading'").bind(object.etag, now(), id, session.id).run();
      return response({ file: { id, filename, content_type: contentType, size: length, state: 'ready', error_code: null, created_at: created } }, 201);
    } catch {
      // A failed/unknown PUT is never published or treated as absent. Keep its exact key for later reconciliation.
      abort.abort(); await copied?.catch(() => undefined);
      const error = timedOut ? 'upload_timeout' : 'upload_unconfirmed';
      await env.DB.prepare("UPDATE attachments SET state='failed',error_code=?,updated_at=? WHERE id=? AND user_id=? AND state='uploading'").bind(error, now(), id, session.id).run();
      return response({ error, file_id: id, state: 'failed', cleanup_required: true }, 503);
    } finally { clearTimeout(deadline); }
  }
  if (!/^[a-f0-9-]{36}$/.test(id)) return response({ error: 'not_found' }, 404);
  const file = await env.DB.prepare('SELECT * FROM attachments WHERE id=? AND user_id=?').bind(id, session.id).first();
  if (!file) return response({ error: 'not_found' }, 404);
  if (request.method === 'DELETE') {
    if (file.state === 'uploading') return response({ error: 'upload_unconfirmed', file_id: id }, 409);
    try {
      if (file.state === 'failed' && !await env.FILES.head(file.object_key)) return response({ error: 'upload_unconfirmed', file_id: id, cleanup_required: true }, 409);
      await env.DB.prepare("UPDATE attachments SET state='deleting',updated_at=? WHERE id=? AND user_id=?").bind(now(), id, session.id).run();
      await env.FILES.delete(file.object_key);
      await env.DB.prepare('DELETE FROM attachments WHERE id=? AND user_id=?').bind(id, session.id).run();
      return response(null, 204);
    } catch { return response({ error: 'file_delete_unconfirmed', file_id: id, cleanup_required: true }, 503); }
  }
  if (!['GET', 'HEAD'].includes(request.method) || file.state !== 'ready') return response({ error: 'not_found' }, 404);
  try {
    const object = request.method === 'HEAD' ? await env.FILES.head(file.object_key) : await env.FILES.get(file.object_key);
    if (!object || object.size !== file.size || object.etag !== file.etag) return response({ error: 'file_unavailable' }, 503);
    return new Response(request.method === 'HEAD' ? null : object.body, { headers: {
      'content-type': file.content_type, 'content-length': String(object.size), etag: object.httpEtag,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`,
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff'
    } });
  } catch { return response({ error: 'file_store_unavailable' }, 503); }
}

export default {
  async fetch(request, env) {
    try {
    const url = new URL(request.url), path = url.pathname;
    const missing = [...(typeof env.DB?.prepare !== 'function' ? ['DB'] : []), ...(typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length < 32 ? ['SESSION_SECRET'] : [])];
    if (missing.length) return response({ error: 'app_configuration_required', missing_bindings: missing }, 503);
    // Origin is mandatory for every state change and every authenticated socket handshake.
    if (!['GET', 'HEAD'].includes(request.method) || request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      if (request.headers.get('origin') !== url.origin) return response({ error: 'origin_required' }, 403);
    }
    if (request.method === 'POST' && ['/auth/signup', '/auth/login'].includes(path)) {
      const body = await bodyOf(request);
      if (!body || Object.keys(body).some(key => !['username', 'password'].includes(key)) || typeof body.username !== 'string' || !/^[A-Za-z0-9_]{3,32}$/.test(body.username) || typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) return response({ error: 'invalid_credentials' }, 400);
      const username = body.username.toLowerCase(); let user;
      if (path === '/auth/signup') {
        const salt = random(16), id = crypto.randomUUID(), created = now();
        let hash; try { hash = await passwordHash(body.password, salt); } catch { return response({ error: 'password_hash_unavailable' }, 503); }
        try { await env.DB.prepare('INSERT INTO users(id,username,password_salt,password_hash,created_at) VALUES(?,?,?,?,?)').bind(id, username, salt, hash, created).run(); }
        catch (error) { const message = String(error?.message); return /UNIQUE constraint failed/.test(message) ? response({ error: 'username_unavailable' }, 409) : response({ error: /no such table/.test(message) ? 'app_schema_required' : 'account_store_unavailable' }, 503); }
        user = { id, username };
      } else {
        user = await env.DB.prepare('SELECT id,username,password_salt,password_hash FROM users WHERE username=?').bind(username).first();
        // Unknown users still incur a password derivation; the response never exposes password state.
        const actual = await passwordHash(body.password, user?.password_salt ?? 'unknown-user-salt');
        if (!user || !equalHash(actual, user.password_hash)) return response({ error: 'invalid_credentials' }, 401);
      }
      let token; try { token = await openSession(env, user.id); } catch { return response({ error: 'session_store_unavailable' }, 503); }
      return response({ user: { id: user.id, username: user.username } }, path === '/auth/signup' ? 201 : 200, sessionCookie(token));
    }
    if (request.method === 'POST' && path === '/auth/logout') {
      const session = await currentSession(request, env);
      if (session) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(session.token_hash).run();
      return response(null, 204, sessionCookie('', 0));
    }
    if (request.method === 'GET' && ['/', '/app.js', '/style.css'].includes(path)) {
      const asset = await env.ASSETS.fetch(request), headers = new Headers(asset.headers);
      headers.set('content-security-policy', "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'; frame-ancestors 'self'; form-action 'self'; base-uri 'none'; object-src 'none'");
      headers.set('x-content-type-options', 'nosniff'); headers.set('referrer-policy', 'same-origin');
      return new Response(asset.body, { status: asset.status, headers });
    }
    const session = await currentSession(request, env);
    if (path === '/api/files' || path.startsWith('/api/files/')) return await files(request, env, session, path);
    if (path === '/api/session' && request.method === 'GET') return session ? response({ user: { id: session.id, username: session.username } }) : response({ error: 'sign_in_required' }, 401);
    if (path === '/api/notes') {
      if (!session) return response({ error: 'sign_in_required' }, 401);
      if (request.method === 'GET') {
        const notes = await env.DB.prepare('SELECT id,content,created_at FROM notes WHERE user_id=? ORDER BY created_at DESC,id LIMIT 100').bind(session.id).all();
        return response({ notes: notes.results });
      }
      if (request.method === 'POST') {
        const body = await bodyOf(request);
        if (!body || Object.keys(body).some(key => key !== 'content') || typeof body.content !== 'string' || body.content.trim().length < 1 || body.content.length > 2000) return response({ error: 'invalid_note' }, 400);
        const note = { id: crypto.randomUUID(), content: body.content.trim(), created_at: now() };
        await env.DB.prepare('INSERT INTO notes(id,user_id,content,created_at) VALUES(?,?,?,?)').bind(note.id, session.id, note.content, note.created_at).run();
        return response({ note }, 201);
      }
    }
    if (path === '/socket' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      if (!session) return response({ error: 'sign_in_required' }, 401);
      const pair = new WebSocketPair(); pair[1].accept();
      pair[1].addEventListener('message', async event => {
        // Logout invalidation applies to each message, not just the opening handshake.
        if (!await currentSession(request, env)) { pair[1].close(1008, 'Session ended'); return; }
        if (typeof event.data !== 'string' || event.data.length > 1000) { pair[1].close(1009, 'Message too large'); return; }
        pair[1].send(event.data);
      });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return response({ error: 'not_found' }, 404);
    } catch { return response({ error: 'app_storage_unavailable' }, 503); }
  }
};
