BEGIN;
CREATE TABLE private.accounts (
 id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
 username text NOT NULL UNIQUE CHECK (username ~ '^[a-z][a-z0-9._-]{2,31}$'),
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
 registration_role text NOT NULL CHECK (registration_role IN ('coach','student')),
 login_kind text NOT NULL CHECK (login_kind IN ('password','test')),
 password_salt text, password_hash text,
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((login_kind='password' AND password_salt IS NOT NULL AND password_hash IS NOT NULL AND password_salt ~ '^[a-f0-9]{32}$' AND password_hash ~ '^[a-f0-9]{128}$') OR (login_kind='test' AND password_salt IS NULL AND password_hash IS NULL))
);
CREATE TABLE private.sessions (
 token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
 account_id text NOT NULL REFERENCES private.accounts(id),
 platform_id text NOT NULL CHECK (length(platform_id) BETWEEN 1 AND 200),
 test_persona text,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 CHECK (expires_at>created_at)
);
CREATE INDEX sessions_account ON private.sessions(account_id);
CREATE INDEX sessions_expiration ON private.sessions(expires_at);
-- These tables are accessible only to the trusted authentication service. They
-- are never included in workspace queries, model context or browser snapshots.
-- Runtime is not their owner and cannot change schema or grant privileges.
REVOKE ALL ON private.accounts,private.sessions FROM PUBLIC;
GRANT SELECT,INSERT ON private.accounts TO yuelian_runtime;
-- Row locks also require an UPDATE privilege. Account activation has no public
-- mutation endpoint; only administration can change it in the application.
GRANT UPDATE(active) ON private.accounts TO yuelian_runtime;
GRANT SELECT,INSERT ON private.sessions TO yuelian_runtime;
GRANT UPDATE(revoked_at) ON private.sessions TO yuelian_runtime;

ALTER TABLE app.invitations ADD COLUMN recipient_account_id text REFERENCES private.accounts(id);
-- Old invitations used platform email hashes. They cannot be redeemed against
-- independent accounts; the issuer can generate a new username-bound invite.
UPDATE app.invitations SET revoked_at=now() WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE OR REPLACE FUNCTION private.accept_invite(token text, label text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE inv app.invitations; issuer_role text; existing app.memberships;
BEGIN
 SELECT * INTO inv FROM app.invitations WHERE token_hash=token;
 IF NOT FOUND THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(inv.workspace_id::text,0));
 SELECT * INTO inv FROM app.invitations WHERE token_hash=token FOR UPDATE;
 IF NOT FOUND OR inv.accepted_at IS NOT NULL OR inv.revoked_at IS NOT NULL OR inv.expires_at<=now()
 OR inv.recipient_account_id IS DISTINCT FROM private.actor() OR private.actor() IS NULL
 OR NOT EXISTS(SELECT 1 FROM private.accounts WHERE id=private.actor() AND active)
 THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='42501'; END IF;
 SELECT role INTO issuer_role FROM app.memberships WHERE workspace_id=inv.workspace_id AND user_id=inv.issued_by AND active;
 IF issuer_role IS NULL OR issuer_role NOT IN ('owner','admin') OR inv.role='admin' AND issuer_role<>'owner' THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='42501'; END IF;
 IF inv.student_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.records WHERE workspace_id=inv.workspace_id AND id=inv.student_id AND kind='student') THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO existing FROM app.memberships WHERE workspace_id=inv.workspace_id AND user_id=private.actor();
 IF FOUND THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='42501'; END IF;
 INSERT INTO app.memberships(workspace_id,user_id,display_name,role,permissions,student_id)
 VALUES(inv.workspace_id,private.actor(),label,inv.role,inv.permissions,inv.student_id);
 UPDATE app.invitations SET accepted_at=now() WHERE workspace_id=inv.workspace_id AND id=inv.id;
 RETURN inv.workspace_id;
END $$;
COMMIT;
