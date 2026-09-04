/*
 * MarkDownload MV3 — service worker（只做调度）。
 *
 * HTML→Markdown 的转换需要真实 DOM，而 MV3 的 service worker 没有 DOM，
 * 所以转换与 blob 的制造都在离屏文档（offscreen/offscreen.js）里完成。
 * 本 worker 负责：
 *   - 按需保持离屏文档存活
 *   - 持有右键菜单与快捷键
 *   - 与页面内容脚本通信，取页面/选中区 DOM、写剪贴板（MV3 已无
 *     executeScript({code})）
 *
 * 下载走“离屏文档造 blob URL → worker 调 chrome.downloads.download”：
 * 离屏文档里有 URL.createObjectURL 但没有 chrome.downloads；worker 恰好相反。
 * 每个 blob 只在其创建上下文里可用，所以图片 blob 也在离屏文档生成。
 */

import { getOptions } from '../shared/options-module.js';

// ---------------------------------------------------------------------------
// 离屏文档生命周期
// ---------------------------------------------------------------------------
const OFFSCREEN_URL = 'offscreen/offscreen.html';
let offscreenCreating = null;

async function hasOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (offscreenCreating) return offscreenCreating;
  offscreenCreating = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['DOM_PARSER'],
    justification: 'MarkDownload parses and converts the full page DOM into Markdown with Readability + Turndown, which require a DOM document that the MV3 service worker does not have.',
  }).then(() => { offscreenCreating = null; });
  await offscreenCreating;
}

async function offscreen(action, payload) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ action, ...payload });
  if (!res || res.ok === false) {
    throw new Error((res && res.error) || 'offscreen failed: ' + action);
  }
  return res;
}

// ---------------------------------------------------------------------------
// 内容脚本桥接
// ---------------------------------------------------------------------------
async function sendToTab(tabId, message) {
  try { return await chrome.tabs.sendMessage(tabId, message); }
  catch (e) { return null; }
}

async function getClipData(tabId, wantSelection) {
  let clip = await sendToTab(tabId, { type: 'md:getClipData', wantSelection: !!wantSelection });
  if (!clip) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['contentScript/contentScript.js'] });
    } catch (e) { /* 受限制页面，跳过 */ }
    clip = await sendToTab(tabId, { type: 'md:getClipData', wantSelection: !!wantSelection });
  }
  return clip;
}

async function copyTo(tab, text) {
  const done = await sendToTab(tab.id, { type: 'md:copy', text });
  if (!done) await offscreen('clipboardWrite', { text });
}

function isAddressable(url) {
  return !!url && !/^(chrome|chrome-extension|edge|about|devtools|view-source|moz-extension|file):/i.test(url);
}

// ---------------------------------------------------------------------------
// 剪藏流程
// ---------------------------------------------------------------------------
async function clipTab(tabId, selectionOnly) {
  const clip = await getClipData(tabId, selectionOnly);
  if (!clip) throw new Error('Cannot read this page (restricted or not supported).');
  const res = await offscreen('clip', {
    dom: clip.dom,
    selection: selectionOnly ? clip.selection : undefined,
    clipSelection: true,
  });
  return res; // { markdown, article, imageList, mdClipsFolder }
}

// ---------------------------------------------------------------------------
// 下载。
// blob URL 归离屏文档所有（那里有 URL.createObjectURL，但没有 chrome.downloads）。
// 流程：先请离屏文档生成 blob URL，再由本 worker 调 chrome.downloads.download
// （worker 才有该 API）。下载到达终态后回收各 blob URL，避免大剪藏占用离屏文档内存。
// ---------------------------------------------------------------------------
async function downloadMarkdown({ markdown, title, mdClipsFolder = '', imageList = {}, saveAs }) {
  const options = await getOptions();
  const filename = (mdClipsFolder || '') + (title || 'page') + '.md';
  const res = await offscreen('doDownload', { markdown, imageList });

  // .md 文件本体。
  await chrome.downloads.download({
    url: res.mdUrl,
    filename,
    saveAs: saveAs != null ? saveAs : options.saveAs,
  });
  revokeBlobWhenDone(res.mdUrl);

  // 图片与 .md 放同一目录（路径相对“下载”目录）。
  const slash = filename.lastIndexOf('/');
  const imgBaseDir = slash > 0 ? filename.substring(0, slash + 1) : '';
  for (const img of res.imageEntries || []) {
    try {
      await chrome.downloads.download({ url: img.url, filename: imgBaseDir + img.filename, saveAs: false });
      revokeBlobWhenDone(img.url);
    } catch (e) { /* 跳过失败的图片 */ }
  }
}

function revokeBlobWhenDone(blobUrl) {
  if (!/^blob:/i.test(blobUrl)) return;
  const revoke = () => {
    chrome.downloads.onChanged.removeListener(revoke);
    chrome.runtime.sendMessage({ type: 'md:revokeBlob', url: blobUrl }).catch(() => {});
  };
  chrome.downloads.onChanged.addListener(revoke);
}

// ---------------------------------------------------------------------------
// 右键菜单
// ---------------------------------------------------------------------------
async function createMenus() {
  const options = await getOptions();
  await chrome.contextMenus.removeAll();
  if (!options.contextMenus) return;

  const create = (id, title, contexts, extra = {}) => {
    try { chrome.contextMenus.create({ id, title, contexts, ...extra }); } catch (e) { /* 某些上下文（如 tab）仅 Firefox 支持，忽略 */ }
  };
  const sep = (id, contexts) => { try { chrome.contextMenus.create({ id, type: 'separator', contexts }); } catch (e) {} };

  // tab 上下文（仅 Firefox；Chrome 上无害）
  create('download-markdown-tab', '下载标签页为 Markdown', ['tab']);
  create('tab-download-markdown-alltabs', '下载所有标签页为 Markdown', ['tab']);
  create('copy-tab-as-markdown-link-tab', '复制标签页地址为 Markdown 链接', ['tab']);
  create('copy-tab-as-markdown-link-all-tab', '复制所有标签页地址为 Markdown 链接列表', ['tab']);
  create('copy-tab-as-markdown-link-selected-tab', '复制选中标签页地址为 Markdown 链接列表', ['tab']);
  sep('tab-separator-1', ['tab']);
  create('tabtoggle-includeTemplate', '包含前置/后置模板', ['tab'], { type: 'checkbox', checked: options.includeTemplate });
  create('tabtoggle-downloadImages', '下载图片', ['tab'], { type: 'checkbox', checked: options.downloadImages });

  // 页面 / 选中内容
  create('download-markdown-alltabs', '下载所有标签页为 Markdown', ['all']);
  sep('separator-0', ['all']);
  create('download-markdown-selection', '下载选中内容为 Markdown', ['selection']);
  create('download-markdown-all', '下载网页为 Markdown', ['all']);
  sep('separator-1', ['all']);
  create('copy-markdown-selection', '复制选中内容为 Markdown', ['selection']);
  create('copy-markdown-link', '复制链接为 Markdown', ['link']);
  create('copy-markdown-image', '复制图片为 Markdown', ['image']);
  create('copy-markdown-all', '复制网页为 Markdown', ['all']);
  create('copy-tab-as-markdown-link', '复制标签页地址为 Markdown 链接', ['all']);
  create('copy-tab-as-markdown-link-all', '复制所有标签页地址为 Markdown 链接列表', ['all']);
  create('copy-tab-as-markdown-link-selected', '复制选中标签页地址为 Markdown 链接列表', ['all']);
  sep('separator-2', ['all']);

  if (options.obsidianIntegration) {
    create('copy-markdown-obsidian', '发送选中内容到 Obsidian', ['selection']);
    create('copy-markdown-obsall', '发送网页到 Obsidian', ['all']);
    sep('separator-3', ['all']);
  }
  create('toggle-includeTemplate', '包含前置/后置模板', ['all'], { type: 'checkbox', checked: options.includeTemplate });
  create('toggle-downloadImages', '下载图片', ['all'], { type: 'checkbox', checked: options.downloadImages });
}

async function toggleSetting(setting) {
  const options = await getOptions();
  options[setting] = !options[setting];
  await chrome.storage.sync.set(options);
  // 重建菜单，让复选框状态刷新。
  await createMenus();
}

// ---------------------------------------------------------------------------
// 各动作
// ---------------------------------------------------------------------------
async function doClip(tab, selectionOnly, mode) {
  const res = await clipTab(tab.id, selectionOnly);
  if (mode === 'download') {
    await downloadMarkdown({ markdown: res.markdown, title: res.article.title, mdClipsFolder: res.mdClipsFolder, imageList: res.imageList });
  } else {
    await copyTo(tab, res.markdown);
  }
}

async function copyLink(tab, info) {
  const linkText = info.linkText || info.selectionText || info.linkUrl || '';
  const href = info.linkUrl || linkText;
  const html = `<a href="${href}">${linkText}</a>`;
  const clip = await getClipData(tab.id, false);
  if (!clip) return;
  const res = await offscreen('convertLink', { dom: clip.dom, html });
  await copyTo(tab, res.markdown);
}

async function copyTabLink(tab) {
  const clip = await getClipData(tab.id, false);
  if (!clip) return;
  const res = await offscreen('titleForDom', { dom: clip.dom });
  const title = res.title || tab.title || 'page';
  await copyTo(tab, `[${title}](${clip.baseURI || tab.url})`);
}

async function copyTabLinks(tab, highlightedOnly) {
  const options = await getOptions();
  const q = { currentWindow: true };
  if (highlightedOnly) q.highlighted = true;
  const tabs = await chrome.tabs.query(q);
  const lines = [];
  for (const t of tabs) {
    if (!t.id || !isAddressable(t.url)) continue;
    const clip = await getClipData(t.id, false);
    let title = t.title || 'page';
    let url = t.url;
    if (clip) {
      const r = await offscreen('titleForDom', { dom: clip.dom });
      title = (r && r.title) || title;
      url = clip.baseURI || url;
    }
    lines.push(`${options.bulletListMarker} [${title}](${url})`);
  }
  await copyTo(tab, lines.join('\n'));
}

async function copyToObsidian(tab, selectionOnly) {
  const res = await clipTab(tab.id, selectionOnly);
  const options = await getOptions();
  await copyTo(tab, res.markdown);
  const folder = (await offscreen('formatObsidianFolder', { article: res.article })).folder || '';
  const file = folder + res.article.title;
  const vault = options.obsidianVault ? 'vault=' + encodeURIComponent(options.obsidianVault) + '&' : '';
  // Advanced URI 插件注册的是 obsidian://adv-uri（不是 obsidian://advanced-uri）。
  // filepath 可能含 "/" 分隔符，因此用 encodeURIComponent 逐段编码保持完整；
  // # （维基式双链）绝不能做百分号编码，否则会被当作片段截断。
  const encodedPath = file.split('/').map(encodeURIComponent).join('/');
  await chrome.tabs.update(tab.id, { url: `obsidian://adv-uri?${vault}clipboard=true&mode=new&filepath=${encodedPath}` });
}

async function downloadAllTabs(tab) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  for (const t of tabs) {
    if (!t.id || !isAddressable(t.url)) continue;
    try { await doClip(t, false, 'download'); } catch (e) { console.warn('skip tab', t.id, e); }
  }
}

// ---------------------------------------------------------------------------
// 右键菜单点击处理
// ---------------------------------------------------------------------------
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (!tab || tab.id == null || !isAddressable(tab.url)) return;
    const id = info.menuItemId;

    if (id === 'download-markdown-selection') return await doClip(tab, true, 'download');
    if (id === 'download-markdown-all' || id === 'download-markdown-tab') return await doClip(tab, false, 'download');
    if (id === 'copy-markdown-selection') return await doClip(tab, true, 'copy');
    if (id === 'copy-markdown-all') return await doClip(tab, false, 'copy');
    if (id === 'download-markdown-alltabs' || id === 'tab-download-markdown-alltabs') return await downloadAllTabs(tab);

    if (id === 'copy-markdown-link') return await copyLink(tab, info);
    if (id === 'copy-markdown-image') return await copyTo(tab, `![](${info.srcUrl})`);
    if (id === 'copy-markdown-obsidian') return await copyToObsidian(tab, true);
    if (id === 'copy-markdown-obsall') return await copyToObsidian(tab, false);

    if (id === 'copy-tab-as-markdown-link' || id === 'copy-tab-as-markdown-link-tab') return await copyTabLink(tab);
    if (id === 'copy-tab-as-markdown-link-all' || id === 'copy-tab-as-markdown-link-all-tab') return await copyTabLinks(tab, false);
    if (id === 'copy-tab-as-markdown-link-selected' || id === 'copy-tab-as-markdown-link-selected-tab') return await copyTabLinks(tab, true);

    if (id.startsWith('toggle-') || id.startsWith('tabtoggle-')) return await toggleSetting(id.split('-')[1]);
  } catch (err) {
    console.error('context menu error', err);
  }
});

// ---------------------------------------------------------------------------
// 快捷键
// ---------------------------------------------------------------------------
chrome.commands.onCommand.addListener(async (command) => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null || !isAddressable(tab.url)) return;
    switch (command) {
      case 'download_tab_as_markdown': return await doClip(tab, false, 'download');
      case 'copy_tab_as_markdown': return await doClip(tab, false, 'copy');
      case 'copy_selection_as_markdown': return await doClip(tab, true, 'copy');
      case 'copy_tab_as_markdown_link': return await copyTabLink(tab);
      case 'copy_selected_tab_as_markdown_link': return await copyTabLinks(tab, true);
      case 'copy_selection_to_obsidian': return await copyToObsidian(tab, true);
      case 'copy_tab_to_obsidian': return await copyToObsidian(tab, false);
      default: break;
    }
  } catch (err) {
    console.error('command error', command, err);
  }
});

// ---------------------------------------------------------------------------
// 运行时消息（弹窗 / 内容脚本 / 设置页）
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 内容脚本（由弹窗驱动）→ worker：跑完整剪藏。
  if (message && message.type === 'md:clip') {
    offscreen('clip', {
      dom: message.dom,
      selection: message.selection,
      clipSelection: message.clipSelection,
    }).then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true; // async
  }

  // 弹窗 → worker：用户在弹窗里预览/编辑 markdown 后请求下载。
  if (message && message.type === 'md:download') {
    downloadMarkdown(message).catch((err) => console.error('download failed', err));
    return false;
  }

  // 设置页 → worker：导入/切换后重建右键菜单。
  if (message && message.type === 'md:rebuildMenus') {
    createMenus().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  return undefined;
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => { createMenus().catch(console.error); });
chrome.runtime.onStartup.addListener(() => { createMenus().catch(console.error); });
createMenus().catch(console.error);
