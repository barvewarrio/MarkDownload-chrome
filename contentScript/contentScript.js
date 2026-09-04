/*
 * MarkDownload MV3 — 内容脚本。
 *
 * 运行在页面的隔离世界里（在 manifest 中声明；对于安装前就已打开的标签页，
 * 由 service worker 按需注入）。职责：
 *   - 响应 md:getClipData：返回页面/选中区的 outerHTML + baseURI
 *   - 响应 md:copy：把文本写入剪贴板
 *
 * 使用原生 chrome.*（MV3 的 Promise API）；本上下文未加载 polyfill。
 * 通过 window 标记避免重复注入。
 */
(function () {
  if (window.__markdownloadInjected) return;
  window.__markdownloadInjected = true;

  // -------------------------------------------------------------------------
  // 页面抓取辅助（沿用 MV2 内容脚本）
  // -------------------------------------------------------------------------
  function getHTMLOfDocument() {
    let baseEl = document.createElement('base');
    const baseEls = document.head.getElementsByTagName('base');
    if (baseEls.length > 0) baseEl = baseEls[0];
    else document.head.append(baseEl);
    if (!baseEl.getAttribute('href')) baseEl.setAttribute('href', window.location.href);

    removeHiddenNodes(document.body);
    return document.documentElement.outerHTML;
  }

  function removeHiddenNodes(root) {
    let nodeIterator, node;
    nodeIterator = document.createNodeIterator(root, NodeFilter.SHOW_ELEMENT, function (n) {
      const nodeName = n.nodeName.toLowerCase();
      if (nodeName === 'script' || nodeName === 'style' || nodeName === 'noscript' || nodeName === 'math') {
        return NodeFilter.FILTER_REJECT;
      }
      if (n.offsetParent === void 0) return NodeFilter.FILTER_ACCEPT;
      const computedStyle = window.getComputedStyle(n, null);
      if (computedStyle.getPropertyValue('visibility') === 'hidden' || computedStyle.getPropertyValue('display') === 'none') {
        return NodeFilter.FILTER_ACCEPT;
      }
      return NodeFilter.FILTER_SKIP;
    });
    while ((node = nodeIterator.nextNode())) {
      if (node.parentNode instanceof HTMLElement) node.parentNode.removeChild(node);
    }
    return root;
  }

  function getHTMLOfSelection() {
    if (document.selection && document.selection.createRange) {
      return document.selection.createRange().htmlText;
    }
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      let content = '';
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        const div = document.createElement('div');
        div.appendChild(range.cloneContents());
        content += div.innerHTML;
      }
      return content;
    }
    return '';
  }

  function getSelectionAndDom() {
    return {
      selection: getHTMLOfSelection(),
      dom: getHTMLOfDocument(),
      baseURI: document.baseURI,
      pageTitle: document.title,
    };
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // 兜底：隐藏 textarea + execCommand。
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 消息处理
  // -------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return undefined;

    if (message.type === 'md:getClipData') {
      sendResponse(getSelectionAndDom());
      return undefined;
    }

    if (message.type === 'md:copy') {
      copyToClipboard(message.text).then((ok) => sendResponse({ ok: !!ok }));
      return true; // async
    }

    return undefined;
  });

  // 注入一个极小的页面上下文脚本（用于给 MathJax 源码节点打标记）。
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('contentScript/pageContext.js');
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { /* 忽略 */ }
})();
