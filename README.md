# MarkDownload — Markdown Web Clipper (MV3)

> 基于 [deathau/MarkDownload](https://github.com/deathau/MarkDownload) 3.4.0 升级改造的 **Manifest V3** 版网页剪藏扩展,适用于 Chrome / Edge。

把网页正文一键存成干净的 **Markdown**:抓取页面 → 提取正文 → 转 Markdown → 下载到本地或发进 Obsidian。界面、右键菜单与设置项均已**中文化**。

## ✨ 功能

- **工具栏弹窗剪藏**:点图标进入编辑器,预览 / 修改 Markdown 后再下载或复制
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
background/background.js    MV3 service worker:调度、右键菜单、下载入口
offscreen/offscreen.js      offscreen 转换引擎:DOM 解析 → Readability → Turndown
offscreen/offscreen.html    承载转换引擎的离屏文档
offscreen/lib/              内置依赖(Readability / Turndown / moment 等)
contentScript/              注入页面抓取 DOM / 写入剪贴板
options/                    设置页(中文,文件夹预设、Obsidian、模板)
popup/                      工具栏弹窗编辑器(CodeMirror)
shared/                     公共默认配置
icons/                      图标
manifest.json                MV3 清单
```

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
