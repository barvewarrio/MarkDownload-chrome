/*
 * Offscreen conversion engine (MV3).
 *
 * The MV3 background service worker has no DOM. The HTML→Markdown pipeline
 * (DOMParser, Readability, Turndown node surgery, XHR/FileReader for images)
 * needs a real DOM, so it lives in this hidden offscreen document. The service
 * worker drives it over runtime messages.
 *
 * Exposed actions (browser.runtime.sendMessage from the service worker):
 *   { action: "clip", dom, selection?, clipSelection? }
 *     -> { markdown, article, imageList, mdClipsFolder }
 *        Full pipeline: parse DOM -> Readability article -> convert -> format
 *        title/mdClipsFolder. If clipSelection && selection, clip the selection.
 *   { action: "convertLink", dom, html }
 *     -> { markdown }   (Readability article + turndown of an arbitrary HTML
 *                        snippet, for "Copy link as Markdown")
 *   { action: "formatObsidianFolder", article } -> { folder }
 *
 * Everything below is ported from the MV2 background.js conversion half with
 * two changes: the libraries load from this document, and getOptions() is a
 * local copy (browser.storage works fine in an offscreen document).
 */

const defaultOptions = {
  headingStyle: "atx", hr: "___", bulletListMarker: "-", codeBlockStyle: "fenced",
  fence: "```", emDelimiter: "_", strongDelimiter: "**", linkStyle: "inlined",
  linkReferenceStyle: "full", imageStyle: "markdown", imageRefStyle: "inlined",
  frontmatter: "---\ncreated: {date:YYYY-MM-DDTHH:mm:ss} (UTC {date:Z})\ntags: [{keywords}]\nsource: {baseURI}\nauthor: {byline}\n---\n\n# {pageTitle}\n\n> ## Excerpt\n> {excerpt}\n\n---",
  backmatter: "", title: "{pageTitle}", includeTemplate: false, saveAs: false,
  downloadImages: false, imagePrefix: '{pageTitle}/', mdClipsFolder: "",
  disallowedChars: '[]#^', turndownEscape: true,
  contextMenus: true, obsidianIntegration: false, obsidianVault: "", obsidianFolder: "剪藏/"
};

async function getOptions() {
  let options = defaultOptions;
  try { options = await browser.storage.sync.get(defaultOptions); } catch (err) { console.error(err); }
  // 未指定 Obsidian 文件夹时默认放进“剪藏/”（storage 里的旧空值也要归一化）。
  if (!options.obsidianFolder) { options.obsidianFolder = '剪藏/'; options = { ...options }; }
  return options;
}

// ---------------------------------------------------------------------------
// Conversion engine — ported verbatim from MV2 background.js
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

  // strip out non-printing special characters CodeMirror shows as red dots
  // (RegExp built from a \u-escaped string, because regex literals do not
  //  interpret \uXXXX and raw control bytes must not appear in the source)
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

async function convertArticleToMarkdown(article, downloadImages = null) {
  const options = await getOptions();
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
    result = await preDownloadImages(result.imageList, result.markdown);
  }
  return result;
}

function generateValidFileName(title, disallowedChars = null) {
  if (!title) return title;
  else title = title + '';
  // remove < > : " / \ | ? *
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

async function preDownloadImages(imageList, markdown) {
  const options = await getOptions();
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
// IPC
// ---------------------------------------------------------------------------
browser.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.action !== 'string') return undefined;

  if (message.action === 'clip') {
    return (async () => {
      try {
        const article = await getArticleFromDom(message.dom);
        if (message.selection && message.clipSelection) {
          article.content = message.selection;
        }
        const { markdown, imageList } = await convertArticleToMarkdown(article);
        article.title = await formatTitle(article);
        const mdClipsFolder = await formatMdClipsFolder(article);
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
        const options = await getOptions();
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
        const folder = await formatObsidianFolder(message.article);
        return { ok: true, folder: folder };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    })();
  }

  // Lightweight: produce a formatted title + page meta for a given DOM string,
  // used by the "copy tab as markdown link" family (which only needs the title).
  if (message.action === 'titleForDom') {
    return (async () => {
      try {
        const article = await getArticleFromDom(message.dom);
        const title = await formatTitle(article);
        return { ok: true, title: title, pageTitle: article.pageTitle, baseURI: article.baseURI };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    })();
  }

  // The service worker asks us to release a blob URL once its download finishes
  // (the URL was created in THIS document, so only this context can revoke it).
  if (message.type === 'md:revokeBlob' && message.url) {
    try { URL.revokeObjectURL(message.url); } catch (e) { /* ignore */ }
    return { ok: true };
  }

  // Clipboard fallback (called by the service worker when the content-script
  // world couldn't write the clipboard). Runs in this focused document where
  // navigator.clipboard.writeText works with the clipboardWrite permission.
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

  // Build blob URLs for the .md file and any images, then hand them to the
  // SERVICE WORKER to download. The downloads API is NOT available in this
  // offscreen document (chrome.downloads is undefined here), but
  // URL.createObjectURL IS — while the service worker is the exact opposite
  // (has chrome.downloads, lacks URL.createObjectURL). So this document only
  // manufactures the blob: URLs; chrome.downloads.download runs in the worker.
  if (message.action === 'doDownload') {
    return (async () => {
      try {
        // Blob for the .md file itself.
        const mdUrl = URL.createObjectURL(new Blob([message.markdown], { type: 'text/markdown;charset=utf-8' }));

        // Each image entry is already a blob: URL created during preDownloadImages.
        // Filenames stay as produced; the folder prefix is applied on the worker.
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

async function formatTitle(article) {
  let options = await getOptions();
  let title = textReplace(options.title, article, options.disallowedChars + '/');
  title = title.split('/').map(s => generateValidFileName(s, options.disallowedChars)).join('/');
  return title;
}

async function formatMdClipsFolder(article) {
  let options = await getOptions();
  let mdClipsFolder = '';
  if (options.mdClipsFolder) {
    mdClipsFolder = textReplace(options.mdClipsFolder, article, options.disallowedChars);
    mdClipsFolder = mdClipsFolder.split('/').map(s => generateValidFileName(s, options.disallowedChars)).join('/');
    if (!mdClipsFolder.endsWith('/')) mdClipsFolder += '/';
  }
  return mdClipsFolder;
}

async function formatObsidianFolder(article) {
  let options = await getOptions();
  let obsidianFolder = '';
  if (options.obsidianFolder) {
    obsidianFolder = textReplace(options.obsidianFolder, article, options.disallowedChars);
    obsidianFolder = obsidianFolder.split('/').map(s => generateValidFileName(s, options.disallowedChars)).join('/');
    if (!obsidianFolder.endsWith('/')) obsidianFolder += '/';
  }
  return obsidianFolder;
}
