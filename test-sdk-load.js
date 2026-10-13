/**
 * 验证云 SDK 的小程序子路径可正常加载
 * （只验证模块解析与导出形状，不发起真实网络请求）
 */
const SDK = '@tencent-ai/workbuddy-cloud-sdk/miniprogram';
let pass = 0;
const fails = [];
function ok(c, l) { if (c) pass++; else fails.push(l); }

const m = require(SDK);

ok(typeof m.createMiniProgramWorkBuddyCloud === 'function',
  '/miniprogram 导出 createMiniProgramWorkBuddyCloud 工厂函数');
ok(m.createWorkBuddyCloud === undefined,
  '小程序子路径不暴露 web 根入口工厂（应改用 /miniprogram）');

// 用 mock 的 wx 构造客户端，验证初始化能走通
const calls = [];
const mockWx = {
  request: (opts) => { calls.push(opts); return { abort() {}, onHeadersReceived() {} }; },
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  login: (o) => o.success({ code: 'mock' }),
  getAccountInfoSync: () => ({ miniProgram: { appId: 'wxmock0000000000' } }),
  getSystemInfoSync: () => ({ platform: 'devtools', SDKVersion: '3.5.5' })
};

let client = null;
let initErr = null;
try {
  client = m.createMiniProgramWorkBuddyCloud({
    endpoint: 'https://mp-api.app.workbuddy.host',
    publishableKey: 'wbpk_test_key',
    wx: mockWx
  });
} catch (e) {
  initErr = e;
}

ok(initErr === null, '客户端可初始化：' + (initErr ? initErr.message : 'OK'));
ok(client !== null, '返回客户端实例');

if (client) {
  ['auth', 'database', 'storage', 'llm'].forEach(mod => {
    ok(client[mod] && typeof client[mod] === 'object',
      '客户端提供 ' + mod + ' 模块');
  });
  ok(typeof client.auth.signInWithWechat === 'function',
    'auth 提供 signInWithWechat');
  ok(typeof client.auth.getSession === 'function',
    'auth 提供 getSession');
  ok(typeof client.database.from === 'function',
    'database 提供 from()');
}

// 缺 endpoint 必须初始化失败（不能静默回退到同源）
let badErr = null;
try {
  m.createMiniProgramWorkBuddyCloud({ publishableKey: 'k', wx: mockWx });
} catch (e) { badErr = e; }
ok(badErr !== null,
  '缺少 endpoint 时初始化报错，不做同源回退（小程序无 location.origin）');

console.log('='.repeat(50));
if (fails.length === 0) {
  console.log('云 SDK 接入校验：全部通过 ' + pass + ' 项 ✓');
  console.log('='.repeat(50) + '\n');
  process.exit(0);
} else {
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项：');
  fails.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  console.log('='.repeat(50) + '\n');
  process.exit(1);
}
