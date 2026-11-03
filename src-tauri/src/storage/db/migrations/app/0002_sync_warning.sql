-- When the project's sync-folder warning was shown (M2-010); NULL until then.
ALTER TABLE projects ADD COLUMN sync_warned_at TEXT;
