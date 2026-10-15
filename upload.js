/**
 * 小程序上传脚本（miniprogram-ci）
 *
 * 用途：不打开微信开发者工具，直接命令行上传代码并生成体验版。
 * 适合 CI/CD：git push → 跑单测 → 上传体验版。
 *
 * 前置准备（一次性）：
 *   1. 微信公众平台 →「管理」→「开发管理」→「开发设置」
 *      → 生成并下载「小程序代码上传密钥」（private.xxx.key）
 *   2. 记下 AppID
 *   3. 把密钥放到本目录，命名 private.<AppID>.key
 *      （此文件等同密码，务必 .gitignore）
 *   4. 把 AppID 填入下方 CONFIG.appId
 *
 * 用法：
 *   node upload.js              # 上传体验版
 *   node upload.js --preview    # 仅预览包，不上传
 */
const path = require('path');
const fs = require('fs');
const RULES = require('./scripts/pack-rules');

// ============ 配置 ============
const CONFIG = {
  appId: 'touristappid',                 // ← 替换为你的 AppID
  projectPath: path.join(__dirname, 'miniprogram'),
  version: '0.1.0',
  desc: '体验版：好友房+AI对战，含边池与牌力分析',
  // 机器人编号 1~30，用于并发上传隔离（同一机器人不可并发）
  robot: 1
};

// ============ 校验 ============
function checkConfig() {
  const errors = [];

  if (!CONFIG.appId || CONFIG.appId === 'touristappid') {
    errors.push('CONFIG.appId 未配置：请先在微信公众平台获取 AppID');
  }

  if (!fs.existsSync(CONFIG.projectPath)) {
    errors.push('项目目录不存在：' + CONFIG.projectPath);
  }

  const appJson = path.join(CONFIG.projectPath, 'app.json');
  if (!fs.existsSync(appJson)) {
    errors.push('未找到 app.json：请确认 projectPath 指向 miniprogram 目录');
  }

  const keyPath = path.join(__dirname, 'private.' + CONFIG.appId + '.key');
  if (!fs.existsSync(keyPath)) {
    errors.push('未找到上传密钥：' + path.basename(keyPath) +
      '\n       请从「小程序代码上传密钥」下载并放到本目录');
  }

  return { errors, keyPath };
}

/** 包体积预检（主包 2MB / 总包 20MB） */
function checkSize() {
  const LIMIT_MAIN = 2 * 1024 * 1024;
  let total = 0;
  const walk = dir => {
    fs.readdirSync(dir).forEach(name => {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else total += st.size;
    });
  };
  walk(CONFIG.projectPath);
  return { total, LIMIT_MAIN, ok: total < LIMIT_MAIN };
}

async function main() {
  console.log('='.repeat(54));
  console.log('博弈论 · 上传体验版');
  console.log('='.repeat(54));

  const { errors, keyPath } = checkConfig();
  const size = checkSize();

  console.log('AppID   : ' + CONFIG.appId);
  console.log('项目目录: ' + CONFIG.projectPath);
  console.log('版本号  : ' + CONFIG.version);
  console.log('包体积  : ' + (size.total / 1024).toFixed(1) + ' KB' +
    (size.ok ? '（符合 2MB 限制）' : ' ⚠️ 超出 2MB 限制'));
  console.log('-'.repeat(54));

  if (errors.length) {
    console.log('\n配置检查未通过：\n');
    errors.forEach((e, i) => console.log('  ' + (i + 1) + '. ' + e));
    console.log('\n提示：未配置完整时，可改用「微信开发者工具」图形界面上传，');
    console.log('      无需任何密钥。详见 miniprogram/README-体验版上传.md');
    console.log('='.repeat(54) + '\n');
    process.exit(1);
  }

  let ci;
  try {
    ci = require('miniprogram-ci');
  } catch (e) {
    console.log('\n未安装 miniprogram-ci，请先执行：');
    console.log('  npm install miniprogram-ci --save-dev');
    console.log('='.repeat(54) + '\n');
    process.exit(1);
  }

  const project = new ci.Project({
    appid: CONFIG.appId,
    type: 'miniProgram',
    projectPath: CONFIG.projectPath,
    privateKeyPath: keyPath,
    // 排除清单单一来源：scripts/pack-rules.js（pack.js / project.config.json 共用，
    // check-pack-rules.js 校验无漂移）。
    // node_modules 不进包（体积红线），但 miniprogram_npm 是「构建 npm」的编译产物，
    // 云 SDK 运行时靠它解析 —— 排除它会导致体验版 require 失败、白屏（历史事故，勿再排除）。
    ignores: RULES.ciIgnores()
  });

  if (process.argv.includes('--preview')) {
    await ci.preview({
      project,
      desc: CONFIG.desc,
      robot: CONFIG.robot,
      outputPath: path.join(__dirname, 'preview')
    });
    console.log('\n预览包已生成：' + path.join(__dirname, 'preview'));
    console.log('用开发者工具「导入项目」打开该目录即可本地预览。');
    console.log('='.repeat(54) + '\n');
    return;
  }

  const ciRes = await ci.upload({
    project,
    version: CONFIG.version,
    desc: CONFIG.desc,
    robot: CONFIG.robot,
    onProgressUpdate: info => {
      if (info && info.percent) process.stdout.write('\r  上传中 ' + info.percent + '%');
    }
  });

  console.log('\r上传完成！' + ' '.repeat(20));
  console.log('\n下一步：');
  console.log('  1. 登录 https://mp.weixin.qq.com');
  console.log('  2. 「管理」→「版本管理」，找到 ' + CONFIG.version);
  console.log('  3. 点「设为体验版」');
  console.log('  4. 「成员管理」→ 添加体验者微信号');
  console.log('  5. 把体验版二维码发给体验者');
  console.log('='.repeat(54) + '\n');
}

main().catch(err => {
  console.error('\n上传失败：', err && err.message ? err.message : err);
  console.log('\n常见原因：');
  console.log('  - 密钥与 AppID 不匹配，或不是「小程序代码上传密钥」');
  console.log('  - IP 未加入白名单（后台 → 开发管理 → IP 白名单）');
  console.log('  - 项目包体积超限');
  console.log('='.repeat(54) + '\n');
  process.exit(1);
});
