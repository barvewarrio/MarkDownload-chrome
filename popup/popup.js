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

document.getElementById('download').addEventListener('click', download);
document.getElementById('downloadSelection').addEventListener('click', downloadSelection);

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
function sendDownloadMessage(text) {
  if (!text) return Promise.resolve();
  return chrome.runtime.sendMessage({
    type: 'md:download',
    markdown: text,
    title: document.getElementById('title').value,
    mdClipsFolder,
    imageList,
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

// 启动：读取设置、绑定开关，然后剪藏当前活动标签页
chrome.storage.sync.get(defaultOptions).then((options) => {
  checkInitialSettings(options);
  document.getElementById('selected').addEventListener('click', (e) => { e.preventDefault(); toggleClipSelection(options); });
  document.getElementById('document').addEventListener('click', (e) => { e.preventDefault(); toggleClipSelection(options); });
  document.getElementById('includeTemplate').addEventListener('click', (e) => { e.preventDefault(); toggleIncludeTemplate(options); });
  document.getElementById('downloadImages').addEventListener('click', (e) => { e.preventDefault(); toggleDownloadImages(options); });
  return clipSite();
}).catch((err) => showError(err));
