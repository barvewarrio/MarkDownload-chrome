# MarkDownload — Markdown Web Clipper (MV3)

> 基于 [deathau/MarkDownload](https://github.com/deathau/MarkDownload) 3.4.0 升级改造的 **Manifest V3** 版网页剪藏扩展,适用于 Chrome / Edge。

把网页正文一键存成干净的 **Markdown**:抓取页面 → 提取正文 → 转 Markdown → 下载到本地或发进 Obsidian。界面、右键菜单与设置项均已**中文化**,设置面板与剪藏弹窗采用 **Linear 风**设计。

## ✨ 功能

- **工具栏弹窗剪藏**:点图标进入编辑器,预览 / 修改 Markdown 后再下载;亦可用「✨ AI 优化」一键整理当前文本
- **右侧设置面板**:弹窗内点 **⚙️ 设置** 直接在浏览器右侧打开设置面板(Linear 风,按「基础 / 图片 / 格式 / AI 优化」分页);扩展管理页的「选项」打开的是同一页面
- **DeepSeek AI 优化(可选)**:保存到本地 / Obsidian、右键发送前自动整理(去乱码 / 重排标题 / 统一格式),可分别开启自动打标签、生成摘要、翻译(自定目标语言);API Key 由你填写、仅存本机
- **右键菜单(中文)**:
  - 下载 / 复制「网页」「选中内容」为 Markdown
  - 复制链接、图片为 Markdown
  - 复制标签页地址为 Markdown 链接(单个 / 全部 / 选中)
- **Obsidian 集成**:右键「发送网页 / 发送选中内容到 Obsidian」,自动写入仓库(默认 `剪藏/`,文件夹不存在会自动创建)
- **保存位置预设**:下载直接落到 `~/Downloads` 子文件夹,设置页提供预设卡片(`{pageTitle}/`、`{hostname}/`、`{date:YYYY}/{date:MM}/`)并实时预览路径
- **下载图片**:把正文图片一并存到同目录并改写为本地相对路径(可开关)
- **模板**:自定义 frontmatter / backmatter(默认含时间、标签、原文链接、作者)
- **快捷键**:`Alt+Shift+D` 存整页、`Alt+Shift+M` 打开弹窗、`Alt+Shift+L` 复制链接等
- **无构建步骤**:源码即用,依赖已内置于仓库

## 🚀 安装

新版 Chrome 出于安全策略不再接受商店外的 .crx 拖拽安装,统一走 **「加载已解压的扩展程序」**:

1. 打开 `chrome://extensions`(或 Edge 的 `edge://extensions`)
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**,选择本目录
4. 加载后即可看到「MarkDownload - Markdown Web Clipper (MV3)」

> 提示:加载解压版后,改完代码在扩展卡片上点 **⟳ 重新加载** 即可热更新,无需重装。

## 📖 使用

- **剪藏网页**:打开文章 → 点工具栏图标,在弹窗里预览 / 编辑 → 下载或复制
- **快速保存**:直接右键 →「下载网页为 Markdown」,或快捷键 `Alt+Shift+D`
- **发到 Obsidian**(需先配置,见下)

### 🛠 设置面板与 AI 优化(可选)

弹窗点 **⚙️ 设置**(或 `chrome://extensions` → 该扩展 →「详情」→「扩展程序选项」)进入设置面板:

1. **DeepSeek API Key**:切到「AI 优化」页,填入你在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 申请的 Key,回车即保存。
   > 🔒 **Key 仅存本机**(`storage.local`),**不会**同步到云端、**不会**出现在「导出设置」的 JSON 里、也**不会**提交到仓库——请放心填。
2. 勾选「启用 AI 优化」,并按需开关:**基础整理**(去乱码 / 重排标题 / 统一格式,保留原文)、**自动打标签**、**生成摘要**、**翻译**(填写目标语言,默认简体中文)。
3. **自动整理时机**:打开剪藏弹窗只做**快速原始预览**(即时、不等待 AI);在你真正保存时才会自动按设置整理——右键/快捷键「下载 / 复制为 Markdown」、发送到 Obsidian、以及弹窗点下载按钮(若这段文本没被你手动 ✨ 处理过)。也可在弹窗里手动点「✨ AI 优化」只整理当前预览文本(再点下载不会二次整理)。
   > 任何失败(如网络 / Key 失效 / 超时)**都会原样保留原文**,不会因 AI 问题丢失剪藏内容。

### Obsidian 集成(可选)

「发送到 Obsidian」依赖 Obsidian 的社区插件 **Advanced URI**,一次配置后即可用:

1. Obsidian → 设置 → 第三方插件 → 关闭安全模式 → 安装并启用 **Advanced URI**
2. 扩展选项页 → **Obsidian 集成** → 勾选「启用 Obsidian 集成」
3. 仓库名填你的库名(如 `OBSIdian`);目标文件夹默认 `剪藏/`,可自行修改

之后右键任意网页 →「发送网页到 Obsidian」,Obsidian 会自动新建笔记并写入 `剪藏/`。

## ⌨️ 快捷键

| 快捷键 | 动作 |
|---|---|
| `Alt+Shift+M` | 打开工具栏弹窗 |
| `Alt+Shift+D` | 保存当前页为 Markdown |
| `Alt+Shift+L` | 复制当前页地址为 Markdown 链接 |

其余命令(复制选中、发送到 Obsidian 等)可在 `chrome://extensions` → 键盘快捷键中自行绑定。

## 🗂 项目结构

```
background/background.js    MV3 service worker:调度、右键菜单、下载入口、aiPolish 转发
offscreen/offscreen.js      offscreen 转换引擎:DOM 解析 → Readability → Turndown,
                            以及 DeepSeek AI 整理(剪藏导出出口统一拦截)
offscreen/offscreen.html    承载转换引擎的离屏文档
offscreen/lib/              内置依赖(Readability / Turndown / moment 等)
contentScript/              注入页面抓取 DOM / 写入剪贴板
options/                    设置页 / 右侧设置面板(options.html + options.css + options.js)
popup/                      工具栏弹窗编辑器(CodeMirror,Linear 风)
shared/                     公共默认配置
icons/                      图标
manifest.json                MV3 清单
```

## 🔒 本地数据与安全

- **DeepSeek API Key**:填在设置面板「AI 优化」页,**仅存本机** `chrome.storage.local`(不同步、不进「导出设置」、不入 git)。`.gitignore` 已排除 `.env*`、`*.secret` 等凭据文件。
- **你的剪藏内容**:仅在你点下载 / 发送时才会带上 Key 请求 DeepSeek 官方接口(`api.deepseek.com`);扩展不会把正文发给第三方。

## 🧩 二开须知(MV3 关键约束)

MV3 的 service worker **没有 DOM**。凡涉及网页解析、HTML→Markdown 转换的逻辑都在
`offscreen/offscreen.js`(离屏文档)里跑;service worker 只做调度、持右键菜单和下载。
**新加功能若需操作 DOM,请放进 offscreen 文档,不要写在 service worker 中。**

图片下载采用「offscreen 生成 blob URL → service worker 调 `chrome.downloads`」的分工:
`chrome.downloads` 在离屏文档里不可用,而 blob URL 又只能在创建它的上下文使用。

下载位置受 Chromium 限制,只能写入系统「下载」目录内的子文件夹;如需存任意路径,在弹窗里
勾选「另存为」走系统保存对话框即可。

## ⚖️ 许可

本项目是 [MarkDownload](https://github.com/deathau/MarkDownload)(作者 Gordon Pedsersen / deathau)的 MV3 改造版,改动主要为:MV2→MV3 迁移、设置页与右键菜单中文化、Obsidian 集成与 `剪藏/` 文件夹默认等,供个人使用与二次开发。请遵循上游项目的开源许可。
