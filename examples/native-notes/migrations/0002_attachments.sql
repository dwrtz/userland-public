CREATE TABLE attachments (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size >= 0),
  etag TEXT,
  state TEXT NOT NULL CHECK(state IN ('uploading','ready','failed','deleting')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX attachments_owner ON attachments(user_id, created_at);
