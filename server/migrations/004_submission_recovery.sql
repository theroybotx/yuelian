BEGIN;
ALTER TABLE app.plans ADD COLUMN submission_open boolean NOT NULL DEFAULT false;
ALTER TABLE app.plans DROP CONSTRAINT plans_status_check;
ALTER TABLE app.plans ADD CONSTRAINT plans_status_check CHECK(status IN ('pending','committed','undone','cancelled'));
-- A browser-confirmed submission stays discoverable until its receipt is
-- acknowledged. This covers lost create/commit responses without client data.
CREATE UNIQUE INDEX plans_one_open_submission ON app.plans(workspace_id,actor_id) WHERE submission_open;
COMMIT;
