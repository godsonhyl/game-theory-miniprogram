/**
 * 打包/上传排除清单 —— 单一来源
 *
 * 背景（评审 2026-10-15 MEDIUM）：排除清单曾在三处各写一份（pack.js / upload.js /
 * project.config.json），修复「upload.js 误排除 miniprogram_npm」时另外两处没跟上，
 * 造成体验版白屏、测试文件 49KB 进包。本模块是唯一事实来源：
 *
 *   消费方                                    形态
 *   pack.js collect()      →  shouldExclude(name)（精确名/前缀/模式，文件目录通用）
 *   upload.js ci.Project    →  ciIgnores()（miniprogram-ci glob 风格）
 *   project.config.json     →  devtoolsIgnores()（开发者工具 JSON）
 *
 * project.config.json 是静态 JSON，没法 require 本模块——所以用
 * scripts/check-pack-rules.js 定期校验它没和单一来源漂移（纳进 npm test）。
 * 改动清单：只改这里 + 跑 npm test（校验脚本会拦住忘了同步 project.config.json 的情况）。
 */
module.exports = {
  /** 单独登记的测试文件（除外的 test-* 由前缀兜底；显式列出是为了 project.config.json
   *  开发者工具不支持通配，必须逐个写。新增测试文件会被 check-pack-rules.js 逼着登记。） */
  TEST_FILES: [
    'test-cards.js',
    'test-cloud-integration.js',
    'test-index-logic.js',
    'test-miniprogram-logic.js',
    'test-room-sync.js'
  ],
  /** 不进包的开发文件（精确文件名） */
  EXCLUDE_FILES: [
    'README-体验版上传.md',
    'package.json',
    'package-lock.json'
  ],
  /** 不进包的开发目录（精确目录名；pack.js 中整棵子树跳过，ci 里以 dir/** 表达） */
  EXCLUDE_FOLDERS: [
    'node_modules',
    'dist'
  ],
  /** 前缀兜底：新加的 test-xxx.js 漏登记也不进包（ci 用 test-*.js 通配） */
  EXCLUDE_PREFIX: ['test-'],
  /** 防误打包密钥/隐私文件（.wbapp_*.privacy.json 是云平台本地标识，外部包不需要） */
  SECRET_PATTERNS: [/\.key$/i, /\.pem$/i, /^private\./, /^\.wbapp_.*\.privacy\.json$/],

  /** pack.js 用：该名字（文件或目录）是否应排除 */
  shouldExclude(name) {
    const files = this.TEST_FILES.concat(this.EXCLUDE_FILES);
    const folders = this.EXCLUDE_FOLDERS;
    return files.indexOf(name) >= 0
      || folders.indexOf(name) >= 0
      || this.EXCLUDE_PREFIX.some(p => name.startsWith(p))
      || this.SECRET_PATTERNS.some(re => re.test(name));
  },

  /** upload.js 用：miniprogram-ci 的 ignores（glob 风格，相对 projectPath）
   *  ⚠️ 云 SDK 产物绝不能被排除。早期它以 npm 依赖形式存在（微信「构建 npm」生成
   *  miniprogram_npm/），排除该目录会令体验版 require 失败白屏（历史事故）。
   *  2026-10-17 起改为内联在 miniprogram/utils/vendor/workbuddy-cloud-sdk.js——
   *  彻底去掉「构建 npm」环节，换机器 clone 后无需 npm install 即可上传。
   *  风险点随之从「别排除 miniprogram_npm 目录」变成「别排除 utils/vendor 这个文件」；
   *  本清单不含二者（EXCLUDE_FOLDERS 只有 node_modules/dist），改动时务必守住。 */
  ciIgnores() {
    return this.EXCLUDE_FILES
      .concat(this.EXCLUDE_PREFIX.map(p => p + '*.js'))   // test-*.js
      .concat(['node_modules/**']);   // dist 在仓库根而非 miniprogram/ 内，ci 无需处理
  },

  /** project.config.json 用：开发者工具 packOptions.ignore（不支持通配，逐个登记），
   *  check-pack-rules.js 会校验 JSON 实际内容与此完全一致。 */
  devtoolsIgnores() {
    const files = ['README-体验版上传.md']
      .concat(this.TEST_FILES)
      .concat(['package.json', 'package-lock.json'])
      .map(v => ({ type: 'file', value: v }));
    const folders = this.EXCLUDE_FOLDERS.map(v => ({ type: 'folder', value: v }));
    return files.concat(folders);
  }
};
