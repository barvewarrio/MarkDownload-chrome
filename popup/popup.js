/*
 * MarkDownload MV3 — popup.
 *
 * MV2 scraped the page via browser.tabs.executeScript(code) and messaged the
 * background. MV3 dropped executeScript({code}), so the popup asks the content
 * script for { dom, selection } (md:getClipData) and tells the service worker
 * to run the clip (md:clip → offscreen engine), which replies with rendered
 * markdown for display here.
 *
 * Uses raw chrome.* (promise-based in MV3). Context-menu checkbox states are
 * owned by the worker, so toggles here ask it to rebuild via md:rebuildMenus.
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
  // Content script absent (tab predates install) → inject and retry.
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
  if (!tab || tab.id == null) return showError('No active tab');
  const options = await chrome.storage.sync.get(defaultOptions);

  const clip = await getClipFromTab(tab.id);
  if (!clip) return showError('Cannot access this page.');

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
  if (!res || res.ok === false) return showError((res && res.error) || 'Clip failed');

  cm.setValue(res.markdown);
  document.getElementById('title').value = res.article.title;
  imageList = res.imageList;
  mdClipsFolder = res.mdClipsFolder;
  document.getElementById('container').style.display = 'flex';
  document.getElementById('spinner').style.display = 'none';
  document.getElementById('download').focus();
  cm.refresh();
}

// Download is executed by the service worker → offscreen (Downloads API + blobs).
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
  cm.setValue('Error clipping the page\n\n' + err);
  console.error(err);
}

// boot: read settings, wire toggles, then clip the active tab
chrome.storage.sync.get(defaultOptions).then((options) => {
  checkInitialSettings(options);
  document.getElementById('selected').addEventListener('click', (e) => { e.preventDefault(); toggleClipSelection(options); });
  document.getElementById('document').addEventListener('click', (e) => { e.preventDefault(); toggleClipSelection(options); });
  document.getElementById('includeTemplate').addEventListener('click', (e) => { e.preventDefault(); toggleIncludeTemplate(options); });
  document.getElementById('downloadImages').addEventListener('click', (e) => { e.preventDefault(); toggleDownloadImages(options); });
  return clipSite();
}).catch((err) => showError(err));
