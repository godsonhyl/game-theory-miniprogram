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
  publishableKey: 'wbpk_qcAtDwEIzbnS2Bjm1i0ylw_b5AmIjzcKc5jQPnyHJfwpfV4dGG11IPP'
};
// ↑↑↑ ↑↑↑

const cloud = createMiniProgramWorkBuddyCloud({
  endpoint: PUBLIC_CONFIG.endpoint,
  publishableKey: PUBLIC_CONFIG.publishableKey,
  wx: createDiagnosticWx(wx)
});

module.exports = { cloud, PUBLIC_CONFIG };
