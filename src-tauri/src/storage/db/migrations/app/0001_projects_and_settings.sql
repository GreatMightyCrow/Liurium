-- Project registry: where each known project was last seen (ADR-0016).
CREATE TABLE projects (
    -- UUID v4 from the project's own project.db.
    id TEXT PRIMARY KEY NOT NULL,
    -- Last known absolute folder path.
    path TEXT NOT NULL,
    -- Display name cached from project.db, shown while the folder is missing.
    name TEXT NOT NULL,
    -- UTC in ISO 8601; NULL until the project is opened.
    last_opened_at TEXT
) STRICT;

-- App settings such as theme, mode, and frame (M2-007). Values are JSON.
CREATE TABLE settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
) STRICT;
