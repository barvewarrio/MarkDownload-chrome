/*
 * 离屏转换引擎（MV3）。
 *
 * MV3 后台 service worker 没有 DOM，而 HTML→Markdown 流水线（DOMParser、
 * Readability、Turndown 节点手术、图片的 XHR/FileReader）需要真实 DOM，
 * 因此这部分逻辑放在这个隐藏的离屏文档里，由 service worker 通过运行时消息驱动。
 *
 * 对外暴露的动作（service worker 用 browser.runtime.sendMessage 调用）：
 *   { action: "clip", dom, selection?, clipSelection? }
 *     -> { markdown, article, imageList, mdClipsFolder }
 *        完整流水线：解析 DOM → Readability 提取正文 → 转换 → 生成标题与
 *        mdClipsFolder。若 clipSelection 且有选中区，则只剪选中区。
 *   { action: "convertLink", dom, html }
 *     -> { markdown }   （Readability 提取 + 对任意 HTML 片段做 Turndown，
 *                        用于“把链接复制为 Markdown”）
 *   { action: "formatObsidianFolder", article } -> { folder }
 *
 * 以下代码均从 MV2 background.js 的转换半区移植而来。
 *
 * 重要：MV3 的离屏文档只暴露 messaging、没有 chrome.storage（chrome.storage.sync/
 * local 均为 undefined）。因此这里【不自读设置】——options 与 DeepSeek Key 都由
 * service worker 读好、随每条消息下发（见 background.js 的 offscreen() 助手）。
 */

const defaultOptions = {
  headingStyle: "atx", hr: "___", bulletListMarker: "-", codeBlockStyle: "fenced",
  fence: "```", emDelimiter: "_", strongDelimiter: "**", linkStyle: "inlined",
  linkReferenceStyle: "full", imageStyle: "markdown", imageRefStyle: "inlined",
  frontmatter: "---\ncreated: {date:YYYY-MM-DDTHH:mm:ss} (UTC {date:Z})\ntags: [{keywords}]\nsource: {baseURI}\nauthor: {byline}\n---\n\n# {pageTitle}\n\n> ## 摘要\n> {excerpt}\n\n---",
  backmatter: "", title: "{pageTitle}", includeTemplate: false, saveAs: false,
  downloadImages: false, imagePrefix: '{pageTitle}/', mdClipsFolder: "",
  disallowedChars: '[]#^', turndownEscape: true,
  contextMenus: true, obsidianIntegration: false, obsidianVault: "", obsidianFolder: "剪藏/",
  aiEnabled: false, aiClean: true, aiTags: false, aiSummary: false, aiTranslate: false, aiTargetLang: ""
};

// 把 SW 下发的 options 与默认值合并成一份“本动作专用”的拷贝。
// 离屏文档可能同时处理多个动作（并发），各自持有独立对象，避免互相污染；
// 消息里没带 options（如极端直连场景）时退化为纯默认值。
function resolveOptions(msgOptions) {
  const merged = { ...defaultOptions, ...(msgOptions || {}) };
  if (!merged.obsidianFolder) { merged.obsidianFolder = '剪藏/'; }
  return merged;
}

// ---------------------------------------------------------------------------
// 转换引擎 —— 从 MV2 background.js 原样移植
// ---------------------------------------------------------------------------

TurndownService.prototype.defaultEscape = TurndownService.prototype.escape;

function turndown(content, options, article) {
  if (options.turndownEscape) TurndownService.prototype.escape = TurndownService.prototype.defaultEscape;
  else TurndownService.prototype.escape = s => s;

  var turndownService = new TurndownService(options);
  turndownService.use(turndownPluginGfm.gfm);
  turndownService.keep(['iframe', 'sub', 'sup', 'u', 'ins', 'del', 'small', 'big']);

  let imageList = {};
  turndownService.addRule('images', {
    filter: function (node) {
      if (node.nodeName == 'IMG' && node.getAttribute('src')) {
        let src = node.getAttribute('src');
        node.setAttribute('src', validateUri(src, article.baseURI));
        if (options.downloadImages) {
          let imageFilename = getImageFilename(src, options, false);
          if (!imageList[src] || imageList[src] != imageFilename) {
            let i = 1;
            while (Object.values(imageList).includes(imageFilename)) {
              const parts = imageFilename.split('.');
              if (i == 1) parts.splice(parts.length - 1, 0, i++);
              else parts.splice(parts.length - 2, 1, i++);
              imageFilename = parts.join('.');
            }
            imageList[src] = imageFilename;
          }
          const obsidianLink = options.imageStyle.startsWith("obsidian");
          const localSrc = options.imageStyle === 'obsidian-nofolder'
            ? imageFilename.substring(imageFilename.lastIndexOf('/') + 1)
            : imageFilename.split('/').map(s => obsidianLink ? s : encodeURI(s)).join('/');
          if (options.imageStyle != 'originalSource' && options.imageStyle != 'base64') node.setAttribute('src', localSrc);
          return true;
        }
        else return true;
      }
      return false;
    },
    replacement: function (content, node) {
      if (options.imageStyle == 'noImage') return '';
      else if (options.imageStyle.startsWith('obsidian')) return `![[${node.getAttribute('src')}]]`;
      else {
        var alt = cleanAttribute(node.getAttribute('alt'));
        var src = node.getAttribute('src') || '';
        var title = cleanAttribute(node.getAttribute('title'));
        var titlePart = title ? ' "' + title + '"' : '';
        if (options.imageRefStyle == 'referenced') {
          var id = this.references.length + 1;
          this.references.push('[fig' + id + ']: ' + src + titlePart);
          return '![' + alt + '][fig' + id + ']';
        }
        else return src ? '![' + alt + '](' + src + titlePart + ')' : '';
      }
    },
    references: [],
    append: function (options) {
      var references = '';
      if (this.references.length) {
        references = '\n\n' + this.references.join('\n') + '\n\n';
        this.references = [];
      }
      return references;
    }
  });

  turndownService.addRule('links', {
    filter: (node) => {
      if (node.nodeName == 'A' && node.getAttribute('href')) {
        const href = node.getAttribute('href');
        node.setAttribute('href', validateUri(href, article.baseURI));
        return options.linkStyle == 'stripLinks';
      }
      return false;
    },
    replacement: (content, node) => content
  });

  turndownService.addRule('mathjax', {
    filter(node) { return article.math.hasOwnProperty(node.id); },
    replacement(content, node) {
      const math = article.math[node.id];
      let tex = math.tex.trim().replaceAll(' ', '');
      if (math.inline) { tex = tex.replaceAll('\n', ' '); return `$${tex}$`; }
      else return `$$\n${tex}\n$$`;
    }
  });

  function repeat(character, count) { return Array(count + 1).join(character); }

  function convertToFencedCodeBlock(node, options) {
    node.innerHTML = node.innerHTML.replaceAll('<br-keep></br-keep>', '<br>');
    const langMatch = node.id && node.id.match(/code-lang-(.+)/);
    const language = langMatch && langMatch.length > 0 ? langMatch[1] : '';
    var code;
    if (language) {
      var div = document.createElement('div');
      document.body.appendChild(div);
      div.appendChild(node);
      code = node.innerText;
      div.remove();
    } else {
      code = node.innerHTML;
    }
    var fenceChar = options.fence.charAt(0);
    var fenceSize = 3;
    var fenceInCodeRegex = new RegExp('^' + fenceChar + '{3,}', 'gm');
    var match;
    while ((match = fenceInCodeRegex.exec(code))) {
      if (match[0].length >= fenceSize) { fenceSize = match[0].length + 1; }
    }
    var fence = repeat(fenceChar, fenceSize);
    return ('\n\n' + fence + language + '\n' + code.replace(/\n$/, '') + '\n' + fence + '\n\n');
  }

  turndownService.addRule('fencedCodeBlock', {
    filter: function (node, o) {
      return (o.codeBlockStyle === 'fenced' && node.nodeName === 'PRE' &&
        node.firstChild && node.firstChild.nodeName === 'CODE');
    },
    replacement: function (content, node, o) { return convertToFencedCodeBlock(node.firstChild, o); }
  });

  turndownService.addRule('pre', {
    filter: (node) => node.nodeName == 'PRE' && (!node.firstChild || node.firstChild.nodeName != 'CODE'),
    replacement: (content, node, o) => { return convertToFencedCodeBlock(node, o); }
  });

  let markdown = options.frontmatter + turndownService.turndown(content) + options.backmatter;

  // 剔除 CodeMirror 会显示为红点的不可打印特殊字符
  // （用 \u 转义字符串构造正则，因为正则字面量不解析 \uXXXX，
  //   且源码里不允许出现原始控制字节）
  const specialCharsPattern = new RegExp('[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\ufeff\ufff9-\ufffc]', 'g');
  markdown = markdown.replace(specialCharsPattern, '');

  return { markdown: markdown, imageList: imageList };
}

function cleanAttribute(attribute) { return attribute ? attribute.replace(/(\n+\s*)+/g, '\n') : ''; }

function validateUri(href, baseURI) {
  try { new URL(href); }
  catch {
    const baseUri = new URL(baseURI);
    if (href.startsWith('/')) { href = baseUri.origin + href; }
    else { href = baseUri.href + (baseUri.href.endsWith('/') ? '/' : '') + href; }
  }
  return href;
}

function getImageFilename(src, options, prependFilePath = true) {
  const slashPos = src.lastIndexOf('/');
  const queryPos = src.indexOf('?');
  let filename = src.substring(slashPos + 1, queryPos > 0 ? queryPos : src.length);
  let imagePrefix = (options.imagePrefix || '');
  if (prependFilePath && options.title.includes('/')) {
    imagePrefix = options.title.substring(0, options.title.lastIndexOf('/') + 1) + imagePrefix;
  }
  else if (prependFilePath) {
    imagePrefix = options.title + (imagePrefix.startsWith('/') ? '' : '/') + imagePrefix;
  }
  if (filename.includes(';base64,')) {
    filename = 'image.' + filename.substring(0, filename.indexOf(';'));
  }
  let extension = filename.substring(filename.lastIndexOf('.'));
  if (extension == filename) {
    filename = filename + '.idunno';
  }
  filename = generateValidFileName(filename, options.disallowedChars);
  return imagePrefix + filename;
}

function textReplace(string, article, disallowedChars = null) {
  for (const key in article) {
    if (article.hasOwnProperty(key) && key != "content") {
      let s = (article[key] || '') + '';
      if (s && disallowedChars) s = generateValidFileName(s, disallowedChars);
      string = string.replace(new RegExp('{' + key + '}', 'g'), s)
        .replace(new RegExp('{' + key + ':kebab}', 'g'), s.replace(/ /g, '-').toLowerCase())
        .replace(new RegExp('{' + key + ':snake}', 'g'), s.replace(/ /g, '_').toLowerCase())
        .replace(new RegExp('{' + key + ':camel}', 'g'), s.replace(/ ./g, (str) => str.trim().toUpperCase()).replace(/^./, (str) => str.toLowerCase()))
        .replace(new RegExp('{' + key + ':pascal}', 'g'), s.replace(/ ./g, (str) => str.trim().toUpperCase()).replace(/^./, (str) => str.toUpperCase()));
    }
  }
  const now = new Date();
  const dateMatches = string.match(/{date:(.+?)}/g);
  if (dateMatches && dateMatches.forEach) {
    dateMatches.forEach(match => {
      const format = match.substring(6, match.length - 1);
      string = string.replaceAll(match, moment(now).format(format));
    });
  }
  const keywordMatches = string.match(/{keywords:?(.*)?}/g);
  if (keywordMatches && keywordMatches.forEach) {
    keywordMatches.forEach(match => {
      let seperator = match.substring(10, match.length - 1);
      try { seperator = JSON.parse(JSON.stringify(seperator).replace(/\\\\/g, '\\')); } catch (e) { }
      string = string.replace(new RegExp(match.replace(/\\/g, '\\\\'), 'g'), (article.keywords || []).join(seperator));
    });
  }
  string = string.replace(/{(.*?)}/g, '');
  return string;
}

async function convertArticleToMarkdown(article, options, downloadImages = null) {
  if (downloadImages != null) { options.downloadImages = downloadImages; }
  if (options.includeTemplate) {
    options.frontmatter = textReplace(options.frontmatter, article) + '\n';
    options.backmatter = '\n' + textReplace(options.backmatter, article);
  } else {
    options.frontmatter = options.backmatter = '';
  }
  options.imagePrefix = textReplace(options.imagePrefix, article, options.disallowedChars)
    .split('/').map(s => generateValidFileName(s, options.disallowedChars)).join('/');
  let result = turndown(article.content, options, article);
  if (options.downloadImages) {
    result = await preDownloadImages(result.imageList, result.markdown, options);
  }
  return result;
}

function generateValidFileName(title, disallowedChars = null) {
  if (!title) return title;
  else title = title + '';
  // 去掉文件名中的 < > : " / \ | ? *
  var illegalRe = /[\/\?<>\\:\*\|":]/g;
  var name = title.replace(illegalRe, "").replace(/ /g, ' ');
  if (disallowedChars) {
    for (let c of disallowedChars) {
      if (`[\\^$.|?*+()`.includes(c)) c = `\\${c}`;
      name = name.replace(new RegExp(c, 'g'), '');
    }
  }
  return name;
}

async function preDownloadImages(imageList, markdown, options) {
  let newImageList = {};
  await Promise.all(Object.entries(imageList).map(([src, filename]) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', src);
    xhr.responseType = "blob";
    xhr.onload = async function () {
      const blob = xhr.response;
      if (options.imageStyle == 'base64') {
        var reader = new FileReader();
        reader.onloadend = function () {
          markdown = markdown.replaceAll(src, reader.result);
          resolve();
        };
        reader.readAsDataURL(blob);
      } else {
        let newFilename = filename;
        if (newFilename.endsWith('.idunno')) {
          newFilename = filename.replace('.idunno', '.' + mimedb[blob.type]);
          if (!options.imageStyle.startsWith("obsidian")) {
            markdown = markdown.replaceAll(filename.split('/').map(s => encodeURI(s)).join('/'), newFilename.split('/').map(s => encodeURI(s)).join('/'));
          } else {
            markdown = markdown.replaceAll(filename, newFilename);
          }
        }
        const blobUrl = URL.createObjectURL(blob);
        newImageList[blobUrl] = newFilename;
        resolve();
      }
    };
    xhr.onerror = function () { reject('A network error occurred attempting to download ' + src); };
    xhr.send();
  })));
  return { imageList: newImageList, markdown: markdown };
}

async function getArticleFromDom(domString) {
  const parser = new DOMParser();
  const dom = parser.parseFromString(domString, "text/html");
  if (dom.documentElement.nodeName == "parsererror") { console.error("error while parsing"); }

  const math = {};
  const storeMathInfo = (el, mathInfo) => {
    let randomId = URL.createObjectURL(new Blob([]));
    randomId = randomId.substring(randomId.length - 36);
    el.id = randomId;
    math[randomId] = mathInfo;
  };

  dom.body.querySelectorAll('script[id^=MathJax-Element-]')?.forEach(mathSource => {
    const type = mathSource.attributes.type ? mathSource.attributes.type.value : '';
    storeMathInfo(mathSource, { tex: mathSource.innerText, inline: type ? !type.includes('mode=display') : false });
  });

  dom.body.querySelectorAll('[markdownload-latex]')?.forEach(mathJax3Node => {
    const tex = mathJax3Node.getAttribute('markdownload-latex');
    const display = mathJax3Node.getAttribute('display');
    const inline = !(display && display === 'true');
    const mathNode = document.createElement(inline ? "i" : "p");
    mathNode.textContent = tex;
    mathJax3Node.parentNode.insertBefore(mathNode, mathJax3Node.nextSibling);
    mathJax3Node.parentNode.removeChild(mathJax3Node);
    storeMathInfo(mathNode, { tex: tex, inline: inline });
  });

  dom.body.querySelectorAll('.katex-mathml')?.forEach(kaTeXNode => {
    storeMathInfo(kaTeXNode, { tex: kaTeXNode.querySelector('annotation').textContent, inline: true });
  });

  dom.body.querySelectorAll('[class*=highlight-text],[class*=highlight-source]')?.forEach(codeSource => {
    const language = codeSource.className.match(/highlight-(?:text|source)-([a-z0-9]+)/)?.[1];
    if (codeSource.firstChild && codeSource.firstChild.nodeName == "PRE") {
      codeSource.firstChild.id = `code-lang-${language}`;
    }
  });

  dom.body.querySelectorAll('[class*=language-]')?.forEach(codeSource => {
    const language = codeSource.className.match(/language-([a-z0-9]+)/)?.[1];
    codeSource.id = `code-lang-${language}`;
  });

  dom.body.querySelectorAll('pre br')?.forEach(br => {
    br.outerHTML = '<br-keep></br-keep>';
  });

  dom.body.querySelectorAll('.codehilite > pre')?.forEach(codeSource => {
    if (codeSource.firstChild && codeSource.firstChild.nodeName !== 'CODE' && !codeSource.className.includes('language')) {
      codeSource.id = `code-lang-text`;
    }
  });

  dom.body.querySelectorAll('h1, h2, h3, h4, h5, h6')?.forEach(header => {
    header.className = '';
    header.outerHTML = header.outerHTML;
  });

  const article = new Readability(dom).parse();
  article.baseURI = dom.baseURI;
  article.pageTitle = dom.title;
  const url = new URL(dom.baseURI);
  article.hash = url.hash; article.host = url.host; article.origin = url.origin;
  article.hostname = url.hostname; article.pathname = url.pathname; article.port = url.port;
  article.protocol = url.protocol; article.search = url.search;

  if (dom.head) {
    article.keywords = dom.head.querySelector('meta[name="keywords"]')?.content?.split(',')?.map(s => s.trim());
    dom.head.querySelectorAll('meta[name][content], meta[property][content]')?.forEach(meta => {
      const key = (meta.getAttribute('name') || meta.getAttribute('property'));
      const val = meta.getAttribute('content');
      if (key && val && !article[key]) { article[key] = val; }
    });
  }

  article.math = math;
  return article;
}

// ---------------------------------------------------------------------------
// DeepSeek AI 优化
// ---------------------------------------------------------------------------
// 剪藏保存 / 发送前，可按设置让 DeepSeek 整理文本（去乱码 / 重排标题 / 统一
// 格式，可选自动打标签、生成摘要、翻译）。API Key 由用户在本机设置，仅存
// storage.local，绝不同步云端、不入导出；请求直发 DeepSeek。
// 任何失败都保留原文，绝不让 AI 问题弄丢剪藏内容。

// DeepSeek Key 由 service worker 读好随消息下发（离屏文档读不到 storage.local），
// 见 aiPolish 动作处理与 background.js 的 offscreen() 助手。这里只做安全转字符串。

// 消息入口统一收口：优先 chrome.runtime（MV3 Promise），兜底 browser.runtime。
function runtimeOnMessage() {
  if (chrome.runtime && chrome.runtime.onMessage) return chrome.runtime.onMessage;
  if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.onMessage) return browser.runtime.onMessage;
  throw new Error('当前环境没有可用的 runtime.onMessage');
}

// 是否需要真的请求 AI（总开关 + 至少一项能力开启）。
function aiWanted(options) {
  return !!(options.aiEnabled &&
    (options.aiClean || options.aiTags || options.aiSummary || options.aiTranslate));
}

function buildAiSystemPrompt(options) {
  const parts = [];
  const lang = (options.aiTargetLang || '').trim() || '简体中文';

  parts.push(
    '你是一名专业的 Markdown 文档整理助手。下面“原文”是一段网页剪藏得到的 Markdown，' +
    '可能含有乱码、错乱的标题层级、多余空行、混用的项目符号。'
  );

  if (options.aiClean) {
    parts.push(
      '【基础整理】① 只清理明显因编码损坏产生的乱码（如 ????、锟斤拷、Ã© 之类），' +
      '绝不删改、概括或臆造原文内容；② 理顺标题层级：首个标题用 #，其后逐级且不跳级，去掉空标题；' +
      '③ 统一格式：列表符统一用 -、分隔线统一用 ---、代码块统一用 ```、段落间空一行；' +
      '④ 保留原文全部信息与先后顺序。图片引用（![](…) 的路径与文件名）、链接、代码块、表格的文本必须原样保留，不得改写。'
    );
  }

  const extras = [];
  if (options.aiSummary) {
    extras.push(
      '在正文开头（第一个标题之后）插入块引用形式的摘要：`> **摘要：** 用两到三句话概括全文核心`。' +
      '若原文已自带摘要或导语，可凝练后复用，不要重复堆砌。'
    );
  }
  if (options.aiTags) {
    extras.push(
      '在文末空一行后，另起一行输出 3~6 个精准、贴合全文主题的标签，Obsidian 风格：' +
      '一行、以空格分隔、每个标签前加 #（例如 `#浏览器 #Markdown #效率`）。' +
      '不要使用 YAML frontmatter，也不要为标签另起标题。'
    );
  }
  if (options.aiTranslate) {
    extras.push(
      `把正文翻译成${lang}：忠实传达原意，保留 Markdown 结构、代码块、图片引用、链接与专有名词` +
      `（人名、地名、产品名可保留原文）。若同时要求摘要或标签，摘要与标签也用${lang}给出。`
    );
  }
  if (extras.length) parts.push('【附加能力】请一并完成：' + extras.join(''));

  parts.push(
    '只输出处理后的完整 Markdown 本身：不要任何解释、不要包裹代码围栏、不要遗漏正文任何部分、' +
    '不要添加原文没有的信息。'
  );
  return parts.join('\n');
}

// 屏蔽错误信息里可能夹带的 Key 明文（如 sk-xxx / Bearer …），只留安全摘要。
function safeAiError(err) {
  const raw = String((err && err.message) || err || 'AI 请求失败');
  return raw
    .replace(/Bearer\s+\S+/gi, 'Bearer •••')
    .replace(/sk-[A-Za-z0-9_-]+/gi, 'sk-•••')
    .slice(0, 300);
}

// 调用 DeepSeek 整理一段 markdown。任何失败都保留原文并给出原因，
// 绝不因 AI 问题弄丢剪藏内容。
// 返回 { ok, markdown, error? }：
//   ok === true   请求已成功处理；markdown 为结果（applied=true 表示确有改动）
//   ok === false  未整理（Key 缺失 / 网络 / 接口 / 超时）；markdown 恒为原文，error 为原因
async function aiPolish(markdown, options, key) {
  const text = String(markdown || '');
  if (!text.trim()) return { ok: true, markdown: text, applied: false };

  if (!key) {
    console.warn('AI 优化跳过：未配置 DeepSeek API Key');
    return { ok: false, markdown: text, error: '未配置 DeepSeek API Key（请到 ⚙️ 设置 → AI 优化 填写）' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: buildAiSystemPrompt(options) },
          { role: 'user', content: '原文：\n' + text },
        ],
        temperature: 0.1,
        max_tokens: 8192,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let msg;
      if (res.status === 401 || res.status === 403) {
        msg = 'DeepSeek 认证失败：API Key 无效或已过期';
      } else if (res.status === 402 || res.status === 429) {
        msg = 'DeepSeek 账户余额不足或请求过频（HTTP ' + res.status + '）';
      } else if (res.status >= 500) {
        msg = 'DeepSeek 服务暂时不可用（HTTP ' + res.status + '），请稍后重试';
      } else {
        msg = 'DeepSeek 返回错误（HTTP ' + res.status + '）：' + body.slice(0, 120);
      }
      throw new Error(msg);
    }
    const data = await res.json();
    const out = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    if (!out) throw new Error('DeepSeek 返回为空，请重试');
    const trimmed = String(out).trim();
    return { ok: true, markdown: trimmed || text, applied: trimmed !== text };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      console.warn('AI 优化超时（>90 秒），保留原文');
      return { ok: false, markdown: text, error: 'AI 请求超时（>90 秒），已保留原文' };
    }
    console.warn('AI 优化失败，保留原文：', safeAiError(err));
    return { ok: false, markdown: text, error: safeAiError(err) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
runtimeOnMessage().addListener((message) => {
  if (!message || typeof message.action !== 'string') return undefined;

  if (message.action === 'clip') {
    return (async () => {
      try {
        const options = resolveOptions(message.options);
        const article = await getArticleFromDom(message.dom);
        if (message.selection && message.clipSelection) {
          article.content = message.selection;
        }
        const { markdown, imageList } = await convertArticleToMarkdown(article, options);
        article.title = await formatTitle(article, options);
        const mdClipsFolder = await formatMdClipsFolder(article, options);
        // 离屏「clip」只产出【原始】Markdown，供弹窗即时预览 / 后续保存使用。
        // 自动 AI 整理不放在这里：否则每次打开弹窗的自动剪藏都会先等一次慢速
        // DeepSeek 请求，预览还会被模型改写（标题超长等）。自动整理由 service
        // worker 在真正保存（下载 / 发 Obsidian）前调用 aiPolish 动作执行。
        return { ok: true, markdown: markdown, article: article, imageList: imageList, mdClipsFolder: mdClipsFolder };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    })();
  }

  if (message.action === 'convertLink') {
    return (async () => {
      try {
        const article = await getArticleFromDom(message.dom);
        const options = resolveOptions(message.options);
        options.frontmatter = options.backmatter = '';
        options.downloadImages = false;
        const { markdown } = turndown(message.html, options, article);
        return { ok: true, markdown: markdown };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    })();
  }

  if (message.action === 'formatObsidianFolder') {
    return (async () => {
      try {
        const options = resolveOptions(message.options);
        const folder = await formatObsidianFolder(message.article, options);
        return { ok: true, folder: folder };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    })();
  }

  // 轻量动作：为给定的 DOM 字符串生成格式化标题 + 页面元信息，
  // 供“把标签页复制为 markdown 链接”一类使用（只需要标题）。
  if (message.action === 'titleForDom') {
    return (async () => {
      try {
        const article = await getArticleFromDom(message.dom);
        const options = resolveOptions(message.options);
        const title = await formatTitle(article, options);
        return { ok: true, title: title, pageTitle: article.pageTitle, baseURI: article.baseURI };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    })();
  }

  // 弹窗「✨ AI 优化」手动按钮：对当前编辑区文本加工一次。
  // 未开启 / 失败时原样返回，绝不丢内容。
  if (message.action === 'aiPolish') {
    return (async () => {
      try {
        const options = resolveOptions(message.options);
        const input = String(message.markdown || '');
        if (!aiWanted(options)) {
          return { ok: true, markdown: input, applied: false, reason: 'disabled' };
        }
        const out = await aiPolish(input, options, message.deepseekKey);
        if (out.ok) return { ok: true, markdown: out.markdown, applied: out.applied };
        // 请求失败（Key 缺失 / 网络 / 接口 / 超时）：保留原文，附上原因供弹窗提示。
        return { ok: true, markdown: input, applied: false, warning: out.error };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    })();
  }

  // 下载结束后 service worker 请我们释放 blob URL
  // （URL 是在本文档创建的，只有本上下文能 revoke 它）。
  if (message.type === 'md:revokeBlob' && message.url) {
    try { URL.revokeObjectURL(message.url); } catch (e) { /* 忽略 */ }
    return { ok: true };
  }

  // 剪贴板兜底（内容脚本所在世界写剪贴板失败时，由 service worker 调用）。
  // 在本聚焦文档里，配合 clipboardWrite 权限 navigator.clipboard.writeText 可用。
  if (message.action === 'clipboardWrite') {
    return (async () => {
      try {
        await navigator.clipboard.writeText(message.text);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    })();
  }

  // 为 .md 文件与图片生成 blob URL，然后交给 SERVICE WORKER 去下载。
  // 离屏文档里 downloads API 不可用（此处 chrome.downloads 是 undefined），
  // 但 URL.createObjectURL 可用——而 service worker 恰好相反（有
  // chrome.downloads、缺 URL.createObjectURL）。所以本文档只负责造 blob URL，
  // chrome.downloads.download 在 worker 里执行。
  if (message.action === 'doDownload') {
    return (async () => {
      try {
        // .md 文件本身的 blob。
        const mdUrl = URL.createObjectURL(new Blob([message.markdown], { type: 'text/markdown;charset=utf-8' }));

        // 每张图片已在 preDownloadImages 阶段生成了 blob URL。
        // 文件名保持原样；文件夹前缀在 worker 侧拼接。
        const images = message.imageList || {};
        const imageEntries = Object.entries(images).map(([src, filename]) => ({
          url: src,
          filename: String(filename),
          isBlob: true,
        }));

        return { ok: true, mdUrl, imageEntries };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    })();
  }

  return undefined;
});

async function formatTitle(article, options) {
  let title = textReplace(options.title, article, options.disallowedChars + '/');
  title = title.split('/').map(s => generateValidFileName(s, options.disallowedChars)).join('/');
  return title;
}

async function formatMdClipsFolder(article, options) {
  let mdClipsFolder = '';
  if (options.mdClipsFolder) {
    mdClipsFolder = textReplace(options.mdClipsFolder, article, options.disallowedChars);
    mdClipsFolder = mdClipsFolder.split('/').map(s => generateValidFileName(s, options.disallowedChars)).join('/');
    if (!mdClipsFolder.endsWith('/')) mdClipsFolder += '/';
  }
  return mdClipsFolder;
}

async function formatObsidianFolder(article, options) {
  let obsidianFolder = '';
  if (options.obsidianFolder) {
    obsidianFolder = textReplace(options.obsidianFolder, article, options.disallowedChars);
    obsidianFolder = obsidianFolder.split('/').map(s => generateValidFileName(s, options.disallowedChars)).join('/');
    if (!obsidianFolder.endsWith('/')) obsidianFolder += '/';
  }
  return obsidianFolder;
}
