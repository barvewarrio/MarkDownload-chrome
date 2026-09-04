/*
 * MarkDownload MV3 — content script.
 *
 * Runs in the page's isolated world (declared in the manifest; also injected on
 * demand by the service worker for tabs that predate the install). Its jobs:
 *   - respond to md:getClipData with the page/selection outerHTML + baseURI
 *   - respond to md:copy by writing text to the clipboard
 *
 * Uses raw chrome.* (MV3 promise APIs); no polyfill is loaded in this context.
 * Repeated injection is guarded via a window marker.
 */
(function () {
  if (window.__markdownloadInjected) return;
  window.__markdownloadInjected = true;

  // -------------------------------------------------------------------------
  // Scrape helpers (reused from the MV2 content script)
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
      // Fallback: hidden textarea + execCommand.
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
  // Message handlers
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

  // Inject the tiny page-context helper (used to mark MathJax source nodes).
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('contentScript/pageContext.js');
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { /* ignore */ }
})();
