/**
 * 登录与用户数据
 *
 * 登录链路（小程序）：
 *   wx.login → 拿到 code → signInWithWechat(code, appid) → 换取云服务会话
 *
 * ⚠️ 合规与安全：
 *  - 客户端不接触 AppSecret，也不自行实现 jscode2session。
 *  - 不做匿名登录、不做本地假身份 —— 用户数据必须有真实身份才可访问。
 *  - 数据库的 owner_id 由服务端 auth.uid() 决定，客户端伪造不了。
 */
const { cloud } = require('./cloud');

/** 表结构对应的字段名（与建表 DDL 一致） */
const T = {
  profile: 'poker_profiles',
  record: 'poker_records',
  room: 'poker_rooms'
};

/**
 * 房卡获取规则（体验版：只发免费卡，不做任何货币化）
 *  - daily：每日领取张数
 *  - handsPerCard：累计多少手领 1 张
 *  - bonusCap：单次领取上限
 * 商业化版本的服务端发放与防刷蓝本见 docs/服务端化蓝图.md，这里仅演示。
 */
const CARD_RULES = {
  daily: 2,
  handsPerCard: 10,
  bonusCap: 5
};

/** 不限时房间存活上限：24 小时（与本地续局快照 TTL 一致） */
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 昵称相关常量
 *  - DEFAULT_NICK：建档时的占位名。它同时是「用户还没设过昵称」的判据，
 *    各处据此决定是否引导用户去设置，改动这两个值要保持同步。
 *  - NICK_MAX：微信昵称本身最长 32 字节，取 16 可容纳纯汉字，同时保证牌桌
 *    名牌（一行文本）不溢出。
 */
const DEFAULT_NICK = '玩家';
const NICK_MAX = 16;

const auth = {
  /**
   * 微信静默登录
   * @returns {Promise<{user, profile}>}
   */
  login() {
    return new Promise((resolve, reject) => {
      wx.login({
        success: async ({ code }) => {
          try {
            // 必须传当前运行时的 appid，不能硬编码，也不能用 wbapp_ 开头的应用 ID
            const appid = wx.getAccountInfoSync().miniProgram.appId;
            const { data, error } = await cloud.auth.signInWithWechat(code, appid);

            if (error) {
              console.error('[auth] 微信登录失败', JSON.stringify({
                stage: 'wechat-login-handler',
                message: error.message || '登录失败'
              }));
              reject(new Error(error.message || '微信登录失败'));
              return;
            }

            // 登录成功后读取（或初始化）玩家档案
            const profile = await this.ensureProfile();
            resolve({ user: data.user, profile });
          } catch (err) {
            console.error('[auth] 登录处理异常', JSON.stringify({
              stage: 'wechat-login-handler',
              message: err && err.message ? err.message : '登录失败，请重试'
            }));
            reject(err);
          }
        },
        fail: err => {
          console.error('[auth] wx.login 失败', JSON.stringify({
            stage: 'wx.login',
            message: err.errMsg
          }));
          reject(new Error(err.errMsg || '微信登录失败'));
        }
      });
    });
  },

  /** 读取当前玩家档案；不存在则创建（房卡初始 12 张） */
  async ensureProfile() {
    const { data, error } = await cloud.database
      .from(T.profile)
      .select('*')
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(error.message || '读取用户信息失败');
    if (data) return data;

    // 首次登录：建档。owner_id 交给数据库 DEFAULT auth.uid() 填，客户端不传。
    // 昵称留占位值，等用户在「我的」页用 <input type="nickname"> 设一次。
    const created = await cloud.database
      .from(T.profile)
      .insert({ nickname: DEFAULT_NICK })
      .select()
      .single();

    if (created.error) {
      // 并发首次登录可能撞唯一约束，回读一次即可
      const retry = await cloud.database.from(T.profile).select('*').limit(1).maybeSingle();
      if (retry.data) return retry.data;
      throw new Error(created.error.message || '创建用户档案失败');
    }
    return created.data;
  },

  /** 更新昵称头像 */
  async updateProfile(patch) {
    const profile = await this.ensureProfile();
    const { data, error } = await cloud.database
      .from(T.profile)
      .update(patch)
      .eq('id', profile.id)
      .select();

    if (error) throw new Error(error.message || '更新失败');
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('没有改动任何数据，该资料可能不存在或不属于你');
    }
    return data[0];
  },

  // ---------- 昵称 ----------
  /**
   * 我的牌桌显示名：优先玩家档案里的昵称，没设过才回落 fallback。
   *
   * ⚠️ 微信拿不到真实昵称：wx.getUserProfile / getUserInfo 早已回收，返回的
   * 是「微信用户」这类占位值。目前唯一合规且能拿到真名的是头像昵称填写能力
   * —— <input type="nickname">，由用户点一下、再用微信弹出的「用微信昵称」
   * 一键填入。所以昵称必须由玩家自己设一次并落进 poker_profiles.nickname，
   * 别指望登录链路静默带回来。
   */
  myName(fallback) {
    try {
      const p = getApp().globalData.profile;
      const n = p && p.nickname;
      if (n && n !== DEFAULT_NICK) return n;
    } catch (e) { /* globalData 未就绪：用兜底名，不阻断渲染 */ }
    return fallback || DEFAULT_NICK;
  },

  /** 昵称是否还是建档时的占位值（用于决定是否引导用户去设置） */
  isDefaultNickname(nick) {
    return !nick || String(nick).trim() === '' || String(nick).trim() === DEFAULT_NICK;
  },

  /**
   * 保存昵称：去空白 → 长度校验 → 落库。失败抛错，由调用方 toast。
   * @returns {Promise<object>} 更新后的档案行
   */
  async saveNickname(nick) {
    const v = String(nick == null ? '' : nick).trim().replace(/\s+/g, ' ');
    if (!v) throw new Error('昵称不能为空');
    if (v.length > NICK_MAX) throw new Error('昵称最多 ' + NICK_MAX + ' 个字');
    const row = await this.updateProfile({ nickname: v });
    try {
      const g = getApp().globalData;
      g.profile = Object.assign({}, g.profile, { nickname: v });
    } catch (e) { /* 非致命：档案已在库，下次登录自然同步 */ }
    return row;
  },

  /**
   * 消耗房卡（创建房间时调用）
   *
   * 服务端权威化第一期：改为 rpc 调用 `poker_consume_room_card`，余额校验 +
   * 扣减 + 流水在同一事务内完成，凭 p_token 做幂等（同 token 重发不二次扣）。
   * 列权限收口后客户端不再直接 update room_cards。
   *
   * @param {number} count 扣减数量
   * @param {string} [token] 幂等凭据（如建房 room_no）；不传则自动生成
   * @returns {Promise<{ok:boolean, roomCards?:number, reason?:string}>}
   */
  async consumeRoomCard(count = 1, token) {
    const pToken = token || ('rc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    const { data, error } = await cloud.database.rpc('poker_consume_room_card', {
      p_count: count,
      p_token: pToken
    });
    if (error) throw new Error(error.message || '扣除房卡失败');
    return data || { ok: false, reason: '扣除房卡失败' };
  },

  /**
   * 每日领取：每天 2 张（last_checkin 记录领取日期，同一天只发一次）
   *
   * 服务端权威化第一期：改为 rpc 调用 `poker_claim_daily`，签到日期由服务端
   * current_date 决定（客户端不传敏感日期），流水 + 发卡 + 置 last_checkin
   * 在同一事务内完成，唯一约束 (owner_id, day) 做幂等——同日重发不双领。
   * 列权限收口后客户端不再直接 update room_cards/last_checkin。
   *
   * @returns {Promise<{ok:boolean, gained?:number, roomCards?:number, reason?:string}>}
   */
  async claimDailyCards() {
    const { data, error } = await cloud.database.rpc('poker_claim_daily', {});
    if (error) throw new Error(error.message || '领取失败，请重试');
    return data || { ok: false, reason: '领取失败' };
  },

  /**
   * 对局奖励：累计打满 N 手领 1 张（bonus_base 是已奖励过的手数基准）
   * 单次最多补 5 张，避免长时间不领时一次性刷出过量房卡。
   *
   * 服务端权威化第一期：改为 rpc 调用 `poker_claim_hands`，FOR UPDATE 抢占 +
   * 基准推进 + 发卡 + 流水在同一事务内完成，并发只有一方 gained>0。
   * 列权限收口后客户端不再直接 update bonus_base/room_cards。
   *
   * @returns {Promise<{ok:boolean, gained?:number, roomCards?:number, reason?:string}>}
   */
  async claimHandBonus() {
    const { data, error } = await cloud.database.rpc('poker_claim_hands', {});
    if (error) throw new Error(error.message || '领取失败，请重试');
    return data || { ok: false, reason: '领取失败' };
  },

  /**
   * 可领状态（只读，不写库）：供首页展示「今日可领 / 可领 N 张 / 还差 M 手」
   *
   * 服务端权威化第一期：dailyReady 不再用已删除的 today() 判定（改设备时间
   * 可绕——是缺陷），改为读 profile.last_checkin（由服务端 rpc 写入）是否与
   * 当前客户端日期不同。由于客户端无服务端日期，dailyReady 退化为「乐观展示」
   * ——真正资格由 claimDailyCards 的 rpc 幂等决定，点击已领则服务端返回
   * reason='今日已领取'，UI 据此刷新。这消除了「改设备时间无限领」的缺陷：
   * 即使客户端日期被改，rpc 内部用 current_date 做幂等键，同一天不会双发。
   */
  claimStatus(profile) {
    const hands = (profile && profile.total_hands) || 0;
    const base = (profile && profile.bonus_base) || 0;
    const diff = Math.max(0, hands - base);
    // dailyReady 用客户端日期做「乐观展示」——真正资格由 rpc 幂等决定
    const todayStr = (() => {
      const d = new Date();
      const p = n => (n < 10 ? '0' : '') + n;
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    })();
    return {
      dailyReady: ((profile && profile.last_checkin) || '') !== todayStr,
      dailyCount: CARD_RULES.daily,
      handCards: Math.min(CARD_RULES.bonusCap, Math.floor(diff / CARD_RULES.handsPerCard)),
      handsPerCard: CARD_RULES.handsPerCard,
      handsToNext: CARD_RULES.handsPerCard - (diff % CARD_RULES.handsPerCard)
    };
  },

  /**
   * 写入一条对局战绩，并同步累计统计
   *
   * 服务端权威化第一期：改为 rpc 调用 `poker_record_hand`，战绩流水 insert +
   * 档案累计统计（total_hands/total_wins/total_net）在同一函数内完成。
   * p_row 不含 owner_id（由服务端 auth.uid() 填），列权限收口后客户端不再
   * 能直接 update poker_profiles 的累计列——刷手数从根上死掉。
   * @returns {Promise<object>} 插入的战绩行
   */
  async saveRecord(rec) {
    const p_row = {
      table_id: rec.tableId || 'ai',
      hand_no: rec.handNo || 1,
      seat: rec.seat || 0,
      hole_cards: rec.hole || '',
      board: rec.board || '',
      hand_type: rec.handType || '',
      net: rec.net || 0,
      won: !!rec.won
    };

    const { data, error } = await cloud.database.rpc('poker_record_hand', { p_row });
    if (error) throw new Error(error.message || '保存战绩失败');
    return data;
  },

  /**
   * 读取历史战绩（当前用户）。支持游标分页：传 cursor（上一页最后一条的 created_at）
   * 与 limit，返回该游标之前的 limit 条（按 created_at 倒序）。不传 cursor 从最新开始。
   * 用 created_at 游标而非数字 offset，避免深翻页时随页数增长的性能退化。
   */
  async listRecords(limit = 20, cursor) {
    let q = cloud.database
      .from(T.record)
      .select('*')
      .order('created_at', { ascending: false });
    if (cursor) q = q.lt('created_at', cursor);
    const { data, error } = await q.limit(limit);

    if (error) throw new Error(error.message || '读取战绩失败');
    return data || [];
  },

  /**
   * 创建房间，返回房间号
   * @param {string} mode 'friend'
   * @param {number} maxPlayers 限定人数 2~6
   * @param {number} durationMin 游戏时长（分钟），0 = 不限时
   */
  async createRoom(mode = 'friend', maxPlayers = 6, durationMin = 0) {
    // 房间号唯一，重试几次以避开极小概率的碰撞
    for (let i = 0; i < 5; i++) {
      const roomNo = String(Math.floor(100000 + Math.random() * 900000));
      const { data, error } = await cloud.database
        .from(T.room)
        .insert({
          room_no: roomNo,
          mode,
          max_players: maxPlayers,
          duration_min: durationMin || 0
        })
        .select()
        .single();

      if (!error) return data;
      if (error.code !== '23505') throw new Error(error.message || '创建房间失败');
    }
    throw new Error('房间号生成失败，请重试');
  },

  /** 关闭房间（建房成功但扣卡失败时的回滚） */
  async closeRoom(roomNo) {
    const { error } = await cloud.database
      .from(T.room)
      .update({ status: 'closed' })
      .eq('room_no', roomNo);
    if (error) throw new Error(error.message || '关闭房间失败');
  },

  /** 按房间号查房间（房间对所有登录用户可读，便于好友加入） */
  async findRoom(roomNo) {
    const { data, error } = await cloud.database
      .from(T.room)
      .select('*')
      .eq('room_no', roomNo)
      .eq('status', 'active')
      .maybeSingle();

    if (error) throw new Error(error.message || '查询房间失败');
    return data;
  },

  /** 读取「我创建的」仍在进行的房间（首页"我的房间"用） */
  async listMyRooms(limit = 20) {
    const profile = await this.ensureProfile();
    const uid = profile && profile.owner_id;
    let q = cloud.database
      .from(T.room)
      .select('*')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (uid) q = q.eq('owner_id', uid);
    const { data, error } = await q;
    if (error) throw new Error(error.message || '读取房间失败');
    return data || [];
  },

  /**
   * 房间是否已过期（首页加载列表时据此自动关闭僵尸房）。
   * 云端没有活动时间字段，规则只能基于 created_at：
   *  - 限时房（duration_min > 0）：创建时间 + 时长一到即过期（倒计时结束自动收局）；
   *  - 不限时房：24 小时后过期（与本地续局快照 ROOM_SNAP_TTL 一致）。
   */
  roomExpired(r, now) {
    if (!r || !r.created_at) return false;
    const t = new Date(r.created_at).getTime();
    if (isNaN(t)) return false;
    const dur = (Number(r.duration_min) || 0) * 60 * 1000;
    return now >= t + (dur || ROOM_TTL_MS);
  },

  /** 当前会话（用于鉴权门禁） */
  async getSession() {
    return cloud.auth.getSession();
  },

  signOut() {
    return cloud.auth.signOut();
  }
};

module.exports = { auth, TABLES: T, DEFAULT_NICK, NICK_MAX };
