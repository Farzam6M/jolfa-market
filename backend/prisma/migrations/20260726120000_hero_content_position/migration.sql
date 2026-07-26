-- Adds the contentPosition column used to place the Hero slide's text/button
-- block over its image (right / left / center). NOT NULL with a DEFAULT so
-- every existing hero_slides row is backfilled to 'right' automatically —
-- no separate UPDATE statement needed.
ALTER TABLE "hero_slides" ADD COLUMN "contentPosition" TEXT NOT NULL DEFAULT 'right';
