# Shared Ledger 共享账本

一个移动端优先的渐进式 Web 应用（PWA），支持多人共享记账、月度对比、年度总结、消费人格、成就徽章、愿望清单和心情记账。支持定期收支自动记账、个性化分类图标、高级搜索与筛选、Excel 导出、消费地图热力图。

## 在线体验

🔗 https://6b6f578ad6714a0eb992d6bd0bf45ae3.bj6.agentos-app.net

## 功能特性

- 📱 **PWA 可安装**：添加到手机主屏幕即可像原生 App 一样使用，离线可用
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
- 📊 **Excel 导出**：一键生成包含「账单明细」+「月度汇总」两个 Sheet 的 .xlsx 文件
- 📅 **定期收支自动记账**：设置每日 / 每周 / 每月重复项（房租/工资/订阅），打开 App 自动补录逾期记录
- 🎨 **分类个性化图标**：每个分类可绑定自定义图片（URL 或从相册上传，自动压缩 64×64）
- 🔍 **高级搜索与筛选**：跨月搜索，支持关键词、分类、金额范围、日期范围多维度过滤
- 🗺️ **消费地图热力图**：记账时一键 GPS 定位，地图页展示二维热力图 + 位置列表（OpenStreetMap 免费，无需 API Key）

## 技术栈

- 原生 HTML5 + CSS3 + JavaScript（无框架、无构建工具，浏览器直接运行）
- IndexedDB 本地持久化（7 个数据 Store：transactions / categories / users / settings / badges / wishes / recurring）
- Chart.js 4.4 图表（`defer` 加载，不阻塞首屏）
- SheetJS 0.18 Excel 导出（含月度汇总 Sheet）
- Leaflet 1.9 + leaflet.heat 消费地图热力图（OpenStreetMap，免费无需 Key）
- Service Worker + Manifest 实现 PWA 安装与离线可用

## 文件结构

```
shared-ledger/
├── index.html   # HTML 骨架（~200 行，只含结构）
├── app.css      # 全部样式（主题变量 + 组件 CSS）
├── app.js       # 全部业务逻辑（IndexedDB / 渲染 / 同步）
├── sw.js        # Service Worker（离线缓存）
├── manifest.json
├── LICENSE      # MIT 开源许可证
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

## 数据说明

所有数据均存储在用户设备本地的 IndexedDB 中，不会上传到任何服务器。  
如需跨设备同步，请使用「设置 → GitHub Gist 同步」，数据以**私有 Gist** 形式存储在你的 GitHub 账户下（明文 JSON，仅你可见，未经加密）。

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
