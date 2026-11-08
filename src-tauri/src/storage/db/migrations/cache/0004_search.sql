-- Search (M4-001): one row per note, its row id the note's row in `notes`. Contentless:
-- the index keeps no copy of the text, so excerpts are read from the file when asked.
-- Trigram finds parts of words ("plan" in "Projektplan"); without case or accents.
CREATE VIRTUAL TABLE search USING fts5 (
    name,
    aliases,
    headings,
    tags,
    properties,
    body,
    content = '',
    contentless_delete = 1,
    tokenize = 'trigram remove_diacritics 1'
);

-- Notes read before version 4 are not in the index; forgetting them makes the next
-- walk read every note once. Their links, tags, and aliases go with them.
DELETE FROM notes;
