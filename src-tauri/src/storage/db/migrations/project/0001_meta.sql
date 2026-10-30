-- Project identity and display name (ADR-0016), written when a project is created (M2-005).
CREATE TABLE meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
) STRICT;
