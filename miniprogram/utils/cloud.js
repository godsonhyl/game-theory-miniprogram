/**
 * 云服务客户端
 *
 * ⚠️ 安全要点：
 *  - endpoint 与 publishableKey 是唯一可以放进前端代码的配置，
 *    来自 workbuddy_cloud_service 返回的 publicConfig。
 *  - 真正的环境 ID 与服务端密钥永远不下发，绝不能写进本文件。
 *  - 不要手写 wx.request 访问 /.cloud/** —— 那会绕过凭证注入与会话管理。
 */
const { createMiniProgramWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk/miniprogram');
const { createDiagnosticWx } = require('./workbuddy-cloud-diagnostics');

// ↓↓↓ 云服务开通后由平台下发，请勿手工修改或提交到公开仓库 ↓↓↓
const PUBLIC_CONFIG = {
  endpoint: 'https://mp-api.app.workbuddy.host',
  publishableKey: 'wbpk_2qkKI2ZGSh13zUKRFfD8Cm_72rqo2gDsN0YTv64Kn69YK7miDGvZLFT'
};
// ↑↑↑ ↑↑↑

const cloud = createMiniProgramWorkBuddyCloud({
  endpoint: PUBLIC_CONFIG.endpoint,
  publishableKey: PUBLIC_CONFIG.publishableKey,
  wx: createDiagnosticWx(wx)
});

module.exports = { cloud, PUBLIC_CONFIG };
