# Shared Ledger 共享账本

一个移动端优先的渐进式 Web 应用（PWA），支持多人共享记账、月度对比、年度总结、消费人格、成就徽章、愿望清单和心情记账。支持定期收支自动记账、个性化分类图标、高级搜索与筛选、Excel 导出、消费地图热力图。

## 在线体验

🔗 https://xingleihuang850-lang.github.io/shared-ledger/

## 功能特性

- 📱 **PWA 可安装**：添加到手机主屏幕即可像原生 App 一样使用，离线可用
- 🔄 **自动更新**：联网打开时自动获取最新版，离线时继续使用最近缓存版本
- 👥 **多人共享**：一键切换用户，各自独立记账
- 📝 **收支记录**：金额、分类、日期、备注、心情标签
- 📊 **统计图表**：月度支出分布饼图 + 年度收支趋势折线图
- 💡 **月度对比**：比上月花少了鼓励，花多了自动分析 TOP3 超支分类
- 📅 **年度总结**：年收入/支出/结余、存储率、支出 TOP3、最佳/最差月份
- 🎭 **消费人格**：根据支出分布生成趣味人设
- 🏆 **成就徽章**：8 枚徽章自动解锁，游戏化激励记账
- 🎯 **愿望清单**：设定储蓄目标，自动跟踪进度
- 😊 **心情记账**：为每笔消费添加心情，回顾消费情绪
- 🌓 **暗黑模式**：一键切换，偏好自动保存
- 📂 **CSV 账单导入**：支持支付宝 / 微信 CSV 账单一键导入（自动去重 + 分类识别）
- ☁️ **跨设备同步**：通过 GitHub Gist 将数据备份到你的私有仓库（明文 JSON），多设备同步
- 💾 **JSON 数据导入导出**：随时备份与恢复全量数据
- 🛟 **安全恢复**：导入、云端下载和清空前自动保留恢复点，整库写入失败时自动回滚
- 🧩 **备份兼容**：备份格式带版本号，旧版数据自动迁移，未知新版会被安全拒绝
- 🛡️ **同步冲突保护**：发现另一台设备已更新时先保留副本，再由用户决定是否覆盖
- 📊 **Excel 导出**：一键生成包含「账单明细」+「月度汇总」两个 Sheet 的 .xlsx 文件
- 📅 **定期收支自动记账**：设置每日 / 每周 / 每月重复项（房租/工资/订阅），打开 App 自动补录逾期记录
- 🎨 **分类个性化图标**：每个分类可绑定自定义图片（URL 或从相册上传，自动压缩 64×64）
- 🔍 **高级搜索与筛选**：跨月搜索，支持关键词、分类、金额范围、日期范围多维度过滤
- 🗺️ **消费地图热力图**：记账时一键 GPS 定位，地图页展示二维热力图 + 位置列表（OpenStreetMap 免费，无需 API Key）

## 技术栈

- 原生 HTML5 + CSS3 + JavaScript（无框架、无构建工具，浏览器直接运行）
- IndexedDB 本地持久化（7 个业务 Store + 1 个自动恢复快照 Store）
- Chart.js 4.4 图表（`defer` 加载，不阻塞首屏）
- SheetJS 0.18 Excel 导出（含月度汇总 Sheet）
- Leaflet 1.9 + leaflet.heat 消费地图热力图（OpenStreetMap，免费无需 Key）
- Service Worker + Manifest 实现 PWA 安装与离线可用
- Android Trusted Web Activity（TWA）提供正式签名 APK，继续使用同一 PWA 数据与更新机制

## 文件结构

```
shared-ledger/
├── index.html   # HTML 骨架（~200 行，只含结构）
├── app.css      # 全部样式（主题变量 + 组件 CSS）
├── app.js       # 全部业务逻辑（IndexedDB / 渲染 / 同步）
├── sw.js        # Service Worker（离线缓存）
├── manifest.json
├── PRIVACY.md   # 隐私与外部数据传输说明
├── LICENSE      # MIT 开源许可证
├── tests/       # 静态检查与浏览器端回归测试
├── android/     # Android TWA 工程（正式签名 APK）
├── playwright.config.js
├── package.json
├── package-lock.json
├── .github/workflows/ci.yml
├── .github/workflows/android-release.yml
└── README.md
```

## 本地运行

```bash
git clone https://github.com/xingleihuang850-lang/shared-ledger.git
cd shared-ledger
# 任意静态服务器，例如
python3 -m http.server 8080
```

然后打开 http://localhost:8080 即可。

## 安装到手机

- **Android PWA**：使用支持 PWA 安装的浏览器打开在线地址，点击应用内“设置 → 安装到手机”，或在浏览器菜单中选择“安装应用”。
- **Android APK（Android 6.0 及以上）**：前往 [GitHub Releases](https://github.com/xingleihuang850-lang/shared-ledger/releases/latest) 下载 `shared-ledger-android-v*.apk`。首次侧载时，Android 可能要求允许当前浏览器或文件管理器“安装未知应用”。
- **iPhone / iPad**：使用 Safari 打开在线地址，点击“分享 → 添加到主屏幕”。

PWA 与 APK 使用同一在线应用和 IndexedDB 本地数据。网页功能更新会在联网启动时通过 Service Worker 自动获取；涉及 Android 原生外壳、权限或依赖的更新会发布新的正式签名 APK，需要从 Releases 下载并覆盖安装。请始终从本仓库 Releases 获取 APK，并核对同一 Release 中的 `SHA256SUMS.txt`。

## Android 自动发布

推送形如 `v1.2.1` 的版本标签后，GitHub Actions 会自动：

1. 从仓库加密 Secrets 恢复发布签名；
2. 使用 Gradle 构建正式签名 APK；
3. 使用 Android `apksigner` 校验签名；
4. 将 APK、PWA ZIP 和 SHA-256 校验文件上传到 GitHub Releases。

签名私钥不进入 Git 仓库。本地私钥必须长期安全备份；Android 要求后续覆盖升级继续使用同一签名证书。

## 数据说明

账本默认存储在用户设备本地的 IndexedDB 中。以下功能会产生外部数据传输：

- 使用 GitHub Gist 同步时，账本会以**未经加密的 JSON** 上传到你的私有 Gist；Token 会作为授权信息发送至 GitHub API。
- 使用 GPS 地点查询时，精确经纬度会发送给 OpenStreetMap Nominatim 进行反向地理编码。

同步 Token 默认只保存在当前浏览器会话；只有主动勾选“记住 Token”后才会长期保存在本设备。恢复 JSON 或云端数据前，应用会验证格式并创建本地自动恢复点，再通过单个 IndexedDB 事务替换数据。

完整说明见 [PRIVACY.md](PRIVACY.md)。

## 自动化测试

```bash
npm ci
npx playwright install chromium
npm test
```

测试默认使用 Playwright 独立管理的无头 Chromium，不会调用或干扰电脑上日常使用的 Google Chrome。每次推送和 Pull Request 都会由 GitHub Actions 执行静态资源检查、备份迁移测试和移动端浏览器回归测试。

## 后续优化方向

- [x] 定期收支自动记账（房租/工资/订阅）
- [ ] 账单图片附件
- [ ] 二级分类与标签
- [x] 高级搜索与筛选（关键词 + 分类 + 金额 + 日期范围）
- [x] 消费地图热力图（GPS 定位 + OpenStreetMap + Leaflet.heat）
- [x] 分类个性化图标（自定义图片 URL 或上传）
- [x] Excel 导出（账单明细 + 月度汇总 .xlsx）
- [ ] 跨设备同步（WebDAV）

## 许可证

本项目采用 [MIT License](LICENSE) 开源。你可以使用、复制、修改、合并、发布、分发、再许可及销售本软件的副本，但必须在软件的所有副本或主要部分中保留原始版权声明和许可证声明。

本软件按“原样”提供，不附带任何明示或默示担保。完整条款请参阅 [LICENSE](LICENSE)。
