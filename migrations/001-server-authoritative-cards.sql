-- ============================================================
-- 服务端权威化第一期：房卡/战绩写入收口到 rpc
-- 应用：首次执行于 wbapp_2qkKI2ZGSh13zUKRFfD8Cm（2026-10-16）
--
-- ⚠️ 换应用 = 换一个空数据库，本文件必须对着**当前**应用再跑一遍。
--    2026-10-17 曾短暂切到一个新建应用（未授权，已废弃），当时在新应用上
--    跑过一次：5 表 + 4 个 rpc 均落地，另有 poker_my_room_nos（客户端暂未调用）。
--    应用 ID 以 cloud.js 的 wbpk_<appId>_… 为准，勿信本文档里的旧值。
-- 执行日期：2026-10-16
--
-- 背景：commit ce1516a 把 miniprogram/utils/auth.js 的 4 个写入口改成调用
-- 云端 rpc，但**数据库迁移没有同步执行** —— 客户端调用时 rpc 不存在，
-- 且 auth.js 对 rpc 失败是 throw 无降级，导致建房扣卡 / 每日领卡两个核心
-- 流程直接失败。本文件补齐服务端那一半。
--
-- ⚠️ npm test 查不出这类问题：测试 mock 掉了 cloud 层，rpc 不存在照样全绿。
--    每次涉及云端调用方式改动，必须回云端实测 pg_proc / information_schema。
--
-- 执行方式：按顺序单条执行（不支持多语句）。
-- ============================================================


-- ---------- 1. 房卡流水表 ----------
CREATE TABLE IF NOT EXISTS public.poker_card_ledger (
  id            bigserial PRIMARY KEY,
  owner_id      text NOT NULL DEFAULT auth.uid(),
  delta         integer NOT NULL,          -- 正=发卡，负=扣卡
  reason        text NOT NULL,             -- consume_room | daily | hand_bonus
  token         text,                      -- 幂等键
  balance_after integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 幂等唯一键：同一 (owner_id, token) 只能有一条流水。
-- 三处复用这一个约束：建房 token、daily:<日期>、hands:<新基准>。
CREATE UNIQUE INDEX IF NOT EXISTS poker_card_ledger_token_uidx
  ON public.poker_card_ledger (owner_id, token) WHERE token IS NOT NULL;

CREATE INDEX IF NOT EXISTS poker_card_ledger_owner_created_idx
  ON public.poker_card_ledger (owner_id, created_at DESC);

-- RLS 两道独立门：先 ENABLE，再 GRANT，最后 POLICY。漏 GRANT 会得到
-- 形似「策略失效」的 42501。客户端只读自己的流水，写入一律经 rpc。
ALTER TABLE public.poker_card_ledger ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.poker_card_ledger TO authenticated;
CREATE POLICY poker_card_ledger_owner ON public.poker_card_ledger
  FOR SELECT TO authenticated USING (owner_id = auth.uid());


-- ---------- 2. 建房扣卡（余额校验 + 扣减 + 流水，同事务） ----------
-- 幂等：同 p_token 重发不二次扣（返回当前余额 + reason='幂等命中'）。
CREATE OR REPLACE FUNCTION public.poker_consume_room_card(p_count integer, p_token text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid   text := auth.uid();
  v_cards integer; v_new integer; v_dup integer;
BEGIN
  IF v_uid IS NULL THEN RETURN json_build_object('ok', false, 'reason', '未登录'); END IF;
  IF p_count IS NULL OR p_count <= 0 THEN
    RETURN json_build_object('ok', false, 'reason', '扣减数量非法');
  END IF;
  SELECT room_cards INTO v_cards FROM public.poker_profiles
   WHERE owner_id = v_uid ORDER BY id DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'reason', '档案不存在'); END IF;

  IF p_token IS NOT NULL THEN
    SELECT 1 INTO v_dup FROM public.poker_card_ledger
     WHERE owner_id = v_uid AND token = p_token LIMIT 1;
    IF v_dup IS NOT NULL THEN
      RETURN json_build_object('ok', true, 'roomCards', v_cards, 'reason', '幂等命中');
    END IF;
  END IF;

  IF v_cards < p_count THEN
    RETURN json_build_object('ok', false, 'reason', '房卡不足');
  END IF;

  v_new := v_cards - p_count;
  UPDATE public.poker_profiles SET room_cards = v_new WHERE owner_id = v_uid;
  INSERT INTO public.poker_card_ledger (owner_id, delta, reason, token, balance_after)
  VALUES (v_uid, -p_count, 'consume_room', p_token, v_new);
  RETURN json_build_object('ok', true, 'roomCards', v_new);
END;
$fn$;


-- ---------- 3. 每日领卡（2 张，服务端 current_date 定日期） ----------
-- 幂等键 daily:<current_date>：改设备时间无法绕过，同日重发不双领。
CREATE OR REPLACE FUNCTION public.poker_claim_daily()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid   text := auth.uid();
  v_token text := 'daily:' || (current_date)::text;
  v_cards integer; v_new integer;
BEGIN
  IF v_uid IS NULL THEN RETURN json_build_object('ok', false, 'reason', '未登录'); END IF;
  SELECT room_cards INTO v_cards FROM public.poker_profiles
   WHERE owner_id = v_uid ORDER BY id DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'reason', '档案不存在'); END IF;

  IF EXISTS (SELECT 1 FROM public.poker_card_ledger
             WHERE owner_id = v_uid AND token = v_token) THEN
    RETURN json_build_object('ok', true, 'gained', 0, 'roomCards', v_cards, 'reason', '今日已领取');
  END IF;

  v_new := v_cards + 2;
  UPDATE public.poker_profiles
     SET room_cards = v_new, last_checkin = (current_date)::text
   WHERE owner_id = v_uid;
  INSERT INTO public.poker_card_ledger (owner_id, delta, reason, token, balance_after)
  VALUES (v_uid, 2, 'daily', v_token, v_new);
  RETURN json_build_object('ok', true, 'gained', 2, 'roomCards', v_new);
END;
$fn$;


-- ---------- 4. 打满 10 手领 1 张（单次最多补 5 张） ----------
-- FOR UPDATE 抢占 + 基准推进：并发只有一方拿到 gained>0。
CREATE OR REPLACE FUNCTION public.poker_claim_hands()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_cards integer; v_hands integer; v_base integer;
  v_n integer; v_new integer; v_newbase integer;
BEGIN
  IF v_uid IS NULL THEN RETURN json_build_object('ok', false, 'reason', '未登录'); END IF;
  SELECT room_cards, total_hands, bonus_base INTO v_cards, v_hands, v_base
    FROM public.poker_profiles
   WHERE owner_id = v_uid ORDER BY id DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'reason', '档案不存在'); END IF;

  v_n := LEAST(5, GREATEST(0, (v_hands - v_base)) / 10);
  IF v_n <= 0 THEN
    RETURN json_build_object('ok', true, 'gained', 0, 'roomCards', v_cards,
      'reason', '还差 ' || (10 - ((v_hands - v_base) % 10)) || ' 手');
  END IF;

  v_newbase := v_base + v_n * 10;
  v_new := v_cards + v_n;
  UPDATE public.poker_profiles
     SET room_cards = v_new, bonus_base = v_newbase
   WHERE owner_id = v_uid;
  INSERT INTO public.poker_card_ledger (owner_id, delta, reason, token, balance_after)
  VALUES (v_uid, v_n, 'hand_bonus', 'hands:' || v_newbase::text, v_new);
  RETURN json_build_object('ok', true, 'gained', v_n, 'roomCards', v_new);
END;
$fn$;


-- ---------- 5. 战绩流水 + 档案累计（owner_id 由服务端填） ----------
-- p_row 不含 owner_id：客户端伪造不了归属。
-- 累计统计 total_hands/total_wins/total_net 同函数内推进 —— 列权限收口后
-- 客户端不再能直接 update 这三列，刷手数从根上死掉。
CREATE OR REPLACE FUNCTION public.poker_record_hand(p_row json)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid  text := auth.uid();
  v_rec  public.poker_records;
  v_won  boolean := COALESCE((p_row->>'won')::boolean, false);
  v_net  integer := COALESCE((p_row->>'net')::integer, 0);
BEGIN
  IF v_uid IS NULL THEN RETURN json_build_object('ok', false, 'reason', '未登录'); END IF;

  INSERT INTO public.poker_records
    (owner_id, table_id, hand_no, seat, hole_cards, board, hand_type, net, won)
  VALUES
    (v_uid, p_row->>'table_id', COALESCE((p_row->>'hand_no')::integer, 1),
     COALESCE((p_row->>'seat')::integer, 0), p_row->>'hole_cards',
     p_row->>'board', p_row->>'hand_type', v_net, v_won)
  RETURNING * INTO v_rec;

  UPDATE public.poker_profiles
     SET total_hands = total_hands + 1,
         total_wins  = total_wins + CASE WHEN v_won THEN 1 ELSE 0 END,
         total_net   = total_net + v_net
   WHERE owner_id = v_uid;

  RETURN to_json(v_rec);
END;
$fn$;


-- ---------- 6. 函数执行授权 ----------
GRANT EXECUTE ON FUNCTION public.poker_consume_room_card(integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.poker_claim_daily() TO authenticated;
GRANT EXECUTE ON FUNCTION public.poker_claim_hands() TO authenticated;
GRANT EXECUTE ON FUNCTION public.poker_record_hand(json) TO authenticated;


-- ---------- 7. 列权限收口（关键，最容易做错的一步） ----------
-- ⚠️ PostgreSQL 陷阱：**列级 REVOKE 是无效的**。
--    列级权限是「追加授权」而非「限制」——只要表级 UPDATE 还在，
--    `REVOKE UPDATE (room_cards) ...` 不会有任何效果（information_schema
--    里仍显示有 UPDATE 权限）。必须先撤表级，再按列重新授权。
REVOKE UPDATE ON public.poker_profiles FROM authenticated;
GRANT UPDATE (nickname, avatar_url) ON public.poker_profiles TO authenticated;

-- 收口后 authenticated 对 profiles 的权限矩阵：
--   SELECT        全部列（读自己的档案）
--   INSERT        全部列（ensureProfile 建档，room_cards 走 DEFAULT 12）
--   UPDATE        仅 nickname / avatar_url
--   DELETE        无
-- 房卡 / 签到 / 基准 / 累计统计四类的写入，只能经上面 4 个 rpc。


-- ============================================================
-- 验证脚本（迁移后必跑）
-- ============================================================
-- 1) 函数存在且是 SECURITY DEFINER：
--    SELECT proname, pg_get_function_identity_arguments(oid) AS args, prosecdef
--      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--     WHERE n.nspname='public' AND proname LIKE 'poker%' ORDER BY proname;
--
-- 2) 权限矩阵（profile_update_table 必须为 false）：
--    SELECT has_table_privilege('authenticated','public.poker_profiles','UPDATE') AS profile_update_table,
--           has_function_privilege('authenticated','public.poker_consume_room_card(integer,text)','EXECUTE') AS fn_consume;
--
-- 3) 列级权限只剩两列：
--    SELECT column_name FROM information_schema.column_privileges
--     WHERE table_schema='public' AND table_name='poker_profiles'
--       AND grantee='authenticated' AND privilege_type='UPDATE';
--    期望：avatar_url, nickname
--
-- 4) 冒烟（admin 上下文 auth.uid() 为 NULL，应全部返回「未登录」）：
--    SELECT public.poker_consume_room_card(1,'smoke') , public.poker_claim_daily(),
--           public.poker_claim_hands(), public.poker_record_hand('{}'::json);
