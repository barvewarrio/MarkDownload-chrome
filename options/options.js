/*
 * MarkDownload MV3 — 设置页逻辑。
 *
 * - 本页为“点一下/敲完即自动保存”，无需保存按钮。
 * - 右键菜单由 service worker 持有（contextMenus API 不能在扩展页面里调用），
 *   所以只要设置项会改变菜单，就发 md:rebuildMenus 让 worker 重建。
 * - MV3 只实现了 Downloads API 一种下载方式（Chrome 无“内容链接”模式），
 *   下载固定落在系统“下载”目录内，见“文件保存位置”区的说明。
 */

let options = defaultOptions;
let keyupTimeout = null;

// 通知 service worker 依据当前 storage 重建右键菜单。
function rebuildMenus() {
  browser.runtime.sendMessage({ type: 'md:rebuildMenus' }).catch(() => {});
}

// ---------------------------------------------------------------------------
// “保存到下载子文件夹” —— 预设卡片 / 自定义 / 实时预览
// ---------------------------------------------------------------------------
const FOLDER_PRESETS = ['', '{pageTitle}/', '{hostname}/', '{date:YYYY}/{date:MM}/'];

function showCustomFolder(shouldShow) {
  show(document.getElementById('customFolderWrap'), shouldShow);
}

// 卡片点选：value 为相对子目录模板；'custom' 表示展开自定义输入。
function handleFolderPreset(value) {
  const input = document.querySelector("[name='mdClipsFolder']");
  if (value === 'custom') {
    showCustomFolder(true);
    if (input) { input.focus(); input.select(); }
    return;
  }
  if (!input) return;
  input.value = value;
  options.mdClipsFolder = value;
  showCustomFolder(false);
  save();
  updatePreview();
}

// 根据当前保存值决定选中哪张卡片 / 是否展开自定义框。
function applyPresetFromFolder() {
  const value = (options.mdClipsFolder || '').trim();
  const radios = document.querySelectorAll("[name='folderPreset']");
  if (FOLDER_PRESETS.includes(value)) {
    setCheckedValue(radios, value);
    showCustomFolder(false);
  } else {
    setCheckedValue(radios, 'custom');
    showCustomFolder(true);
  }
  updatePreview();
}

const pad2 = (n) => String(n).padStart(2, '0');

function updatePreview() {
  const el = document.getElementById('folderPreview');
  const input = document.querySelector("[name='mdClipsFolder']");
  if (!el || !input) return;
  const raw = (input.value || '').trim().replace(/^\/+|\/+$/g, '');
  if (!raw) {
    el.textContent = '将直接保存到 ~/Downloads/ 根目录（.md 与图片都在下载目录下）。';
    return;
  }
  const now = new Date();
  const y = now.getFullYear(), mo = pad2(now.getMonth() + 1), d = pad2(now.getDate());
  const sample = {
    '{title}': '示例文章', '{pageTitle}': '示例文章',
    '{hostname}': 'example.com', '{host}': 'example.com', '{origin}': 'https://example.com',
    '{baseURI}': 'https://example.com/a', '{byline}': '作者', '{keywords}': '标签',
    '{date:YYYY}': String(y), '{date:YYYY-MM}': `${y}-${mo}`,
    '{date:YYYY-MM-DD}': `${y}-${mo}-${d}`, '{date:MM}': mo, '{date:DD}': d,
  };
  let p = raw;
  for (const [k, v] of Object.entries(sample)) p = p.split(k).join(v);
  el.textContent = '预览：~/Downloads/' + p + '/…/ 文件名.md';
}

const saveOptions = (e) => {
  e.preventDefault();
  options = {
    frontmatter: document.querySelector("[name='frontmatter']").value,
    backmatter: document.querySelector("[name='backmatter']").value,
    title: document.querySelector("[name='title']").value,
    disallowedChars: document.querySelector("[name='disallowedChars']").value,
    includeTemplate: document.querySelector("[name='includeTemplate']").checked,
    saveAs: document.querySelector("[name='saveAs']").checked,
    downloadImages: document.querySelector("[name='downloadImages']").checked,
    imagePrefix: document.querySelector("[name='imagePrefix']").value,
    mdClipsFolder: document.querySelector("[name='mdClipsFolder']").value,
    turndownEscape: document.querySelector("[name='turndownEscape']").checked,
    contextMenus: document.querySelector("[name='contextMenus']").checked,
    obsidianIntegration: document.querySelector("[name='obsidianIntegration']").checked,
    obsidianVault: document.querySelector("[name='obsidianVault']").value,
    obsidianFolder: document.querySelector("[name='obsidianFolder']").value,
    aiEnabled: document.querySelector("[name='aiEnabled']").checked,
    aiClean: document.querySelector("[name='aiClean']").checked,
    aiTags: document.querySelector("[name='aiTags']").checked,
    aiSummary: document.querySelector("[name='aiSummary']").checked,
    aiTranslate: document.querySelector("[name='aiTranslate']").checked,
    aiTargetLang: document.querySelector("[name='aiTargetLang']").value,

    headingStyle: getCheckedValue(document.querySelectorAll("input[name='headingStyle']")),
    hr: getCheckedValue(document.querySelectorAll("input[name='hr']")),
    bulletListMarker: getCheckedValue(document.querySelectorAll("input[name='bulletListMarker']")),
    codeBlockStyle: getCheckedValue(document.querySelectorAll("input[name='codeBlockStyle']")),
    fence: getCheckedValue(document.querySelectorAll("input[name='fence']")),
    emDelimiter: getCheckedValue(document.querySelectorAll("input[name='emDelimiter']")),
    strongDelimiter: getCheckedValue(document.querySelectorAll("input[name='strongDelimiter']")),
    linkStyle: getCheckedValue(document.querySelectorAll("input[name='linkStyle']")),
    linkReferenceStyle: getCheckedValue(document.querySelectorAll("input[name='linkReferenceStyle']")),
    imageStyle: getCheckedValue(document.querySelectorAll("input[name='imageStyle']")),
    imageRefStyle: getCheckedValue(document.querySelectorAll("input[name='imageRefStyle']")),
  };
  save();
};

const save = () => {
  const spinner = document.getElementById("spinner");
  spinner.style.display = "block";
  browser.storage.sync.set(options)
    .then(() => {
      rebuildMenus(); // 菜单勾选状态由 worker 依据 storage 重建
    })
    .then(() => {
      document.querySelectorAll(".status").forEach(statusEl => {
        statusEl.textContent = "设置已保存 💾";
        statusEl.classList.remove('error');
        statusEl.classList.add('success');
        statusEl.style.opacity = 1;
      });
      setTimeout(() => {
        document.querySelectorAll(".status").forEach(statusEl => {
          statusEl.style.opacity = 0;
        });
      }, 5000);
      spinner.style.display = "none";
    })
    .catch(err => {
      document.querySelectorAll(".status").forEach(statusEl => {
        statusEl.textContent = err;
        statusEl.classList.remove('success');
        statusEl.classList.add('error');
        statusEl.style.opacity = 1;
      });
      spinner.style.display = "none";
    });
};

function hideStatus() { this.style.opacity = 0; }

// 依据关联设置修正冲突选项（与旧版行为一致）。
function reconcile(optionsObj) {
  // “下载图片”关闭时，图片不可能“存本地”，把样式回退到“原图地址”。
  if (!optionsObj.downloadImages &&
      (optionsObj.imageStyle == 'markdown' || optionsObj.imageStyle.startsWith('obsidian'))) {
    optionsObj.imageStyle = 'originalSource';
  }
  return optionsObj;
}

const setCurrentChoice = (result) => {
  options = reconcile(result);

  document.querySelector("[name='frontmatter']").value = options.frontmatter;
  sizeTextarea(document.querySelector("[name='frontmatter']"));
  document.querySelector("[name='backmatter']").value = options.backmatter;
  sizeTextarea(document.querySelector("[name='backmatter']"));
  document.querySelector("[name='title']").value = options.title;
  document.querySelector("[name='disallowedChars']").value = options.disallowedChars;
  document.querySelector("[name='includeTemplate']").checked = options.includeTemplate;
  document.querySelector("[name='saveAs']").checked = options.saveAs;
  document.querySelector("[name='downloadImages']").checked = options.downloadImages;
  document.querySelector("[name='imagePrefix']").value = options.imagePrefix;
  document.querySelector("[name='mdClipsFolder']").value = options.mdClipsFolder || '';
  document.querySelector("[name='turndownEscape']").checked = options.turndownEscape;
  document.querySelector("[name='contextMenus']").checked = options.contextMenus;
  document.querySelector("[name='obsidianIntegration']").checked = options.obsidianIntegration;
  document.querySelector("[name='obsidianVault']").value = options.obsidianVault || '';
  document.querySelector("[name='obsidianFolder']").value = options.obsidianFolder || '';

  document.querySelector("[name='aiEnabled']").checked = !!options.aiEnabled;
  document.querySelector("[name='aiClean']").checked = options.aiClean !== false;
  document.querySelector("[name='aiTags']").checked = !!options.aiTags;
  document.querySelector("[name='aiSummary']").checked = !!options.aiSummary;
  document.querySelector("[name='aiTranslate']").checked = !!options.aiTranslate;
  document.querySelector("[name='aiTargetLang']").value = options.aiTargetLang || '';

  setCheckedValue(document.querySelectorAll("[name='headingStyle']"), options.headingStyle);
  setCheckedValue(document.querySelectorAll("[name='hr']"), options.hr);
  setCheckedValue(document.querySelectorAll("[name='bulletListMarker']"), options.bulletListMarker);
  setCheckedValue(document.querySelectorAll("[name='codeBlockStyle']"), options.codeBlockStyle);
  setCheckedValue(document.querySelectorAll("[name='fence']"), options.fence);
  setCheckedValue(document.querySelectorAll("[name='emDelimiter']"), options.emDelimiter);
  setCheckedValue(document.querySelectorAll("[name='strongDelimiter']"), options.strongDelimiter);
  setCheckedValue(document.querySelectorAll("[name='linkStyle']"), options.linkStyle);
  setCheckedValue(document.querySelectorAll("[name='linkReferenceStyle']"), options.linkReferenceStyle);
  setCheckedValue(document.querySelectorAll("[name='imageStyle']"), options.imageStyle);
  setCheckedValue(document.querySelectorAll("[name='imageRefStyle']"), options.imageRefStyle);

  applyPresetFromFolder();
  refereshElements();
};

const restoreOptions = () => {
  browser.storage.sync.get(defaultOptions)
    .then((result) => {
      // 清理旧版遗留的、本版已不再使用的键。
      delete result.downloadMode;
      // 未指定 Obsidian 文件夹时，默认放进“剪藏/”。
      if (!result.obsidianFolder) result.obsidianFolder = '剪藏/';
      setCurrentChoice(result);
    })
    .catch((err) => console.error(err));
  // DeepSeek API Key 仅存本机（storage.local），不回显明文。
  browser.storage.local.get({ deepseekKey: '' })
    .then(({ deepseekKey }) => {
      const el = document.querySelector("[name='deepseekKey']");
      if (el) { el.value = deepseekKey ? '••••••••' : ''; el.dataset.has = deepseekKey ? '1' : '0'; }
    })
    .catch((err) => console.error(err));
};

function sizeTextarea(el) { el.parentNode.dataset.value = el.value; }

// 折叠面板显隐：仅切换 .hidden 类（由 CSS 控制），比“测量高度后定高”更稳，
// 即使容器初始处于隐藏的分页里也不会量到 0 高度。
const show = (el, shouldShow) => {
  if (!el) return;
  if (shouldShow) el.classList.remove('hidden');
  else el.classList.add('hidden');
};

// 底部状态条即时提示（保存成功 / API Key 已存等）。
function flashStatus(message) {
  document.querySelectorAll('.status').forEach(s => {
    s.textContent = message;
    s.classList.remove('error');
    s.classList.add('success');
    s.style.opacity = 1;
  });
  setTimeout(() => {
    document.querySelectorAll('.status').forEach(s => { s.style.opacity = 0; });
  }, 3000);
}

const refereshElements = () => {
  // “链接引用编号”只在链接样式为“引用式”时显示。
  show(document.getElementById("linkReferenceStyle"), options.linkStyle == "referenced");
  // “图片引用语法”只在图片不是“Obsidian 内嵌 / 无图”时显示。
  show(document.getElementById("imageRefOptions"),
    options.imageStyle != "noImage" && !options.imageStyle.startsWith("obsidian"));
  // “代码块围栏符号”只在代码块为“围栏式”时显示。
  show(document.getElementById("fence"), options.codeBlockStyle == "fenced");
  // 需要“下载图片”才有意义的选项。
  const downloadImages = !!options.downloadImages;
  show(document.getElementById("imagePrefix"), downloadImages);
  ['markdown', 'base64', 'obsidian', 'obsidian-nofolder'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !downloadImages;
  });
  // AI 优化：总开关开启才显示具体能力选项。
  show(document.getElementById("aiOptionsBlock"), !!options.aiEnabled);
  // 翻译开启才显示目标语言。
  show(document.getElementById("aiTargetLangWrap"), !!options.aiEnabled && !!options.aiTranslate);
};

const inputChange = (e) => {
  if (!e || !e.target) return;
  const key = e.target.name;
  if (!key) return;
  let value = e.target.value;
  if (key == "import-file") {
    const fr = new FileReader();
    fr.onload = (ev) => {
      try {
        options = JSON.parse(ev.target.result);
        setCurrentChoice(options);
        rebuildMenus();
        save();
      } catch (err) {
        document.querySelectorAll(".status").forEach(s => {
          s.textContent = "导入失败：" + err.message;
          s.classList.remove('success'); s.classList.add('error'); s.style.opacity = 1;
        });
      }
    };
    fr.readAsText(e.target.files[0]);
  } else if (key == "folderPreset") {
    // 文件夹预设卡片：直接落 mdClipsFolder 并保存。
    handleFolderPreset(String(value));
  } else if (key == "deepseekKey") {
    // DeepSeek Key 仅存本机（storage.local），不回显明文、不入 sync/导出。
    const DOTS = '••••••••';
    const el = e.target;
    let v = String(value || '').trim();
    const hasKey = el.dataset.has === '1';
    if (hasKey && v === DOTS) return; // 未改动，保留已存 Key
    if (hasKey && v.startsWith(DOTS)) v = v.slice(DOTS.length).trim(); // 已打码后继续输入：只取新输入
    if (!v) { // 清空 → 删除本机 Key
      browser.storage.local.remove('deepseekKey').catch(() => {});
      el.dataset.has = '0';
      return;
    }
    browser.storage.local.set({ deepseekKey: v }).catch((err) => console.error(err));
    el.dataset.has = '1';
    el.value = DOTS; // 存后立即打码
  } else if (key == "aiEnabled") {
    options[key] = !!e.target.checked;
    save();
    refereshElements();
  } else {
    if (e.target.type == "checkbox") value = e.target.checked;
    options[key] = value;
    // 关闭“下载图片”时，若样式要求本地图片，则自动回退到“原图地址”。
    if (key == 'downloadImages') options = reconcile(options);
    // 手动输入自定义子目录时，确保“自定义…”卡片保持选中，并刷新预览。
    if (key == 'mdClipsFolder') {
      setCheckedValue(document.querySelectorAll("[name='folderPreset']"), 'custom');
      updatePreview();
    }
    save();
    refereshElements();
  }
};

const inputKeyup = (e) => {
  if (keyupTimeout) clearTimeout(keyupTimeout);
  keyupTimeout = setTimeout(inputChange, 500, e);
};

const buttonClick = (e) => {
  if (e.target.id == "import") {
    document.getElementById("import-file").click();
  } else if (e.target.id == "export") {
    exportOptions();
  } else if (e.target.id == "keySave") {
    const el = document.querySelector("[name='deepseekKey']");
    if (el) {
      // 若已是打码占位（已存且未改动），无需重复写入。
      if (!(el.dataset.has === '1' && el.value === '••••••••')) {
        inputChange({ target: el });
      }
      flashStatus('API Key 已保存到本机 🔒');
    }
  }
};

function exportOptions() {
  const json = JSON.stringify(options, null, 2);
  const blob = new Blob([json], { type: "text/json" });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const pad = (n) => ("0" + n).slice(-2);
  const datestring = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const filename = `MarkDownload-export-${datestring}.json`;
  if (browser.downloads && browser.downloads.download) {
    browser.downloads.download({ url, saveAs: true, filename }).catch(() => fallbackSave(url, filename));
  } else {
    fallbackSave(url, filename);
  }
}

// 极少数环境无 Downloads API 时的兜底：用 <a download> 触发。
function fallbackSave(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 100);
}

// 顶部标签页切换（基础 / 图片 / 格式 / AI 优化）。
const initTabs = () => {
  const tabs = document.querySelectorAll('.tab');
  const panes = document.querySelectorAll('.tab-pane');
  if (!tabs.length) return;
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      panes.forEach(p => p.classList.toggle('active', p.id === 'pane-' + tab.dataset.tab));
      const body = document.querySelector('.panel-body');
      if (body) body.scrollTop = 0;
    });
  });
};

const loaded = () => {
  initTabs();
  restoreOptions();

  document.querySelectorAll('input,textarea,button').forEach(input => {
    if (input.tagName == "TEXTAREA" || input.type == "text") {
      input.addEventListener('keyup', inputKeyup);
    } else if (input.tagName == "BUTTON") {
      input.addEventListener('click', buttonClick);
    } else {
      input.addEventListener('change', inputChange);
    }
  });

  // DeepSeek Key 输入框：回车即失焦触发 change → 自动存本机。
  const keyEl = document.querySelector("[name='deepseekKey']");
  if (keyEl) {
    keyEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        keyEl.blur();
        flashStatus('API Key 已保存到本机 🔒');
      }
    });
  }
};

document.addEventListener("DOMContentLoaded", loaded);
document.querySelectorAll(".save").forEach(el => el.addEventListener("click", saveOptions));
document.querySelectorAll(".status").forEach(el => el.addEventListener("click", hideStatus));
document.querySelectorAll(".input-sizer > textarea").forEach(el => el.addEventListener("input", function () { sizeTextarea(this); }));

// ---- 单选工具 ----
function getCheckedValue(radioObj) {
  if (!radioObj) return "";
  const radioLength = radioObj.length;
  if (radioLength == undefined) return radioObj.checked ? radioObj.value : "";
  for (let i = 0; i < radioLength; i++) {
    if (radioObj[i].checked) return radioObj[i].value;
  }
  return "";
}

function setCheckedValue(radioObj, newValue) {
  if (!radioObj) return;
  const radioLength = radioObj.length;
  if (radioLength == undefined) {
    radioObj.checked = (radioObj.value == newValue.toString());
    return;
  }
  for (let i = 0; i < radioLength; i++) {
    radioObj[i].checked = (radioObj[i].value == newValue.toString());
  }
}
