const status = document.querySelector('#status');
const copy = { sign_in_required: 'Sign in or create an account.', invalid_credentials: 'Check your username and password (at least 12 characters).', username_unavailable: 'That username is unavailable.', invalid_note: 'Write a note of up to 2,000 characters.', origin_required: 'Open this app directly and try again.', file_too_large: 'Choose a file up to 1 MiB.', upload_timeout: 'The upload took too long. Its record is retained until storage confirms the outcome.', upload_unconfirmed: 'The upload did not finish. Its record is retained until storage can confirm the outcome.', file_delete_unconfirmed: 'Deletion is not confirmed. Try again later.', file_store_unavailable: 'File storage is temporarily unavailable.', upload_length_required: 'Upload a complete local file with a known size.', app_configuration_required: 'The app setup is incomplete.', app_schema_required: 'The app database setup is incomplete.', password_hash_unavailable: 'Password verification is temporarily unavailable.', account_store_unavailable: 'Account storage is temporarily unavailable.', session_store_unavailable: 'Session storage is temporarily unavailable.', app_storage_unavailable: 'App storage is temporarily unavailable.' };
async function api(path, values) {
  const response = await fetch(path, values ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) } : {});
  const body = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(copy[body.error] ?? 'Something went wrong. Please try again.');
  return body;
}
async function refresh() {
  try {
    const { user } = await api('/api/session');
    document.querySelector('#signed-out').hidden = true; document.querySelector('#signed-in').hidden = false; status.textContent = `Signed in as ${user.username}`;
    const { notes } = await api('/api/notes'), list = document.querySelector('#notes'); list.replaceChildren();
    for (const note of notes) { const item = document.createElement('li'); item.textContent = note.content; list.append(item); }
    const { files, usage } = await api('/api/files'), fileList = document.querySelector('#files'); fileList.replaceChildren();
    document.querySelector('#file-usage').textContent = `${usage.stored_bytes} confirmed bytes; ${usage.pending_files} unresolved uploads or deletions (${usage.unconfirmed_bytes} possible bytes).`;
    for (const file of files) {
      const item = document.createElement('li'), label = document.createElement(file.state === 'ready' ? 'a' : 'span');
      label.textContent = `${file.filename} (${file.size} bytes)${file.state === 'ready' ? '' : ' — ' + file.state}`;
      if (file.state === 'ready') { label.href = `/api/files/${file.id}`; label.download = file.filename; }
      item.append(label);
      if (file.error_code) { const error = document.createElement('span'); error.textContent = ' — ' + (copy[file.error_code] ?? 'Storage outcome is not yet confirmed.'); item.append(error); }
      const remove = document.createElement('button'); remove.textContent = 'Delete';
      remove.addEventListener('click', async () => { try { const result = await fetch(`/api/files/${file.id}`, { method: 'DELETE' }); if (!result.ok) { const error = await result.json(); throw new Error(copy[error.error] ?? 'Deletion is not confirmed.'); } await refresh(); } catch (error) { status.textContent = error.message; } });
      item.append(' ', remove); fileList.append(item);
    }
  } catch (error) { document.querySelector('#signed-out').hidden = false; document.querySelector('#signed-in').hidden = true; status.textContent = error.message; }
}
for (const [id, path] of [['signup', '/auth/signup'], ['login', '/auth/login'], ['note', '/api/notes']]) document.querySelector(`#${id}`).addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget;
  try { await api(path, Object.fromEntries(new FormData(form))); form.reset(); await refresh(); } catch (error) { status.textContent = error.message; }
});
document.querySelector('#logout').addEventListener('click', async () => { try { await api('/auth/logout', {}); await refresh(); } catch (error) { status.textContent = error.message; } });
document.querySelector('#upload').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget, file = form.elements.namedItem('file').files[0];
  if (!file || file.size > 1024 * 1024 || file.size < 1) { status.textContent = 'Choose a file between 1 byte and 1 MiB.'; return; }
  try {
    const result = await fetch('/api/files', { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) }, body: file });
    const body = await result.json(); if (!result.ok) throw new Error(copy[body.error] ?? 'The upload did not finish.');
    form.reset(); await refresh();
  } catch (error) { await refresh(); status.textContent = error.message; }
});
void refresh();
