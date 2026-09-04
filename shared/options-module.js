// default-options.js 的 ES-module 版本，由 MV3 service worker 与离屏文档的
// 转换引擎引入。这是权威默认值；请与 shared/default-options.js（设置页使用）
// 保持一致。
export const defaultOptions = {
  headingStyle: "atx", hr: "___", bulletListMarker: "-", codeBlockStyle: "fenced",
  fence: "```", emDelimiter: "_", strongDelimiter: "**", linkStyle: "inlined",
  linkReferenceStyle: "full", imageStyle: "markdown", imageRefStyle: "inlined",
  frontmatter: "---\ncreated: {date:YYYY-MM-DDTHH:mm:ss} (UTC {date:Z})\ntags: [{keywords}]\nsource: {baseURI}\nauthor: {byline}\n---\n\n# {pageTitle}\n\n> ## 摘要\n> {excerpt}\n\n---",
  backmatter: "", title: "{pageTitle}", includeTemplate: false, saveAs: false,
  downloadImages: false, imagePrefix: '{pageTitle}/', mdClipsFolder: "",
  disallowedChars: '[]#^', turndownEscape: true,
  contextMenus: true, obsidianIntegration: false, obsidianVault: "", obsidianFolder: "剪藏/",
  // DeepSeek AI 优化（Key 单独存 storage.local，不进此表）
  aiEnabled: false, aiClean: true, aiTags: false, aiSummary: false, aiTranslate: false, aiTargetLang: ""
};

export async function getOptions() {
  let options = defaultOptions;
  try { options = await chrome.storage.sync.get(defaultOptions); } catch (err) { console.error(err); }
  // If the user never chose an Obsidian folder, default clippings into 剪藏/.
  if (!options.obsidianFolder) { options.obsidianFolder = '剪藏/'; options = { ...options }; }
  return options;
}
