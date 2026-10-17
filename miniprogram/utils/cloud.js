/**
 * 云服务客户端
 *
 * ⚠️ 安全要点：
 *  - endpoint 与 publishableKey 是唯一可以放进前端代码的配置，
 *    来自 workbuddy_cloud_service 返回的 publicConfig。
 *  - 真正的环境 ID 与服务端密钥永远不下发，绝不能写进本文件。
 *  - 不要手写 wx.request 访问 /.cloud/** —— 那会绕过凭证注入与会话管理。
 */
// 云 SDK 以「构建产物内联」方式随源码分发（utils/vendor/workbuddy-cloud-sdk.js）。
// 不再走 npm 依赖 + 微信「构建 npm」：node_modules 不进版本库，换台机器拉代码
// 后上传会因依赖缺失导致「小程序依赖构建失败」（真机反馈 2026-10-17）。
// 内联后 require 走相对路径，任何机器 clone 即可构建发布，无需 npm install。
const { createMiniProgramWorkBuddyCloud } = require('./vendor/workbuddy-cloud-sdk');
const { createDiagnosticWx } = require('./workbuddy-cloud-diagnostics');

// ↓↓↓ 云服务开通后由平台下发，请勿手工修改或提交到公开仓库 ↓↓↓
const PUBLIC_CONFIG = {
  endpoint: 'https://mp-api.app.workbuddy.host',
  // ⚠️ 2026-10-17 临时回退到 wbapp_2qkKI2ZGSh13zUKRFfD8Cm（旧应用，已授权且有
  // 历史数据：档案 7 / 战绩 908 / 房间 54 / 座位 79 / 流水 8）。
  // 原因：远端 5c41c45 切到 wbapp_qcAtDwEIzbnS2Bjm1i0ylw，但该应用**只注册在
  // 创建它的那台设备的工作区**，本机 cloud_service 查不到（activate/reuse →
  // reuse_not_found），本机管不到它；真机登录报「小程序未授权给 WorkBuddy」
  // （服务端 /v1/login-wechat 返回，非本地文案），授权须回原设备做。
  // 新应用 5 表全 0 行，切回旧应用零数据损失。
  // 待授权完成后可切回新应用，届时须在新应用上重跑 migrations 与 rpc 核对。
  publishableKey: 'wbpk_2qkKI2ZGSh13zUKRFfD8Cm_72rqo2gDsN0YTv64Kn69YK7miDGvZLFT'
};
// ↑↑↑ ↑↑↑

const cloud = createMiniProgramWorkBuddyCloud({
  endpoint: PUBLIC_CONFIG.endpoint,
  publishableKey: PUBLIC_CONFIG.publishableKey,
  wx: createDiagnosticWx(wx)
});

module.exports = { cloud, PUBLIC_CONFIG };
