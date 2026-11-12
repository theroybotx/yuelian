BEGIN;
ALTER TABLE app.records DROP CONSTRAINT records_kind_check;
ALTER TABLE app.records ADD CONSTRAINT records_kind_check CHECK(kind IN ('student','contact','coach-note','venue','availability','lesson','participant','ledger','feedback','practice','message','settings','followup'));
ALTER TABLE app.records ADD CONSTRAINT followup_student_required CHECK(kind<>'followup' OR student_id IS NOT NULL);
CREATE UNIQUE INDEX settings_once ON app.records(workspace_id) WHERE kind='settings';
ALTER TABLE app.plans ADD COLUMN changes jsonb;
ALTER TABLE app.plans DROP CONSTRAINT plans_status_check;
ALTER TABLE app.plans ADD CONSTRAINT plans_status_check CHECK(status IN ('pending','committed','undone'));
CREATE OR REPLACE FUNCTION private.read_record(w uuid, record_id uuid, k text, student uuid, owner_id text, vis text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT w=private.workspace() AND private.role_for(w) IS NOT NULL AND (
  private.can(w, CASE k
   WHEN 'student' THEN 'students.read' WHEN 'contact' THEN 'contacts.read'
   WHEN 'coach-note' THEN 'notes.read' WHEN 'ledger' THEN 'ledger.read'
   WHEN 'practice' THEN 'practice.read' WHEN 'feedback' THEN 'feedback.read'
   WHEN 'followup' THEN 'students.write' WHEN 'settings' THEN 'schedule.read'
   WHEN 'venue' THEN 'venues.read' WHEN 'availability' THEN 'schedule.read'
   ELSE 'schedule.read' END)
  AND (k <> 'practice' OR vis='shared' OR owner_id=private.actor())
  AND (k <> 'followup' OR private.can(w,'ledger.read') AND private.can(w,'schedule.read'))
  OR private.role_for(w)='student' AND (
   k='student' AND record_id=private.student_for(w)
   OR k IN ('venue','availability','settings') AND vis='shared'
   OR k='lesson' AND (private.participates(w,record_id) OR student=private.student_for(w) AND owner_id=private.actor())
   OR k IN ('contact','participant','ledger') AND student=private.student_for(w)
   OR k IN ('message','feedback') AND student=private.student_for(w) AND vis='shared'
   OR k='practice' AND student=private.student_for(w) AND owner_id=private.actor()
  )
 )
$$;
CREATE OR REPLACE FUNCTION private.write_record(w uuid, k text, student uuid, owner_id text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT w=private.workspace() AND private.role_for(w) IS NOT NULL AND (
  private.can(w, CASE k
   WHEN 'student' THEN 'students.write' WHEN 'contact' THEN 'contacts.write'
   WHEN 'coach-note' THEN 'notes.write' WHEN 'ledger' THEN 'ledger.write'
   WHEN 'practice' THEN 'practice.write' WHEN 'feedback' THEN 'feedback.write'
   WHEN 'followup' THEN 'students.write' WHEN 'venue' THEN 'venues.write' ELSE 'schedule.write' END)
  AND k <> 'practice'
  OR private.role_for(w)='student' AND k IN ('lesson','participant','practice','message')
    AND student=private.student_for(w) AND (k<>'practice' OR owner_id=private.actor())
 )
$$;

CREATE OR REPLACE FUNCTION private.slot_available(w uuid, day_date text, start_minute integer, duration_minute integer, venue uuid, excluding uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE rule app.records; base app.records; dow text; gap integer:=0; travel integer:=0;
BEGIN
 IF w IS DISTINCT FROM private.workspace() OR private.role_for(w) IS NULL THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.records WHERE workspace_id=w AND id=venue AND kind='venue' AND (visibility='shared' OR private.can(w,'venues.read'))) THEN RETURN false; END IF;
 dow=(ARRAY['日','一','二','三','四','五','六'])[extract(dow FROM day_date::date)::integer+1];
 SELECT * INTO base FROM app.records WHERE workspace_id=w AND kind='settings';
 travel=coalesce((base.payload->>'travel')::integer,0);
 SELECT * INTO rule FROM app.records WHERE workspace_id=w AND kind='availability' AND visibility='shared'
  AND venue_id=venue AND payload->>'day'=dow AND payload->>'from'<=day_date AND payload->>'to'>=day_date
  ORDER BY updated_at DESC,id LIMIT 1;
 IF FOUND THEN
  IF start_minute<extract(epoch FROM (rule.payload->>'start')::time)::integer/60 OR start_minute+duration_minute>extract(epoch FROM (rule.payload->>'end')::time)::integer/60 THEN RETURN false; END IF;
  gap=coalesce((rule.payload->>'gap')::integer,0);
 ELSE
  IF base.id IS NULL OR NOT (base.payload->'days' ? dow) OR start_minute<extract(epoch FROM (base.payload->>'start')::time)::integer/60 OR start_minute+duration_minute>extract(epoch FROM (base.payload->>'end')::time)::integer/60 THEN RETURN false; END IF;
 END IF;
 RETURN NOT EXISTS(SELECT 1 FROM app.records r WHERE r.workspace_id=w AND r.kind='lesson' AND r.payload->>'date'=day_date
  AND r.payload->>'state'<>'cancelled' AND (excluding IS NULL OR r.id<>excluding)
  AND start_minute<(r.payload->>'start')::integer+(r.payload->>'duration')::integer+CASE WHEN r.venue_id<>venue THEN greatest(travel,gap) ELSE gap END
  AND (r.payload->>'start')::integer<start_minute+duration_minute+CASE WHEN r.venue_id<>venue THEN greatest(travel,gap) ELSE gap END);
END $$;
CREATE POLICY record_delete ON app.records FOR DELETE TO yuelian_runtime USING(private.write_record(workspace_id,kind,student_id,owner_user_id));
GRANT DELETE ON app.records TO yuelian_runtime;
COMMIT;
