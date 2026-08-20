-- REVIEW BEFORE APPLYING.
--
-- Structured answers read off a scanned questionnaire.
--
-- The OCR text of an underwriting form contains the questions but not the
-- answers: the answers are ticks in table cells, which every engine before
-- `azure-layout` dropped on the floor. This table is where the marked answer for
-- a question is kept once one engine can finally report it.
--
-- Not a column on documentpage, because a page holds many answers, and not a
-- generic key/value bag, because an underwriter cites a question by its printed
-- number and that number has to survive as its own field.
--
-- Follows 003: an identity primary key rather than the MAX(id)+1 allocator that
-- migration retired.

CREATE TABLE IF NOT EXISTS rag.documentfield (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  documentid integer NOT NULL REFERENCES rag.document(id) ON DELETE CASCADE,
  pagenumber integer NOT NULL CHECK (pagenumber > 0),
  -- The printed question number ('1.5.1', '1.א'). Empty when the form prints
  -- none, which is why it is not part of the unique key on its own.
  label text NOT NULL,
  -- The question as read. Kept alongside the label so a stored answer is
  -- legible without the source page, and so a re-numbered form revision does
  -- not silently change what an old answer referred to.
  questiontext text NOT NULL,
  -- 'boolean' for a ticked כן/לא, 'value' for a figure written into a box.
  kind text NOT NULL CHECK (kind IN ('boolean', 'value')),
  -- The marked option ('כן'/'לא') or the written figure. Text rather than a
  -- boolean: a questionnaire's third state is "not answered", which is stored
  -- by having no row at all, and a figure has no boolean reading.
  value text NOT NULL,
  -- 0-1, the engine's own score, or null when it reports none. Same scale as
  -- documentpage confidence.
  confidence real CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  createdat timestamptz NOT NULL DEFAULT now(),
  -- One answer per question per document. A re-run with a different engine
  -- replaces the rows rather than accumulating a second reading, matching how
  -- documentpage is rewritten when a run's fingerprint changes.
  UNIQUE (documentid, pagenumber, label, questiontext)
);

-- The two access paths: everything read off one document (the UI panel), and
-- the positive answers across a claim (what underwriting actually asks for).
CREATE INDEX IF NOT EXISTS ix_documentfield_document ON rag.documentfield (documentid, pagenumber);
CREATE INDEX IF NOT EXISTS ix_documentfield_positive ON rag.documentfield (documentid) WHERE kind = 'boolean';
