-- ============================================================
-- 房间保留 7 天 + 每局复盘云端持久化
-- 应用：wbapp_2qkKI2ZGSh13zUKRFfD8Cm（2026-10-18）
--
-- 背景（用户需求 2026-10-18）：
--   好友房「有玩家参与过对战」的不应被立即销毁，应保留 7 天并可回看复盘；
--   进入房间后能看到每一局的逐街复盘。
--
-- 现状：poker_rooms 已有 status(active/closed)；复盘仅本地 replay-store（关 App 即失），
--   poker_records 只存每局摘要、无逐街事件流。
--
-- 本文件：
--   1) poker_rooms 加 expires_at / last_hand_at 两列；status 复用文本列，新增 'ended'。
--   2) 新建 poker_hand_replays（room_no + hand_no + payload(jsonb 逐街事件流)）。
--   3) 4 个 rpc：
--        poker_close_room        关闭房间：有对战→ended+expires_at(+7d)；无→closed
--        poker_save_hand_replay  保存一局复盘（upsert，幂等）
--        poker_list_room_replays 列出房间全部复盘（按 hand_no 升序）
--        poker_list_my_rooms     列出我的房间（active + 未过期 ended，owner 服务端过滤）
--
-- ⚠️ 执行：按块单条/分组执行。每次涉及云端结构改动，执行后必跑末尾「验证脚本」。
-- ⚠️ 换应用 = 换空库，须对着当前应用（cloud.js 的 wbpk_<appId>_…）重跑本文件。
-- ============================================================


-- ---------- 1. poker_rooms 加列 ----------
ALTER TABLE public.poker_rooms ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE public.poker_rooms ADD COLUMN IF NOT EXISTS last_hand_at timestamptz;


-- ---------- 2. 复盘表 ----------
CREATE TABLE IF NOT EXISTS public.poker_hand_replays (
  id         bigserial PRIMARY KEY,
  owner_id   text NOT NULL DEFAULT auth.uid(),
  room_no    text NOT NULL,
  hand_no    integer NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS poker_hand_replays_room_hand_uidx
  ON public.poker_hand_replays (room_no, hand_no);
CREATE INDEX IF NOT EXISTS poker_hand_replays_owner_room_idx
  ON public.poker_hand_replays (owner_id, room_no, hand_no);

ALTER TABLE public.poker_hand_replays ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.poker_hand_replays TO authenticated;
CREATE POLICY poker_hand_replays_owner ON public.poker_hand_replays
  FOR ALL TO authenticated
  USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());


-- ---------- 3. 关闭房间（智能：有对战→ended+7天；无→closed） ----------
CREATE OR REPLACE FUNCTION public.poker_close_room(p_room text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid  text := auth.uid();
  v_has  boolean;
  v_exp  timestamptz;
BEGIN
  IF v_uid IS NULL THEN RETURN json_build_object('ok', false, 'reason', '未登录'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.poker_rooms WHERE room_no = p_room AND owner_id = v_uid) THEN
    RETURN json_build_object('ok', false, 'reason', '无权限');
  END IF;
  -- 「有对战」判定：last_hand_at 已置 或 已有复盘记录
  SELECT COALESCE(last_hand_at IS NOT NULL, false) INTO v_has
    FROM public.poker_rooms WHERE room_no = p_room;
  IF NOT v_has THEN
    SELECT EXISTS (SELECT 1 FROM public.poker_hand_replays WHERE room_no = p_room) INTO v_has;
  END IF;
  IF v_has THEN
    v_exp := now() + interval '7 days';
    UPDATE public.poker_rooms SET status = 'ended', expires_at = v_exp
     WHERE room_no = p_room AND owner_id = v_uid;
    RETURN json_build_object('ok', true, 'status', 'ended', 'expires_at', v_exp);
  ELSE
    UPDATE public.poker_rooms SET status = 'closed' WHERE room_no = p_room AND owner_id = v_uid;
    RETURN json_build_object('ok', true, 'status', 'closed');
  END IF;
END;
$fn$;


-- ---------- 4. 保存一局复盘（upsert，幂等） ----------
CREATE OR REPLACE FUNCTION public.poker_save_hand_replay(p_room text, p_hand integer, p_payload json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN json_build_object('ok', false, 'reason', '未登录'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.poker_rooms WHERE room_no = p_room AND owner_id = v_uid) THEN
    RETURN json_build_object('ok', false, 'reason', '无权限');
  END IF;
  INSERT INTO public.poker_hand_replays (owner_id, room_no, hand_no, payload)
    VALUES (v_uid, p_room, p_hand, p_payload)
  ON CONFLICT (room_no, hand_no) DO UPDATE SET payload = EXCLUDED.payload, created_at = now();
  UPDATE public.poker_rooms SET last_hand_at = now() WHERE room_no = p_room AND last_hand_at IS NULL;
  RETURN json_build_object('ok', true);
END;
$fn$;


-- ---------- 5. 列出房间全部复盘（按 hand_no 升序） ----------
CREATE OR REPLACE FUNCTION public.poker_list_room_replays(p_room text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN json_build_object('ok', false, 'reason', '未登录'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.poker_rooms WHERE room_no = p_room AND owner_id = v_uid) THEN
    RETURN json_build_object('ok', false, 'reason', '无权限');
  END IF;
  RETURN json_build_object('ok', true, 'rows', COALESCE(
    (SELECT json_agg(r ORDER BY r.hand_no ASC)
       FROM public.poker_hand_replays r
      WHERE r.owner_id = v_uid AND r.room_no = p_room), '[]'::json));
END;
$fn$;


-- ---------- 6. 列出我的房间（active + 未过期 ended） ----------
CREATE OR REPLACE FUNCTION public.poker_list_my_rooms()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN json_build_object('ok', false, 'reason', '未登录'); END IF;
  RETURN json_build_object('ok', true, 'rows', COALESCE(
    (SELECT json_agg(r ORDER BY r.created_at DESC)
       FROM public.poker_rooms r
      WHERE r.owner_id = v_uid
        AND (r.status = 'active'
             OR (r.status = 'ended' AND r.expires_at >= now()))), '[]'::json));
END;
$fn$;


-- ---------- 7. 彻底删除房间（房主手动清除 ended 房，连复盘一并删） ----------
CREATE OR REPLACE FUNCTION public.poker_purge_room(p_room text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN json_build_object('ok', false, 'reason', '未登录'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.poker_rooms WHERE room_no = p_room AND owner_id = v_uid) THEN
    RETURN json_build_object('ok', false, 'reason', '无权限');
  END IF;
  DELETE FROM public.poker_hand_replays WHERE room_no = p_room AND owner_id = v_uid;
  DELETE FROM public.poker_rooms WHERE room_no = p_room AND owner_id = v_uid;
  RETURN json_build_object('ok', true);
END;
$fn$;


-- ---------- 8. 函数执行授权 ----------
GRANT EXECUTE ON FUNCTION public.poker_close_room(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.poker_save_hand_replay(text, integer, json) TO authenticated;
GRANT EXECUTE ON FUNCTION public.poker_list_room_replays(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.poker_list_my_rooms() TO authenticated;
GRANT EXECUTE ON FUNCTION public.poker_purge_room(text) TO authenticated;


-- ============================================================
-- 验证脚本（迁移后必跑）
-- ============================================================
-- 1) 函数齐全且 SECURITY DEFINER：
--    SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--     WHERE n.nspname='public' AND proname LIKE 'poker%' ORDER BY proname;
--    期望新增：poker_close_room / poker_list_my_rooms / poker_list_room_replays / poker_save_hand_replay
--
-- 2) 新表与列：
--    SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='poker_hand_replays';
--    SELECT column_name FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='poker_rooms'
--       AND column_name IN ('expires_at','last_hand_at');
--
-- 3) 冒烟（admin 上下文 auth.uid() 为 NULL，应全部返回「未登录」）：
--    SELECT public.poker_close_room('x'), public.poker_list_room_replays('x'),
--           public.poker_list_my_rooms();
-- ============================================================
