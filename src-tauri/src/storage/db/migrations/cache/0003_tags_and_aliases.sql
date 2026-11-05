-- Tags and aliases (M3-007): `#tags` in a note's text (with their place) and in
-- its front matter (no place), and the other names its front matter gives it.
CREATE TABLE tags (
    source TEXT NOT NULL REFERENCES notes (path) ON DELETE CASCADE,
    -- Without `#`, as written; compared without case.
    tag TEXT NOT NULL,
    -- Bytes of `#tag` in the text; NULL for a tag from the front matter.
    start_byte INTEGER
) STRICT;
CREATE INDEX tags_by_source ON tags (source);

CREATE TABLE aliases (
    source TEXT NOT NULL REFERENCES notes (path) ON DELETE CASCADE,
    alias TEXT NOT NULL
) STRICT;
CREATE INDEX aliases_by_source ON aliases (source);

-- Notes read before version 3 have no tags or aliases stored; forgetting them makes
-- the next walk read every note once. Their links go with them.
DELETE FROM notes;
