-- The tasks of a project (M4-003, ADR-0004). Columns are the project's own and start
-- with three. A trashed task keeps its column and has a time in `trashed_ms`.
CREATE TABLE task_columns (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL
) STRICT;

INSERT INTO task_columns (id, name, position) VALUES
    ('todo', 'To do', 0),
    ('doing', 'Doing', 1),
    ('done', 'Done', 2);

CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL,
    column_id TEXT NOT NULL REFERENCES task_columns (id),
    position INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'none' CHECK (priority IN ('none', 'low', 'medium', 'high')),
    due TEXT,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL,
    trashed_ms INTEGER
) STRICT;

CREATE INDEX tasks_by_column ON tasks (column_id, position);

CREATE TABLE task_tags (
    task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    tag TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (task_id, tag)
) STRICT, WITHOUT ROWID;

-- Notes by their path in the project. Notes have no id of their own, so a rename inside
-- Liurium updates this; one outside leaves the old path, which shows as missing.
CREATE TABLE task_notes (
    task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    path TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (task_id, path)
) STRICT, WITHOUT ROWID;
