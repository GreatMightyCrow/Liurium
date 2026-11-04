-- Links between notes (M3-005): what each note's text links to, as the Rust parser
-- found it. Where a link leads is worked out when asked, so it never goes stale.
CREATE TABLE links (
    source TEXT NOT NULL REFERENCES notes (path) ON DELETE CASCADE,
    -- Bytes of the whole link in the note's text.
    start_byte INTEGER NOT NULL,
    end_byte INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('wiki', 'markdown')),
    embed INTEGER NOT NULL CHECK (embed IN (0, 1)),
    -- Without the heading or block; empty for a place in the same note.
    target TEXT NOT NULL,
    heading TEXT,
    block TEXT,
    PRIMARY KEY (source, start_byte)
) STRICT;

-- The notes of a version 1 cache were never parsed for links; forgetting them makes
-- the next walk read every note once. The cache is rebuilt from the files anyway.
DELETE FROM notes;
