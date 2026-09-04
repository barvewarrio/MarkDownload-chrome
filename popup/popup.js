/*
 * MarkDownload MV3 — 工具栏弹窗。
 *
 * MV2 用 browser.tabs.executeScript(code) 抓取页面并通知后台；MV3 移除了
 * executeScript({code})，所以这里改为向内容脚本要 { dom, selection }
 * (md:getClipData)，再让 service worker 跑完整剪藏（md:clip → offscreen 引擎），
 * 引擎把渲染好的 markdown 回传到这里展示。
 *
 * 使用原生 chrome.*（MV3 下为 Promise）。右键菜单的勾选状态由 worker 持有，
 * 因此这里的开关通过 md:rebuildMenus 请它重建菜单。
 */

let imageList = null;
let mdClipsFolder = '';

const darkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
const cm = CodeMirror.fromTextArea(document.getElementById('md'), {
  theme: darkMode ? 'xq-dark' : 'xq-light',
  mode: 'markdown',
  lineWrapping: true,
});

cm.on('cursorActivity', () => {
  const somethingSelected = cm.somethingSelected();
  document.getElementById('downloadSelection').style.display = somethingSelected ? 'block' : 'none';
});

const defaultOptions = { includeTemplate: false, clipSelection: true, downloadImages: false };

function checkInitialSettings(options) {
  if (options.includeTemplate) document.querySelector('#includeTemplate').classList.add('checked');
  if (options.downloadImages) document.querySelector('#downloadImages').classList.add('checked');
  if (options.clipSelection) document.querySelector('#selected').classList.add('checked');
  else document.querySelector('#document').classList.add('checked');
}

function rebuildMenus() {
  chrome.runtime.sendMessage({ type: 'md:rebuildMenus' }).catch(() => {});
}

const toggleClipSelection = (options) => {
  options.clipSelection = !options.clipSelection;
  document.querySelector('#selected').classList.toggle('checked');
  document.querySelector('#document').classList.toggle('checked');
  chrome.storage.sync.set(options).then(() => clipSite()).catch(console.error);
};

const toggleIncludeTemplate = (options) => {
  options.includeTemplate = !options.includeTemplate;
  document.querySelector('#includeTemplate').classList.toggle('checked');
  chrome.storage.sync.set(options).then(() => { rebuildMenus(); return clipSite(); }).catch(console.error);
};

const toggleDownloadImages = (options) => {
  options.downloadImages = !options.downloadImages;
  document.querySelector('#downloadImages').classList.toggle('checked');
  chrome.storage.sync.set(options).then(() => rebuildMenus()).catch(console.error);
};

const showOrHideClipOption = (selection) => {
  document.getElementById('clipOption').style.display = selection ? 'flex' : 'none';
};

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ currentWindow: true, active: true });
  return tab;
}

async function getClipFromTab(tabId) {
  let clip = null;
  try {
    clip = await chrome.tabs.sendMessage(tabId, { type: 'md:getClipData', wantSelection: true });
  } catch (e) { clip = null; }
  // 内容脚本缺失（安装前就已打开的标签页）→ 注入后重试。
  if (!clip) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['contentScript/contentScript.js'] });
      clip = await chrome.tabs.sendMessage(tabId, { type: 'md:getClipData', wantSelection: true });
    } catch (err) { /* restricted page */ }
  }
  return clip;
}

async function clipSite() {
  const tab = await getActiveTab();
  if (!tab || tab.id == null) return showError('没有找到活动标签页');
  const options = await chrome.storage.sync.get(defaultOptions);

  const clip = await getClipFromTab(tab.id);
  if (!clip) return showError('无法访问此页面（受限制页面或暂不支持）。');

  showOrHideClipOption(clip.selection);
  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: 'md:clip',
      dom: clip.dom,
      selection: clip.selection,
      clipSelection: options.clipSelection,
    });
  } catch (err) {
    return showError(err && err.message || err);
  }
  if (!res || res.ok === false) return showError((res && res.error) || '剪藏失败');

  cm.setValue(res.markdown);
  document.getElementById('title').value = res.article.title;
  imageList = res.imageList;
  mdClipsFolder = res.mdClipsFolder;
  document.getElementById('container').style.display = 'flex';
  document.getElementById('spinner').style.display = 'none';
  document.getElementById('download').focus();
  cm.refresh();
}

// 下载由 service worker → offscreen 执行（Downloads API + blob）。
// aiApply：这段文本是否已在弹窗里手动 ✨ 优化过。
// true  = 未手动优化（编辑器=原文），下载前由 worker 补一次自动 AI 整理；
// false = 已手动 ✨ 过，保存时不再重复调用。
let aiAppliedInEditor = false;
function sendDownloadMessage(text) {
  if (!text) return Promise.resolve();
  return chrome.runtime.sendMessage({
    type: 'md:download',
    markdown: text,
    title: document.getElementById('title').value,
    mdClipsFolder,
    imageList,
    aiApply: aiAppliedInEditor ? false : true,
  });
}

async function download(e) {
  e.preventDefault();
  await sendDownloadMessage(cm.getValue());
  window.close();
}

async function downloadSelection(e) {
  e.preventDefault();
  if (cm.somethingSelected()) {
    await sendDownloadMessage(cm.getSelection());
  }
}

function showError(err) {
  document.getElementById('container').style.display = 'flex';
  document.getElementById('spinner').style.display = 'none';
  cm.setValue('剪藏出错\n\n' + err);
  console.error(err);
}

// 在弹窗状态区显示一行提示（不打断编辑）
function showToast(msg, isError) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 3000);
}

// ⚙️ 设置：打开右侧 Side Panel（需在弹窗手势内直接调用，勿经 SW 转发以免丢手势）
async function openSettingsPanel() {
  try {
    if (!chrome.sidePanel || !chrome.sidePanel.open) {
      // 极旧/异常环境兜底：退化为新标签页打开设置
      chrome.tabs.create({ url: 'options/options.html' });
      return;
    }
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
  } catch (e) {
    console.error('open settings panel failed', e);
    showToast('打开设置面板失败', true);
  }
}

// ✨ AI 优化：对编辑器当前文本按设置调用 DeepSeek 整理，回填。
// 设置与 API Key 都在 worker / 离屏侧读取（Key 仅存本机 storage.local），
// 这里只做快速前置校验给出友好提示，再发消息让离屏文档实际加工。
async function polishWithAI() {
  const text = cm.getValue();
  if (!text || !text.trim()) return;
  try {
    const settings = await chrome.storage.sync.get({
      aiEnabled: false, aiClean: true, aiTags: false, aiSummary: false, aiTranslate: false, aiTargetLang: '',
    });
    if (!settings.aiEnabled || !(settings.aiClean || settings.aiTags || settings.aiSummary || settings.aiTranslate)) {
      showToast('AI 优化未开启，请先到 ⚙️ 设置中开启并配置', true);
      return;
    }
    const { deepseekKey } = await chrome.storage.local.get({ deepseekKey: '' });
    if (!deepseekKey) {
      showToast('请先在 ⚙️ 设置中填写 DeepSeek API Key', true);
      return;
    }
    showToast('AI 优化中…');
    const res = await chrome.runtime.sendMessage({ type: 'md:aiPolish', markdown: text });
    if (res && res.ok && res.markdown) {
      if (res.applied === false) {
        // warning 来自离屏文档：Key 缺失 / 网络 / 接口 / 超时等真实原因。
        if (res.warning) {
          showToast(res.warning, true);
          return;
        }
        if (res.reason === 'disabled') {
          showToast('AI 优化未开启，请先到 ⚙️ 设置中开启并配置', true);
          return;
        }
        showToast('AI 已处理：内容本身较整洁，未发现需改动之处', false);
        return;
      }
      cm.setValue(res.markdown);
      aiAppliedInEditor = true; // 已手动优化 → 下载时不再重复自动整理
      showToast('AI 优化完成 ✨');
    } else {
      showToast((res && res.error) || 'AI 优化失败，已保留原文', true);
    }
  } catch (err) {
    console.error('aiPolish failed', err);
    showToast('AI 优化失败，已保留原文', true);
  }
}

// 启动：读取设置、绑定开关，然后剪藏当前活动标签页
chrome.storage.sync.get(defaultOptions).then((options) => {
  checkInitialSettings(options);
  document.getElementById('selected').addEventListener('click', (e) => { e.preventDefault(); toggleClipSelection(options); });
  document.getElementById('document').addEventListener('click', (e) => { e.preventDefault(); toggleClipSelection(options); });
  document.getElementById('includeTemplate').addEventListener('click', (e) => { e.preventDefault(); toggleIncludeTemplate(options); });
  document.getElementById('downloadImages').addEventListener('click', (e) => { e.preventDefault(); toggleDownloadImages(options); });
  document.getElementById('download').addEventListener('click', download);
  document.getElementById('downloadSelection').addEventListener('click', downloadSelection);
  document.getElementById('aiPolish').addEventListener('click', (e) => { e.preventDefault(); polishWithAI(); });
  document.getElementById('openSettings').addEventListener('click', (e) => { e.preventDefault(); openSettingsPanel(); });
  return clipSite();
}).catch((err) => showError(err));
