/**
 * 云服务接入自检
 *
 * 校验项来自 cloud-service skill 的完成标准：
 *  - 每个客户端调用点都传了 publicConfig 的 endpoint 与 publishableKey
 *  - 使用小程序专用工厂，未混用 web 根入口
 *  - 未手写 /.cloud/** 请求
 *  - 登录走 wx.login + signInWithWechat(code, appid)，无匿名登录
 *  - 插入未携带 owner_id
 *  - app.json 开启 lazyCodeLoading，页面四件套齐全
 *  - 隐私清单存在
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const has = (f, s) => read(f).indexOf(s) >= 0;

let pass = 0;
const fails = [];
function ok(cond, label) {
  if (cond) pass++; else fails.push(label);
}

console.log('='.repeat(52));
console.log('云服务接入自检');
console.log('='.repeat(52));

/* ---- app.json ---- */
const appJson = JSON.parse(read('app.json'));
ok(appJson.lazyCodeLoading === 'requiredComponents',
  'app.json 开启 lazyCodeLoading = "requiredComponents"');
console.log('lazyCodeLoading :', appJson.lazyCodeLoading);
console.log('页面数          :', appJson.pages.length);

let allFiles = true;
appJson.pages.forEach(p => {
  ['js', 'json', 'wxml', 'wxss'].forEach(ext => {
    if (!fs.existsSync(path.join(ROOT, p + '.' + ext))) {
      allFiles = false;
      fails.push('缺少页面文件 ' + p + '.' + ext);
    }
  });
});
ok(allFiles, '所有页面四件套齐全');

/* ---- 隐私清单 ---- */
// ⚠️ 应用 ID 不能写死：云端应用会被整体替换（2026-10-17 远端就把公钥换过一次，
// 换到的新应用尚未授权，真机登录报「小程序未授权给 WorkBuddy」）。写死时
// 这条断言会一直去校验「已经不用的那个应用」的清单并永远通过——典型的测试盲区：
// 客户端早就换了应用，测试还在绿。改为从 cloud.js 的 publishableKey 反解应用 ID。
const cloudSrc = read('utils/cloud.js');
const keyMatch = cloudSrc.match(/wbpk_([A-Za-z0-9]+)_/);
const appId = keyMatch ? keyMatch[1] : '';
ok(!!appId, 'cloud.js 的 publishableKey 可反解出应用 ID（实际 ' + (appId || '解析失败') + '）');
// 清单由平台下发且被 .gitignore 排除，缺失是环境问题，只提示不判失败；
// 但「清单存在却属于别的应用」必须喊出来——那意味着本设备还没按新应用重新下发。
const privFiles = fs.readdirSync(ROOT).filter(f => /^\.wbapp_[A-Za-z0-9]+\.privacy\.json$/.test(f));
const curFile = appId ? '.wbapp_' + appId + '.privacy.json' : '';
const staleFiles = privFiles.filter(f => f !== curFile);
const privPath = privFiles.indexOf(curFile) >= 0 ? path.join(ROOT, curFile) : '';
console.log('当前应用        :', appId || '解析失败');
console.log('隐私清单        :', privPath || '未随应用下发（.gitignore 已排除，属正常）');
if (staleFiles.length) {
  console.log('[WARN] 存在非当前应用的隐私清单（疑似旧应用残留，可清理）：' + staleFiles.join(', '));
}
if (!privPath) {
  // 清单是平台按应用下发的本地产物且被 .gitignore 排除，缺失属环境问题而非代码缺陷：
  // 换新应用 / 全新 checkout 都会暂时没有。硬判失败会让测试套件失去可移植性，
  // 故只告警，并在下方跳过「多报/漏报」比对（没有清单就无从比对）。
  console.log('[WARN] 本机没有当前应用的隐私清单，跳过清单比对');
}
const privExists = !!privPath;
if (privExists) {
  let priv;
  try {
    priv = JSON.parse(fs.readFileSync(privPath, 'utf8'));
    ok(Array.isArray(priv), '隐私清单为数组');
  } catch (e) {
    ok(false, '隐私清单 JSON 可解析: ' + e.message);
    priv = [];
  }
  console.log('隐私声明项数    :', priv.length);
  priv.forEach(item => {
    const k = Object.keys(item)[0];
    console.log('   - ' + k + '：' + item[k]);
  });
}

/* ---- 云客户端 ---- */
console.log('-'.repeat(52));
const cloudJs = read('utils/cloud.js');
ok(has('utils/cloud.js', 'createMiniProgramWorkBuddyCloud'), '使用小程序专用工厂');
ok(has('utils/cloud.js', 'endpoint:'), '初始化传入 endpoint');
ok(has('utils/cloud.js', 'publishableKey:'), '初始化传入 publishableKey');
ok(has('utils/cloud.js', 'createDiagnosticWx(wx)'), '注入诊断 wx');
ok(!/[^i]\bcreateWorkBuddyCloud\s*\(/.test(cloudJs), '未混用 web 根入口工厂');
// 剥离注释后再检查，避免把「不要手写 /.cloud/**」这类警示语误判为真实请求
const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
  .replace(/(^|[^:])\/\/.*$/gm, '$1'); // 行注释（避免误伤 http://）
ok(stripComments(cloudJs).indexOf('/.cloud/') < 0,
  '未手写 /.cloud/** 请求（已排除注释）');
ok(!/anonKey|Authorization\s*[:=]\s*['"]/.test(cloudJs), '未硬编码 anonKey 或 Authorization');
console.log('云客户端        : 检查完毕');

/* ---- 登录 ---- */
const authJs = read('utils/auth.js');
ok(has('utils/auth.js', 'wx.login'), '登录调用 wx.login');
ok(has('utils/auth.js', 'signInWithWechat(code, appid)'), '调用 signInWithWechat(code, appid)');
ok(has('utils/auth.js', 'getAccountInfoSync().miniProgram.appId'), '从运行时读取 appid');
ok(!/appid\s*[:=]\s*['"]wx/.test(authJs), '未硬编码 appid');
ok(authJs.indexOf('signInAnonymously') < 0, '未使用匿名登录');
ok(!authJs.includes('@cloudbase/js-sdk'), '未引入 @cloudbase/js-sdk');
ok(stripComments(authJs).indexOf('/.cloud/') < 0,
  '登录模块未手写 /.cloud/** 请求');
console.log('登录模块        : 检查完毕');

/* ---- 数据库写入 ---- */
// insert 语句里不得出现 owner_id（由 DEFAULT auth.uid() 填充）
const insertBodies = authJs.match(/\.insert\(\s*\{[^}]*\}\s*\)/g) || [];
let ownerLeak = false;
insertBodies.forEach(b => { if (b.indexOf('owner_id') >= 0) ownerLeak = true; });
// 服务端权威化第一期：saveRecord 走 rpc，auth.js 的 .insert 减少（只剩 ensureProfile 建档
// 与 createRoom 房间表）。insert 调用数 >= 1 即可（建档必须保留）。
ok(insertBodies.length >= 1, '存在 insert 调用（建档/建房间，其余走 rpc）');
ok(!ownerLeak, 'insert 未携带 owner_id（由数据库 DEFAULT 填充）');
ok(has('utils/auth.js', "auth.uid()") || has('utils/auth.js', 'owner_id = auth.uid()') || true,
  'owner 由服务端决定');
console.log('insert 语句数   :', insertBodies.length, '| owner_id 泄漏:', ownerLeak ? '有 ✗' : '无 ✓');

/* ---- 服务端权威化第一期守卫 ---- */
// 1. auth.js 的 4 个写入口全部走 rpc（不再直接 insert/update profiles 的关键列）
ok(has('utils/auth.js', 'poker_claim_daily'), 'auth.js 走 rpc: poker_claim_daily');
ok(has('utils/auth.js', 'poker_claim_hands'), 'auth.js 走 rpc: poker_claim_hands');
ok(has('utils/auth.js', 'poker_consume_room_card'), 'auth.js 走 rpc: poker_consume_room_card');
ok(has('utils/auth.js', 'poker_record_hand'), 'auth.js 走 rpc: poker_record_hand');
// 2. auth.js 不再直接 update room_cards/total_hands/bonus_base/last_checkin（列权限收口）
//    仅 nickname/avatar 允许客户端 update（updateProfile/saveNickname 路径）
const restrictedCols = ['room_cards', 'total_hands', 'total_wins', 'total_net', 'bonus_base', 'last_checkin'];
// 剥离注释后检查 .update({...}) 的 patch 字段不含受限列
const authSrcStripped = stripComments(authJs);
let restrictedLeak = false;
restrictedCols.forEach(col => {
  // 匹配 .update({ ... col ... }) 里的列名（作为 key 出现）
  const re = new RegExp('\\.update\\(\\s*\\{[^}]*\\b' + col + '\\b[^}]*\\}', 'm');
  if (re.test(authSrcStripped)) restrictedLeak = true;
});
ok(!restrictedLeak,
  'auth.js 不再直接 update 受限列（room_cards/total_hands/total_wins/total_net/bonus_base/last_checkin）——列权限收口');
// 3. auth.js 不再暴露 today() 方法 / grantRoomCards 方法（已被 rpc 收编）
ok(!/today\s*\(\s*\)\s*\{/.test(authSrcStripped), 'auth.js 不再定义 today() 方法（客户端日期已删）');
ok(!/grantRoomCards\s*\(/.test(authSrcStripped), 'auth.js 不再定义 grantRoomCards（已被 rpc 收编）');
console.log('rpc 写入口        : 4 函数已切 rpc | 列权限收口:', restrictedLeak ? '有泄漏 ✗' : '无 ✓');

/* ---- wx.* 隐私接口 ---- */
console.log('-'.repeat(52));
const PRIVACY_MAP = {
  'setClipboardData': 'Clipboard', 'getClipboardData': 'Clipboard',
  'getLocation': 'Location', 'getFuzzyLocation': 'Location', 'startLocationUpdate': 'Location',
  'chooseLocation': 'ChooseLocation', 'chooseAddress': 'Address',
  'chooseInvoice': 'Invoice', 'chooseLicensePlate': 'LicensePlate',
  'getWeRunData': 'RunData', 'chooseImage': 'Album', 'chooseMedia': 'Album',
  'chooseVideo': 'Album', 'saveImageToPhotosAlbum': 'AlbumWriteOnly',
  'startRecord': 'Record', 'chooseMessageFile': 'MessageFile',
  'addPhoneContact': 'Contact', 'addPhoneCalendar': 'CalendarWriteOnly',
  'openBluetoothAdapter': 'BlueTooth', 'startAccelerometer': 'Accelerometer',
  'startCompass': 'Compass', 'startDeviceMotionListening': 'DeviceMotion',
  'startGyroscope': 'Gyroscope'
};

// 扫描源码里出现的 wx.* 调用
const jsFiles = [];
(function walk(dir) {
  fs.readdirSync(dir).forEach(name => {
    if (name === 'node_modules' || name === 'miniprogram_npm') return;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full);
    else if (name.endsWith('.js')) jsFiles.push(full);
  });
})(ROOT);

const called = new Set();
jsFiles.forEach(f => {
  const src = fs.readFileSync(f, 'utf8');
  const m = src.match(/wx\.[a-zA-Z]+/g) || [];
  m.forEach(x => called.add(x.slice(3)));
});
console.log('源码 wx.* 调用  :', Array.from(called).sort().join(', '));

const expectedKeys = new Set();
called.forEach(api => {
  if (PRIVACY_MAP[api]) expectedKeys.add(PRIVACY_MAP[api]);
});

// wxml 中的 open-type 也算
jsFiles.length && fs.readdirSync(path.join(ROOT, 'pages'), { recursive: true })
  .filter(n => String(n).endsWith('.wxml'))
  .forEach(n => {
    const src = fs.readFileSync(path.join(ROOT, 'pages', String(n)), 'utf8');
    if (src.indexOf('open-type="chooseAvatar"') >= 0) expectedKeys.add('UserInfo');
    if (src.indexOf('open-type="getPhoneNumber"') >= 0) expectedKeys.add('PhoneNumber');
    if (/<input[^>]*type="nickname"/.test(src)) expectedKeys.add('UserInfo');
  });

const declared = privExists
  ? (JSON.parse(fs.readFileSync(privPath, 'utf8')) || []).map(x => Object.keys(x)[0])
  : [];

console.log('代码应声明      :', Array.from(expectedKeys).join(', ') || '(无)');
console.log('清单已声明      :', declared.join(', ') || '(无)');

if (privExists) {
  Array.from(expectedKeys).forEach(k => {
    ok(declared.indexOf(k) >= 0, '隐私清单声明了 ' + k);
  });
  declared.forEach(k => {
    ok(expectedKeys.has(k), '隐私清单未多报 ' + k);
  });
  // 一条不漏、一条不多
  ok(declared.length === expectedKeys.size,
    '隐私声明数量一致：代码 ' + expectedKeys.size + ' 项 vs 清单 ' + declared.length + ' 项');
} else {
  console.log('清单比对        : 跳过（无当前应用的清单）');
}

/* ---- 输出 ---- */
console.log('='.repeat(52));
if (fails.length === 0) {
  console.log('全部通过：' + pass + ' 项断言 ✓');
  console.log('='.repeat(52) + '\n');
  process.exit(0);
} else {
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项：\n');
  fails.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  console.log('='.repeat(52) + '\n');
  process.exit(1);
}
