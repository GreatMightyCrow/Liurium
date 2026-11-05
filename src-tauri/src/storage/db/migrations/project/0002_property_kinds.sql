-- The kind chosen for a property name (M3-015), for all notes of the project. It only
-- changes how a field shows; a name without a row follows its value.
CREATE TABLE property_kinds (
    name TEXT PRIMARY KEY NOT NULL COLLATE NOCASE,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'list', 'number', 'checkbox', 'date', 'dateTime'))
) STRICT;
