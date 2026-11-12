BEGIN;
CREATE SCHEMA app;
CREATE SCHEMA private;
REVOKE ALL ON SCHEMA app, private FROM PUBLIC;
GRANT USAGE ON SCHEMA app, private TO yuelian_runtime;

CREATE FUNCTION private.actor() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.actor', true), '')
$$;
CREATE FUNCTION private.workspace() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.workspace', true), '')::uuid
$$;

CREATE TABLE app.workspaces (
  id uuid PRIMARY KEY, name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.memberships (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id), user_id text NOT NULL,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  role text NOT NULL CHECK (role IN ('owner','admin','assistant','student')),
  permissions text[] NOT NULL DEFAULT '{}', student_id uuid,
  active boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, user_id),
  CHECK ((role = 'student') = (student_id IS NOT NULL))
);
CREATE UNIQUE INDEX membership_one_student ON app.memberships(workspace_id,student_id) WHERE student_id IS NOT NULL;

-- These two small security-definer functions return authorization facts only.
-- They are owned by the migration role, never by the request-serving role.
-- Fully qualified objects and a fixed search_path prevent name substitution.
CREATE FUNCTION private.role_for(w uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
 SELECT role FROM app.memberships
 WHERE workspace_id=w AND user_id=private.actor() AND active
$$;
CREATE FUNCTION private.can(w uuid, capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
 SELECT coalesce((SELECT role='owner' OR
   (role='admin' AND capability <> 'ownership.transfer') OR
   (role='assistant' AND capability=ANY(permissions))
 FROM app.memberships WHERE workspace_id=w AND user_id=private.actor() AND active), false)
$$;
CREATE FUNCTION private.student_for(w uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
 SELECT student_id FROM app.memberships WHERE workspace_id=w AND user_id=private.actor() AND role='student' AND active
$$;

-- Each row contains one data category. Contacts, private coach notes and ledger
-- entries are separate rows, never fields hidden by the browser in a student row.
CREATE TABLE app.records (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id), id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('student','contact','coach-note','venue','availability','lesson','participant','ledger','feedback','practice','message')),
  student_id uuid, lesson_id uuid, venue_id uuid,
  owner_user_id text NOT NULL,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,student_id) REFERENCES app.records(workspace_id,id),
  FOREIGN KEY(workspace_id,lesson_id) REFERENCES app.records(workspace_id,id),
  FOREIGN KEY(workspace_id,venue_id) REFERENCES app.records(workspace_id,id),
  CHECK (kind NOT IN ('contact','coach-note','participant','ledger','feedback','practice','message') OR student_id IS NOT NULL),
  CHECK (kind <> 'participant' OR lesson_id IS NOT NULL),
  CHECK (kind <> 'lesson' OR venue_id IS NOT NULL)
);
ALTER TABLE app.memberships ADD FOREIGN KEY(workspace_id,student_id) REFERENCES app.records(workspace_id,id);
CREATE INDEX records_lookup ON app.records(workspace_id,kind,student_id);
CREATE INDEX records_lesson ON app.records(workspace_id,lesson_id);
CREATE UNIQUE INDEX participant_once ON app.records(workspace_id,lesson_id,student_id) WHERE kind='participant';
CREATE UNIQUE INDEX lesson_charge_once ON app.records(workspace_id,lesson_id,student_id) WHERE kind='ledger' AND lesson_id IS NOT NULL;

-- Validate references by type as well as workspace. No cross-workspace UUID can
-- be used to link a new record, even when an application check is omitted.
CREATE FUNCTION private.check_record_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.student_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.records WHERE workspace_id=NEW.workspace_id AND id=NEW.student_id AND kind='student') THEN RAISE EXCEPTION 'invalid reference' USING ERRCODE='23514'; END IF;
 IF NEW.lesson_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.records WHERE workspace_id=NEW.workspace_id AND id=NEW.lesson_id AND kind='lesson') THEN RAISE EXCEPTION 'invalid reference' USING ERRCODE='23514'; END IF;
 IF NEW.venue_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.records WHERE workspace_id=NEW.workspace_id AND id=NEW.venue_id AND kind='venue') THEN RAISE EXCEPTION 'invalid reference' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER record_links BEFORE INSERT OR UPDATE ON app.records FOR EACH ROW EXECUTE FUNCTION private.check_record_links();

CREATE FUNCTION private.participates(w uuid, lesson uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM app.records r WHERE r.workspace_id=w AND r.kind='participant'
   AND r.lesson_id=lesson AND r.student_id=private.student_for(w))
$$;
CREATE FUNCTION private.read_record(w uuid, record_id uuid, k text, student uuid, owner_id text, vis text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT w=private.workspace() AND private.role_for(w) IS NOT NULL AND (
  private.can(w, CASE k
   WHEN 'student' THEN 'students.read' WHEN 'contact' THEN 'contacts.read'
   WHEN 'coach-note' THEN 'notes.read' WHEN 'ledger' THEN 'ledger.read'
   WHEN 'practice' THEN 'practice.read' WHEN 'feedback' THEN 'feedback.read'
   WHEN 'venue' THEN 'venues.read' WHEN 'availability' THEN 'schedule.read'
   ELSE 'schedule.read' END)
  AND (k <> 'practice' OR vis='shared' OR owner_id=private.actor())
  OR private.role_for(w)='student' AND (
   k='student' AND record_id=private.student_for(w)
   OR k IN ('venue','availability') AND vis='shared'
   OR k='lesson' AND (private.participates(w,record_id) OR student=private.student_for(w) AND owner_id=private.actor())
   OR k IN ('contact','participant','ledger') AND student=private.student_for(w)
   OR k IN ('message','feedback') AND student=private.student_for(w) AND vis='shared'
   OR k='practice' AND student=private.student_for(w) AND owner_id=private.actor()
  )
 )
$$;
CREATE FUNCTION private.write_record(w uuid, k text, student uuid, owner_id text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT w=private.workspace() AND private.role_for(w) IS NOT NULL AND (
  private.can(w, CASE k
   WHEN 'student' THEN 'students.write' WHEN 'contact' THEN 'contacts.write'
   WHEN 'coach-note' THEN 'notes.write' WHEN 'ledger' THEN 'ledger.write'
   WHEN 'practice' THEN 'practice.write' WHEN 'feedback' THEN 'feedback.write'
   WHEN 'venue' THEN 'venues.write' ELSE 'schedule.write' END)
  AND k <> 'practice'
  OR private.role_for(w)='student' AND k IN ('lesson','participant','practice','message')
    AND student=private.student_for(w) AND (k<>'practice' OR owner_id=private.actor())
 )
$$;

CREATE TABLE app.invitations (
 workspace_id uuid NOT NULL REFERENCES app.workspaces(id), id uuid NOT NULL,
 token_hash text UNIQUE NOT NULL, email_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','assistant','student')),
 permissions text[] NOT NULL DEFAULT '{}', student_id uuid,
 issued_by text NOT NULL, expires_at timestamptz NOT NULL,
 accepted_at timestamptz, revoked_at timestamptz,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,student_id) REFERENCES app.records(workspace_id,id),
 CHECK ((role='student')=(student_id IS NOT NULL))
);
CREATE TABLE app.plans (
 workspace_id uuid NOT NULL REFERENCES app.workspaces(id), id uuid NOT NULL,
 actor_id text NOT NULL, plan jsonb NOT NULL, membership_revision integer NOT NULL,
 expires_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','committed')),
 result jsonb, PRIMARY KEY(workspace_id,id)
);
CREATE TABLE app.audit (
 workspace_id uuid NOT NULL REFERENCES app.workspaces(id), id uuid NOT NULL,
 actor_id text NOT NULL, action text NOT NULL, outcome text NOT NULL,
 targets uuid[] NOT NULL DEFAULT '{}', request_id uuid NOT NULL,
 at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id)
);
CREATE TABLE private.request_nonces (nonce uuid PRIMARY KEY, expires_at timestamptz NOT NULL);

ALTER TABLE app.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit ENABLE ROW LEVEL SECURITY;
-- The migration owner is intentionally allowed only for bounded, audited helper
-- functions. Runtime is neither table owner nor BYPASSRLS. Forcing RLS on records
-- would make the helper reference checks recursive, so do NOT use that account
-- to serve requests. Runtime startup refuses privileged/owner credentials.
CREATE POLICY workspace_read ON app.workspaces FOR SELECT TO yuelian_runtime USING(private.role_for(id) IS NOT NULL);
CREATE POLICY workspace_create ON app.workspaces FOR INSERT TO yuelian_runtime WITH CHECK(created_by=private.actor());
CREATE POLICY member_read ON app.memberships FOR SELECT TO yuelian_runtime USING(user_id=private.actor() OR workspace_id=private.workspace() AND private.can(workspace_id,'team.manage'));
CREATE POLICY member_update ON app.memberships FOR UPDATE TO yuelian_runtime USING(workspace_id=private.workspace() AND role<>'owner' AND private.can(workspace_id,'team.manage')) WITH CHECK(workspace_id=private.workspace() AND role<>'owner' AND private.can(workspace_id,'team.manage'));
CREATE POLICY record_read ON app.records FOR SELECT TO yuelian_runtime USING(private.read_record(workspace_id,id,kind,student_id,owner_user_id,visibility));
CREATE POLICY record_insert ON app.records FOR INSERT TO yuelian_runtime WITH CHECK(private.write_record(workspace_id,kind,student_id,owner_user_id));
CREATE POLICY record_update ON app.records FOR UPDATE TO yuelian_runtime USING(private.write_record(workspace_id,kind,student_id,owner_user_id)) WITH CHECK(private.write_record(workspace_id,kind,student_id,owner_user_id));
CREATE POLICY invite_read ON app.invitations FOR SELECT TO yuelian_runtime USING(workspace_id=private.workspace() AND private.can(workspace_id,'team.manage'));
CREATE POLICY invite_insert ON app.invitations FOR INSERT TO yuelian_runtime WITH CHECK(workspace_id=private.workspace() AND issued_by=private.actor() AND private.can(workspace_id,'team.manage') AND (role<>'admin' OR private.role_for(workspace_id)='owner'));
CREATE POLICY invite_update ON app.invitations FOR UPDATE TO yuelian_runtime USING(workspace_id=private.workspace() AND private.can(workspace_id,'team.manage')) WITH CHECK(workspace_id=private.workspace() AND private.can(workspace_id,'team.manage'));
CREATE POLICY plan_own ON app.plans FOR ALL TO yuelian_runtime USING(workspace_id=private.workspace() AND actor_id=private.actor() AND private.role_for(workspace_id) IS NOT NULL) WITH CHECK(workspace_id=private.workspace() AND actor_id=private.actor() AND private.role_for(workspace_id) IS NOT NULL);
CREATE POLICY audit_read ON app.audit FOR SELECT TO yuelian_runtime USING(workspace_id=private.workspace() AND private.can(workspace_id,'audit.read'));
CREATE POLICY audit_insert ON app.audit FOR INSERT TO yuelian_runtime WITH CHECK(workspace_id=private.workspace() AND actor_id=private.actor() AND private.role_for(workspace_id) IS NOT NULL);

CREATE FUNCTION private.slot_available(w uuid, day_date text, start_minute integer, duration_minute integer, venue uuid, excluding uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE rule app.records; dow text;
BEGIN
 IF w IS DISTINCT FROM private.workspace() OR private.role_for(w) IS NULL THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.records WHERE workspace_id=w AND id=venue AND kind='venue' AND (visibility='shared' OR private.can(w,'venues.read'))) THEN RETURN false; END IF;
 dow=(ARRAY['日','一','二','三','四','五','六'])[extract(dow FROM day_date::date)::integer+1];
 SELECT * INTO rule FROM app.records WHERE workspace_id=w AND kind='availability' AND visibility='shared'
  AND payload->>'day'=dow AND payload->>'from'<=day_date AND payload->>'to'>=day_date
  ORDER BY created_at DESC,id LIMIT 1;
 IF NOT FOUND OR rule.venue_id<>venue OR start_minute<extract(epoch FROM (rule.payload->>'start')::time)::integer/60
  OR start_minute+duration_minute>extract(epoch FROM (rule.payload->>'end')::time)::integer/60 THEN RETURN false; END IF;
 RETURN NOT EXISTS(SELECT 1 FROM app.records r WHERE r.workspace_id=w AND r.kind='lesson' AND r.payload->>'date'=day_date
  AND r.payload->>'state'<>'cancelled' AND (excluding IS NULL OR r.id<>excluding)
  AND start_minute<(r.payload->>'start')::integer+(r.payload->>'duration')::integer+coalesce((rule.payload->>'gap')::integer,0)
  AND (r.payload->>'start')::integer<start_minute+duration_minute+coalesce((rule.payload->>'gap')::integer,0));
END $$;

-- Token acceptance cannot enumerate invitations. It checks the logged-in email,
-- one-time token, expiry, revocation, current issuer authority and student type.
CREATE FUNCTION private.create_workspace(w uuid, title text, label text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF private.actor() IS NULL THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='42501'; END IF;
 INSERT INTO app.workspaces(id,name,created_by) VALUES(w,title,private.actor());
 INSERT INTO app.memberships(workspace_id,user_id,display_name,role) VALUES(w,private.actor(),label,'owner');
 RETURN w;
END $$;
CREATE FUNCTION private.accept_invite(token text, label text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE inv app.invitations; issuer_role text; existing app.memberships;
BEGIN
 SELECT * INTO inv FROM app.invitations WHERE token_hash=token;
 IF NOT FOUND THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(inv.workspace_id::text,0));
 SELECT * INTO inv FROM app.invitations WHERE token_hash=token FOR UPDATE;
 IF NOT FOUND OR inv.accepted_at IS NOT NULL OR inv.revoked_at IS NOT NULL OR inv.expires_at<=now()
 OR inv.email_hash IS DISTINCT FROM nullif(current_setting('request.email_hash',true),'')
 OR private.actor() IS NULL THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='42501'; END IF;
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

REVOKE ALL ON ALL TABLES IN SCHEMA app,private FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
GRANT SELECT,INSERT ON app.workspaces TO yuelian_runtime;
GRANT SELECT,UPDATE ON app.memberships TO yuelian_runtime;
GRANT SELECT,INSERT,UPDATE ON app.records,app.invitations,app.plans TO yuelian_runtime;
GRANT SELECT,INSERT ON app.audit TO yuelian_runtime;
GRANT INSERT,DELETE ON private.request_nonces TO yuelian_runtime;
GRANT EXECUTE ON FUNCTION private.actor(),private.workspace(),private.role_for(uuid),private.can(uuid,text),private.student_for(uuid),private.participates(uuid,uuid),private.read_record(uuid,uuid,text,uuid,text,text),private.write_record(uuid,text,uuid,text),private.accept_invite(text,text),private.create_workspace(uuid,text,text) TO yuelian_runtime;
GRANT EXECUTE ON FUNCTION private.slot_available(uuid,text,integer,integer,uuid,uuid) TO yuelian_runtime;
COMMIT;
