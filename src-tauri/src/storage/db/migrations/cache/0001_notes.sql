-- Notes found in the project (M3-002). A cache: deleted and built again from the
-- project's files whenever it is missing, damaged, or from another version (ADR-0016).
CREATE TABLE notes (
    -- Below the project root, parts joined with `/`, as found on disk.
    path TEXT PRIMARY KEY NOT NULL,
    size INTEGER NOT NULL,
    -- Nanoseconds since 1970-01-01 UTC; negative before.
    modified_ns INTEGER NOT NULL
) STRICT;
