create or replace function public.goalflow_initial_focus_journal_v1(account_id text, baseline jsonb default null)
returns jsonb language plpgsql stable set search_path=pg_catalog,public,extensions as $fn$
declare journal jsonb; session_id text;
begin
  if account_id is null or account_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'A focus journal needs an immutable account identity' using errcode='22023';
  end if;
  journal := jsonb_build_object('schemaVersion',1,'accountId',account_id,'currentSessionId',null,'sessions','{}'::jsonb,'operations','{}'::jsonb);
  if baseline is null or baseline='null'::jsonb then return journal; end if;
  perform public.goalflow_focus_session_time(baseline);
  session_id := baseline->>'sessionId';
  journal := jsonb_set(journal,'{currentSessionId}',to_jsonb(session_id));
  return jsonb_set(journal,array['sessions',session_id],jsonb_build_object('projection',baseline,'initialProjection',baseline,
    'epoch',session_id,'revision',session_id,'parents',jsonb_build_object(session_id,jsonb_build_object('parent',null,'kind','baseline'))));
end; $fn$;

create or replace function public.goalflow_focus_reply_v1(journal jsonb, command jsonb, accepted boolean, code text, revision text)
returns jsonb language sql immutable set search_path=pg_catalog as $fn$
  select jsonb_build_object('journal',jsonb_set(journal,array['operations',command->>'actionId'],
    jsonb_build_object('command',command,'outcome',jsonb_build_object('accepted',accepted,'code',code,'revision',revision))),
    'outcome',jsonb_build_object('accepted',accepted,'code',code,'revision',revision),'duplicate',false);
$fn$;

-- The journal argument is trusted coordinator state, never client history.
-- The server admission transaction will read it under its own account lock.
create or replace function public.goalflow_apply_focus_v1(journal jsonb, command jsonb)
returns jsonb language plpgsql stable set search_path=pg_catalog,public,extensions as $fn$
declare
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  action_id text := command->>'actionId';
  session_id text := command->>'sessionId';
  kind text := command->>'kind';
  session jsonb;
  focus jsonb;
  next_focus jsonb;
  prior jsonb;
  current_session jsonb;
  revision text;
  parent text;
  step jsonb;
  visited text[] := array[]::text[];
  phase text;
  duration numeric;
  elapsed numeric;
  captured timestamptz;
  anchor timestamptz;
  previous_update timestamptz;
  valid boolean;
begin
  valid := jsonb_typeof(command)='object' and command->'schemaVersion'='1'::jsonb
    and action_id ~ uuid_pattern and command->>'accountId' ~ uuid_pattern
    and session_id ~ uuid_pattern and command->>'epoch' ~ uuid_pattern
    and kind in ('start','pause','resume','extend','extendAndResume','stop','complete')
    and jsonb_typeof(command->'actorId')='string' and length(command->>'actorId') between 1 and 240
    and jsonb_typeof(command->'taskId')='string' and length(btrim(command->>'taskId'))>0 and length(command->>'taskId')<=240
    and (command->'expectedRevision'='null'::jsonb or command->>'expectedRevision' ~ uuid_pattern)
    and (command->'expectedCurrentSessionId'='null'::jsonb or command->>'expectedCurrentSessionId' ~ uuid_pattern)
    and command->>'capturedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    and (kind<>'start' or command->>'epoch'=action_id);
  if valid is distinct from true then raise exception 'Invalid focus command' using errcode='22023'; end if;
  if kind in ('start','extend','extendAndResume') then
    if jsonb_typeof(command->'durationSeconds') is distinct from 'number' then raise exception 'Invalid focus command duration' using errcode='22023'; end if;
    duration := (command->>'durationSeconds')::numeric;
    if duration<=0 or duration>9007199254740991 or trunc(duration)<>duration then raise exception 'Invalid focus command duration' using errcode='22023'; end if;
  elsif command->'durationSeconds' is distinct from 'null'::jsonb then raise exception 'Invalid focus command duration' using errcode='22023'; end if;
  begin
    captured := (command->>'capturedAt')::timestamptz;
    if to_char(captured at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>command->>'capturedAt' then raise exception 'invalid instant'; end if;
  exception when others then raise exception 'Invalid focus command instant' using errcode='22023'; end;
  if journal->'schemaVersion' is distinct from '1'::jsonb or journal->>'accountId' is distinct from command->>'accountId'
    or jsonb_typeof(journal->'operations') is distinct from 'object' or jsonb_typeof(journal->'sessions') is distinct from 'object' then
    raise exception 'Focus account scope mismatch or damaged journal' using errcode='22023';
  end if;
  prior := journal->'operations'->action_id;
  if prior is not null then
    if prior->'command' is distinct from command or jsonb_typeof(prior->'outcome') is distinct from 'object' then
      raise exception 'Focus action identity has a different payload' using errcode='22023';
    end if;
    return jsonb_build_object('journal',journal,'outcome',prior->'outcome','duplicate',true);
  end if;
  session := journal->'sessions'->session_id;
  revision := session->>'revision';
  if kind='start' then
    if session is not null then return public.goalflow_focus_reply_v1(journal,command,false,'SESSION_EXISTS',revision); end if;
    if journal->'currentSessionId' is distinct from command->'expectedCurrentSessionId' then return public.goalflow_focus_reply_v1(journal,command,false,'STALE_TARGET',revision); end if;
    current_session := journal->'sessions'->(journal->>'currentSessionId');
    if current_session->>'revision' is distinct from command->>'expectedRevision' then return public.goalflow_focus_reply_v1(journal,command,false,'STALE_REVISION',revision); end if;
    if duration<60 or duration>86400 then return public.goalflow_focus_reply_v1(journal,command,false,'INVALID_RANGE',revision); end if;
    focus := jsonb_build_object('schemaVersion',1,'sessionId',session_id,'taskId',command->>'taskId','phase','active',
      'plannedDurationSeconds',duration,'startedAt',command->>'capturedAt','updatedAt',command->>'capturedAt',
      'elapsedSeconds',0,'pausedAt',null,'endedAt',null);
    session := jsonb_build_object('epoch',command->>'epoch','revision',action_id,'projection',focus,'initialProjection',focus,
      'parents',jsonb_build_object(action_id,jsonb_build_object('parent',null,'kind','start')));
    journal := jsonb_set(jsonb_set(journal,array['sessions',session_id],session),'{currentSessionId}',to_jsonb(session_id));
    return public.goalflow_focus_reply_v1(journal,command,true,'APPLIED',action_id);
  end if;
  if session is null or journal->>'currentSessionId' is distinct from session_id or command->>'expectedCurrentSessionId' is distinct from session_id
    or session->>'epoch' is distinct from command->>'epoch' or session->'projection'->>'taskId' is distinct from command->>'taskId' then
    return public.goalflow_focus_reply_v1(journal,command,false,'STALE_TARGET',revision);
  end if;
  focus := session->'projection';
  perform public.goalflow_focus_session_time(focus);
  phase := focus->>'phase';
  if phase in ('stopped','completed') then return public.goalflow_focus_reply_v1(journal,command,false,'TERMINAL',revision); end if;
  if revision is distinct from command->>'expectedRevision' then
    parent := revision;
    while parent is not null and parent is distinct from command->>'expectedRevision' and not(parent=any(visited)) loop
      visited := array_append(visited,parent);
      step := session->'parents'->parent;
      if step is null or step->>'kind' is distinct from 'extend' then exit; end if;
      parent := step->>'parent';
    end loop;
    if kind<>'extend' or command->>'expectedRevision' is null or parent is distinct from command->>'expectedRevision' then
      return public.goalflow_focus_reply_v1(journal,command,false,'STALE_REVISION',revision);
    end if;
  end if;
  if (kind='pause' and phase<>'active') or (kind in ('resume','extendAndResume') and phase<>'paused') then
    return public.goalflow_focus_reply_v1(journal,command,false,'INVALID_PHASE',revision);
  end if;
  next_focus := focus;
  if kind in ('extend','extendAndResume') then
    duration := (focus->>'plannedDurationSeconds')::numeric+duration;
    if duration>86400 then return public.goalflow_focus_reply_v1(journal,command,false,'INVALID_RANGE',revision); end if;
    next_focus := jsonb_set(next_focus,'{plannedDurationSeconds}',to_jsonb(duration));
  end if;
  -- Truncate legacy fractions before PostgreSQL's microsecond rounding, to
  -- match browser/Java millisecond elapsed measurement. Original strings stay
  -- in initialProjection and immutable commands/transport receipts.
  anchor := date_trunc('milliseconds',regexp_replace(focus->>'startedAt','(\.[0-9]{3})[0-9]+(Z|[+-])','\1\2')::timestamptz);
  elapsed := (focus->>'elapsedSeconds')::numeric;
  if phase='active' then elapsed := elapsed+greatest(0,floor(extract(epoch from captured-anchor))); end if;
  if elapsed>9007199254740991 then return public.goalflow_focus_reply_v1(journal,command,false,'INVALID_RANGE',revision); end if;
  if kind in ('pause','stop','complete') then
    next_focus := next_focus || jsonb_build_object('elapsedSeconds',elapsed,'startedAt',command->>'capturedAt',
      'phase',case kind when 'pause' then 'paused' when 'stop' then 'stopped' else 'completed' end,
      'pausedAt',case when kind='pause' then command->>'capturedAt' else null end,
      'endedAt',case when kind='pause' then null else command->>'capturedAt' end);
  elsif kind in ('resume','extendAndResume') then
    next_focus := next_focus || jsonb_build_object('startedAt',command->>'capturedAt','phase','active','pausedAt',null,'endedAt',null);
  end if;
  previous_update := date_trunc('milliseconds',regexp_replace(focus->>'updatedAt','(\.[0-9]{3})[0-9]+(Z|[+-])','\1\2')::timestamptz);
  next_focus := jsonb_set(next_focus,'{updatedAt}',to_jsonb(to_char(greatest(captured,previous_update) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  perform public.goalflow_focus_session_time(next_focus);
  session := jsonb_set(session,array['parents',action_id],jsonb_build_object('parent',revision,'kind',kind));
  session := session || jsonb_build_object('projection',next_focus,'revision',action_id);
  journal := jsonb_set(journal,array['sessions',session_id],session);
  return public.goalflow_focus_reply_v1(journal,command,true,'APPLIED',action_id);
end; $fn$;
revoke all on function public.goalflow_initial_focus_journal_v1(text,jsonb) from public,anon,authenticated;
revoke all on function public.goalflow_focus_reply_v1(jsonb,jsonb,boolean,text,text) from public,anon,authenticated;
revoke all on function public.goalflow_apply_focus_v1(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.goalflow_initial_focus_journal_v1(text,jsonb) to service_role;
grant execute on function public.goalflow_focus_reply_v1(jsonb,jsonb,boolean,text,text) to service_role;
grant execute on function public.goalflow_apply_focus_v1(jsonb,jsonb) to service_role;
