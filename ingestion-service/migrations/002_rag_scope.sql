-- REVIEW BEFORE APPLYING.
--
-- rag.claim is the scope key every content table hangs off: document,
-- documentchunk, ingestionrun, claimaggregate and querylog all carry a NOT NULL
-- claimid. The application, however, scopes documents by four entity types
-- (clm.claimevent, pol.policy, bp.customer, risk.legalevent), so using the
-- TALDAR entity id directly as rag.claim.id would let customer 5000 and claim
-- 5000 collide on one primary key and silently share documents.
--
-- This keeps rag.claim.id as an internal surrogate and records which entity a
-- scope row stands for. Every existing foreign key is left untouched.
--
-- Both columns are nullable so claim-only rows created by other consumers stay
-- legal; the unique index is partial for the same reason. Nothing at the
-- database level forces a writer to populate them.

ALTER TABLE rag.claim
  ADD COLUMN IF NOT EXISTS objecttype varchar(128),
  ADD COLUMN IF NOT EXISTS objectid   integer;

CREATE UNIQUE INDEX IF NOT EXISTS ux_claim_object
  ON rag.claim (objecttype, objectid)
  WHERE objecttype IS NOT NULL AND objectid IS NOT NULL;

COMMENT ON COLUMN rag.claim.objecttype IS
  'TALDAR source entity table this scope row stands for, matching gnr.archive.object_type (clm.claimevent, pol.policy, bp.customer, risk.legalevent).';
COMMENT ON COLUMN rag.claim.objectid IS
  'Identifier within objecttype. Unique per objecttype; not the same value as rag.claim.id.';
