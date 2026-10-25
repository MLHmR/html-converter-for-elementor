// 带版本号动态加载，URL 与 app.js 一致（?v=HTE_VERSION）→ 复用同一模块实例且随发版刷新缓存。
const { ELEMENTOR_COMPONENTS } = await import(`./elementor-components.js${(typeof window !== "undefined" && window.HTE_BOOT && HTE_BOOT.ver) ? `?v=${encodeURIComponent(HTE_BOOT.ver)}` : ""}`);

const VOID_TAGS = new Set(["AREA", "BASE", "BR", "COL", "EMBED", "HR", "IMG", "INPUT", "LINK", "META", "PARAM", "SOURCE", "TRACK", "WBR"]);
const CONTAINER_TAGS = new Set(["BODY", "MAIN", "SECTION", "ARTICLE", "HEADER", "FOOTER", "NAV", "ASIDE", "DIV", "FIGURE", "FIGCAPTION"]);
// 卡片识别的根标签。<a> 必须在内：整张卡被链接包住是最常见的卡片写法，
// 而图片框/图标框识别原本只认 CONTAINER_TAGS，于是这类卡从来没机会被识别。
const CARD_ROOT_TAGS = new Set([...CONTAINER_TAGS, "A"]);
const FRAMEWORK_CONTAINER_TAGS = new Set([...CONTAINER_TAGS, "FORM", "UL", "OL", "LI", "DL", "DT", "DD", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH", "DETAILS", "SUMMARY", "PICTURE"]);
const SAFE_IFRAME_HOSTS = new Set(["www.youtube.com", "youtube.com", "www.youtube-nocookie.com", "player.vimeo.com"]);
const URL_ATTRIBUTES = ["href", "src", "poster", "action", "formaction", "xlink:href"];
const INTERNAL_MAPPING_ATTRIBUTE = "data-hte-map-id";
const COMPONENT_REGISTRY = new Map(ELEMENTOR_COMPONENTS.map(component => [`${component.schema}:${component.id}`, component]));
// Only these mappings have a verified HTML -> Elementor settings implementation.
// Signature-only suggestions remain available in advanced mode, but must never
// replace a subtree automatically because doing so would discard its content.
const SAFE_AUTOMATIC_COMPONENTS = new Set([
  "widget:form",
  "widget:progress",
  "widget:image-gallery",
  "widget:image-carousel",
  "widget:social-icons",
  "widget:counter",
  "widget:alert",
  "widget:accordion",
  "widget:tabs"
]);
const VERIFIED_ATOMIC_COMPONENTS = new Set(["e-heading", "e-paragraph", "e-button", "e-image"]);
const INLINE_TEXT_TAGS = new Set(["A", "ABBR", "B", "CITE", "CODE", "DEL", "EM", "INS", "KBD", "MARK", "Q", "S", "SMALL", "STRONG", "SUB", "SUP", "TIME", "U", "VAR"]);
// Guards against a stack overflow on pathologically deep DOM; the over-deep subtree is kept as one HTML widget.
const MAX_CONVERT_DEPTH = 500;

function id() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
}

function cleanText(value = "") {
  return value.replace(/\s+/g, " ").trim();
}

function rawMediaSource(node) {
  if (!node) return "";
  const source = node.getAttribute("src");
  // 懒加载：src 是 1 像素占位（data: 小图 / about:blank / 空），真图在 data-src 一类属性里。
  // 原来直接拿 src —— 导入后每张懒加载图都是空白，而这是真实站点最常见的图片写法之一。
  const lazy = node.getAttribute("data-src") || node.getAttribute("data-lazy-src") || node.getAttribute("data-original") || node.getAttribute("data-lazy");
  if (lazy && (!source || /^data:|^about:blank$/i.test(source.trim()))) return lazy;
  if (source) return source;
  const srcset = node.getAttribute("srcset") || "";
  const firstCandidate = srcset.split(",")[0]?.trim().split(/\s+/)[0];
  return firstCandidate || node.currentSrc || "";
}

function isRelativeUrl(value) {
  const url = String(value || "").trim();
  if (!url || url.startsWith("#") || url.startsWith("//")) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(url);
}

function normalizedAssetBaseUrl(value) {
  const base = String(value || "").trim();
  if (!base) return "";
  try {
    const parsed = new URL(base);
    return /^https?:$/i.test(parsed.protocol) ? parsed.href : "";
  } catch {
    return "";
  }
}

function mediaSource(node, options = {}) {
  const source = rawMediaSource(node);
  if (!source) return "";
  const warnings = options.warnings || [];
  const assetUrlMode = options.assetUrlMode || "safe";
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(source)) {
    if (assetUrlMode === "preserve") {
      warning(warnings, "data-media-preserved", "Images use Base64 data URLs; Elementor may not be able to add them to the Media Library on import.");
      return source;
    }
    warning(warnings, "data-media-placeholder", "Base64 images were turned into empty placeholders so the Elementor import does not fail.");
    return "";
  }
  if (/^\/\//.test(source)) {
    warning(warnings, "protocol-relative-media-normalized", "Protocol-relative image URLs were rewritten as absolute https URLs so Elementor can import them.");
    return `https:${source}`;
  }
  if (/^https?:\/\//i.test(source)) return source;
  if (isRelativeUrl(source)) {
    const base = normalizedAssetBaseUrl(options.assetBaseUrl);
    if (assetUrlMode === "resolve" && base) {
      try {
        const resolved = new URL(source, base).href;
        warning(warnings, "relative-media-resolved", "Relative image URLs were completed to absolute URLs using the source site's base URL.");
        return resolved;
      } catch {
        warning(warnings, "relative-media-resolve-failed", "Relative image URLs could not be completed and were turned into empty placeholders.");
        return "";
      }
    }
    if (assetUrlMode === "preserve") {
      warning(warnings, "relative-media-preserved", "Images use relative URLs; on the target site they may point to the wrong path or fail to import.");
      return source;
    }
    warning(warnings, "relative-media-placeholder", "Relative image URLs were turned into empty placeholders so they do not point to the wrong path after import.");
    return "";
  }
  warning(warnings, "unsupported-media-url-placeholder", "Unsupported image URLs were turned into empty placeholders.");
  return "";
}

function mediaCouldProduceUrl(node, options = {}) {
  if (options.imageMode === "placeholder") return false;
  const source = rawMediaSource(node);
  if (!source) return false;
  const assetUrlMode = options.assetUrlMode || "safe";
  if (/^https?:\/\//i.test(source) || /^\/\//.test(source)) return true;
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(source)) return assetUrlMode === "preserve";
  if (isRelativeUrl(source)) return assetUrlMode === "preserve" || (assetUrlMode === "resolve" && Boolean(normalizedAssetBaseUrl(options.assetBaseUrl)));
  return false;
}

function mediaNodes(node) {
  const tag = String(node?.tagName || "").toUpperCase();
  return tag === "IMG" ? [node] : [...node.querySelectorAll("img")];
}

function allMediaCouldProduceUrls(node, options = {}) {
  const images = mediaNodes(node);
  return images.length > 0 && images.every(image => mediaCouldProduceUrl(image, options));
}

function componentAllowedForTarget(component, options) {
  if (!component) return true;
  const target = options.targetComponents || "all";
  if (component.edition === "pro" && target === "core") return false;
  if (component.schema === "atomic" && target !== "all") return false;
  return true;
}

function boundedDescendantText(node, maxLength = 500) {
  const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let value = "";
  while (value.length < maxLength && walker.nextNode()) {
    value += ` ${walker.currentNode.textContent || ""}`;
  }
  return value.slice(0, maxLength);
}

function warning(warnings, code, message, count = 1) {
  const existing = warnings.find(item => item.code === code);
  if (existing) {
    existing.count += count;
    return;
  }
  warnings.push({ code, message, count });
}

function isSafeUrl(value, attribute, node) {
  const url = String(value || "").trim();
  if (!url || url.startsWith("#") || url.startsWith("/") || url.startsWith("./") || url.startsWith("../") || url.startsWith("?")) return true;
  if (url.startsWith("//")) return true;
  if (!url.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/i.test(url)) return true;
  if (/^(?:https?:|mailto:|tel:)/i.test(url)) return true;
  if (attribute === "src" && node.tagName === "IMG" && /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(url)) return true;
  return false;
}

function namespaceDocumentIds(doc, prefix) {
  const idMap = new Map();
  const used = new Set();
  doc.querySelectorAll("[id]").forEach((node, index) => {
    const original = node.id;
    const base = `${prefix}-${original.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "element"}`;
    let replacement = base;
    let suffix = 2;
    while (used.has(replacement)) replacement = `${base}-${suffix++}`;
    used.add(replacement);
    if (!idMap.has(original)) idMap.set(original, replacement);
    node.id = replacement;
  });
  const singleReferences = ["for", "list", "form", "aria-activedescendant"];
  const multiReferences = ["aria-labelledby", "aria-describedby", "aria-controls", "aria-owns", "headers"];
  doc.querySelectorAll("*").forEach(node => {
    singleReferences.forEach(attribute => {
      const value = node.getAttribute(attribute);
      if (value && idMap.has(value)) node.setAttribute(attribute, idMap.get(value));
    });
    multiReferences.forEach(attribute => {
      const value = node.getAttribute(attribute);
      if (!value) return;
      node.setAttribute(attribute, value.split(/\s+/).map(item => idMap.get(item) || item).join(" "));
    });
    [...node.attributes].forEach(attribute => {
      let value = attribute.value;
      if ((attribute.name === "href" || attribute.name === "xlink:href") && value.startsWith("#") && idMap.has(value.slice(1))) {
        node.setAttribute(attribute.name, `#${idMap.get(value.slice(1))}`);
        return;
      }
      idMap.forEach((replacement, original) => {
        value = value.replaceAll(`url(#${original})`, `url(#${replacement})`);
      });
      if (value !== attribute.value) node.setAttribute(attribute.name, value);
    });
  });
  return idMap;
}

function splitCssSelectors(selectorText) {
  const selectors = [];
  let current = "";
  let depth = 0;
  let quote = "";
  for (const char of selectorText) {
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === "(" || char === "[") {
      depth++;
      current += char;
    } else if (char === ")" || char === "]") {
      depth = Math.max(0, depth - 1);
      current += char;
    } else if (char === "," && depth === 0) {
      selectors.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) selectors.push(current.trim());
  return selectors;
}

function rewriteCssSelector(selector, scopeSelector, idMap) {
  let result = selector;
  idMap.forEach((replacement, original) => {
    if (/^[\w-]+$/.test(original)) {
      result = result.replace(new RegExp(`#${original}(?![\\w-])`, "g"), `#${replacement}`);
    }
  });
  const escapedScope = scopeSelector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  result = result.replace(/(^|[\s>+~])(?:html|body|:root)(?=([.#[:\s>+~]|$))/gi, `$1${scopeSelector}`);
  result = result.replace(new RegExp(`${escapedScope}\\s+${escapedScope}`, "g"), scopeSelector).trim();
  return result.startsWith(scopeSelector) ? result : `${scopeSelector} ${result}`;
}

function cssUrlIsSelfContained(value) {
  const url = String(value || "").trim().replace(/^["']|["']$/g, "");
  return url.startsWith("#") || /^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i.test(url);
}

function sanitizeStyleDeclaration(style, warnings) {
  [...style].forEach(property => {
    const value = style.getPropertyValue(property);
    const urls = [...value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].map(match => match[2]);
    // ⚠ 背景图的绝对 https 地址保留，与 <img src> 同一口径（远程图片地址本来就是推荐带过去的）。
    //   原来一律整条删掉：hero 大图、背景图卡片导入后整块没图，而同一张图写成 <img> 就能带过去 —— 口径不一。
    //   追踪请求的顾虑已由渲染框架的 CSP（img-src data: blob:）兜住：保留地址不会触发请求，
    //   计算样式照样能读到 url(...)（已实测）。相对地址和 data: 仍按原规则删。
    const keepBackground = /^background(-image)?$/i.test(property) && urls.every(url => cssUrlIsSelfContained(url) || /^https:\/\//i.test(url));
    if (!keepBackground && urls.some(url => !cssUrlIsSelfContained(url))) {
      style.removeProperty(property);
      warning(warnings, "css-external-url-removed", "External or relative URLs in the CSS were removed to avoid tracking requests and broken resources.");
    }
  });
  if (style.getPropertyValue("position").trim().toLowerCase() === "fixed") {
    const priority = style.getPropertyPriority("position");
    style.setProperty("position", "absolute", priority);
    warning(warnings, "fixed-position-contained", "position: fixed was changed to absolute so imported content cannot cover the whole target page.");
  }
  const zIndex = Number(style.getPropertyValue("z-index"));
  if (Number.isFinite(zIndex) && zIndex > 1000) {
    style.setProperty("z-index", "1000", style.getPropertyPriority("z-index"));
    warning(warnings, "z-index-limited", "Very high z-index values were capped so imported content cannot cover the editor.");
  }
}

function scopeCssText(css, scopeSelector, idMap, warnings) {
  try {
    const imports = css.match(/@import\s+(?:url\([^;]+\)|["'][^"']+["'])[^;]*;/gi) || [];
    if (imports.length) warning(warnings, "css-import-removed", "External CSS @import rules were removed.", imports.length);
    const safeCss = css.replace(/@import\s+(?:url\([^;]+\)|["'][^"']+["'])[^;]*;/gi, "");
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(safeCss);
    const keyframeNames = new Map();
    const collectKeyframes = rules => [...rules].forEach(rule => {
      if (rule.constructor.name === "CSSKeyframesRule") keyframeNames.set(rule.name, `${scopeSelector.slice(1)}-${rule.name}`);
      if (rule.cssRules && rule.constructor.name !== "CSSKeyframesRule") collectKeyframes(rule.cssRules);
    });
    collectKeyframes(sheet.cssRules);
    const rewriteAnimations = style => {
      ["animation", "animation-name"].forEach(property => {
        let value = style.getPropertyValue(property);
        if (!value) return;
        keyframeNames.forEach((replacement, original) => {
          value = value.replace(new RegExp(`\\b${original}\\b`, "g"), replacement);
        });
        style.setProperty(property, value, style.getPropertyPriority(property));
      });
    };
    const serializeRules = rules => [...rules].map(rule => {
      const type = rule.constructor.name;
      if (type === "CSSImportRule") {
        warning(warnings, "css-import-removed", "External CSS @import rules were removed.");
        return "";
      }
      if (type === "CSSStyleRule") {
        sanitizeStyleDeclaration(rule.style, warnings);
        rewriteAnimations(rule.style);
        const selectors = splitCssSelectors(rule.selectorText).map(selector => rewriteCssSelector(selector, scopeSelector, idMap));
        return `${selectors.join(",")}{${rule.style.cssText}}`;
      }
      if (type === "CSSMediaRule") return `@media ${rule.conditionText}{${serializeRules(rule.cssRules)}}`;
      if (type === "CSSSupportsRule") return `@supports ${rule.conditionText}{${serializeRules(rule.cssRules)}}`;
      if (type === "CSSKeyframesRule") {
        const name = keyframeNames.get(rule.name) || rule.name;
        return `@keyframes ${name}{${[...rule.cssRules].map(frame => frame.cssText).join("")}}`;
      }
      if (type === "CSSFontFaceRule") {
        warning(warnings, "font-face-removed", "External @font-face fonts were removed; set the fonts again in the target site's settings.");
        return "";
      }
      if (rule.cssRules) return serializeRules(rule.cssRules);
      return "";
    }).join("");
    return serializeRules(sheet.cssRules);
  } catch {
    warning(warnings, "css-parse-failed", "Some CSS could not be parsed safely and was removed instead of being copied as is.");
    return "";
  }
}

function unit(value, fallback = "px") {
  if (value == null || value === "" || value === "auto" || value === "normal") return null;
  const match = String(value).match(/^(-?[\d.]+)(px|%|em|rem|vh|vw)?$/);
  return match ? { unit: match[2] || fallback, size: Number(match[1]), sizes: [] } : null;
}

function dimensions(style, prefix, includeZero = false) {
  const values = ["top", "right", "bottom", "left"].map(side => parseFloat(style[`${prefix}${side[0].toUpperCase()}${side.slice(1)}`]) || 0);
  if (!includeZero && !values.some(Boolean)) return null;
  return {
    unit: "px",
    top: String(values[0]),
    right: String(values[1]),
    bottom: String(values[2]),
    left: String(values[3]),
    isLinked: values.every(value => value === values[0])
  };
}

function color(value) {
  if (!value || value === "rgba(0, 0, 0, 0)" || value === "transparent") return "";
  const rgb = value.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (rgb) {
    return `#${rgb.slice(1).map(channel => Number(channel).toString(16).padStart(2, "0")).join("")}`;
  }
  return value;
}

function linkValue(node) {
  const anchor = node.closest?.("a") || (node.tagName === "A" ? node : null);
  return { url: anchor?.getAttribute("href") || "", is_external: anchor?.getAttribute("target") === "_blank" ? "on" : "", nofollow: /\bnofollow\b/.test(anchor?.getAttribute("rel") || "") ? "on" : "", custom_attributes: "" };
}

// 外边距折叠：源页面普通块布局里，相邻块级兄弟「上一个的下边距」和「这一个的上边距」折叠成两者较大值；
// Elementor 容器是 flex，外边距不折叠，两个都写进设置就叠加 —— 真实渲染比对里「标题 → 段落」「段落 → 段落」
// 之间普遍多出 12~18px，逐段累积。这里把本元素的上边距扣掉上一个兄弟的下边距，两者相加正好等于折叠后的间距。
const BLOCK_LEVEL = /^(block|flex|grid|table|list-item|flow-root)$/;
function collapsedTopMargin(node, style) {
  const mt = parseFloat(style.marginTop) || 0;
  const win = node.ownerDocument && node.ownerDocument.defaultView;
  const parent = node.parentElement;
  if (mt <= 0 || !win || !parent) return mt;
  if (!/^(block|flow-root|list-item)$/.test(win.getComputedStyle(parent).display)) return mt;
  if (!BLOCK_LEVEL.test(style.display) || /^(absolute|fixed)$/.test(style.position) || style.float !== "none") return mt;
  let prev = node.previousElementSibling;
  while (prev) {
    const ps = win.getComputedStyle(prev);
    if (ps.display !== "none" && !/^(absolute|fixed)$/.test(ps.position)) break;
    prev = prev.previousElementSibling;
  }
  if (!prev) return mt;
  const ps = win.getComputedStyle(prev);
  if (!BLOCK_LEVEL.test(ps.display) || ps.float !== "none") return mt;
  const pmb = parseFloat(ps.marginBottom) || 0;
  return pmb > 0 ? Math.max(0, mt - pmb) : mt;
}

function applyCollapsedTop(margin, node, style) {
  if (!margin) return margin;
  const top = collapsedTopMargin(node, style);
  const current = parseFloat(margin.top) || 0;
  if (Math.abs(top - current) < 0.01) return margin;
  const next = { ...margin, top: String(Math.round(top * 100) / 100) };
  next.isLinked = [next.top, next.right, next.bottom, next.left].every(v => v === next.top);
  return next;
}

function commonSettings(node, style) {
  const settings = {};
  if (node.id) settings._element_id = node.id;
  if (node.className && typeof node.className === "string") settings._css_classes = node.className.trim();
  const margin = applyCollapsedTop(dimensions(style, "margin", true), node, style);
  const padding = dimensions(style, "padding", true);
  if (margin) {
    // margin:0 auto 居中：computed 的左右外边距是视口相关的解析像素，清零改由 boxed 居中承担，避免换宽度就偏。
    if (isAutoCentered(node, style)) { margin.left = "0"; margin.right = "0"; margin.isLinked = false; }
    settings._margin = margin;
  }
  if (padding) settings._padding = padding;
  if (style.zIndex !== "auto") settings._z_index = String(style.zIndex);
  if (style.display === "none" || style.visibility === "hidden") settings.hide_desktop = "hidden-desktop";
  return settings;
}

function normalizeAlign(value, direction = "ltr") {
  const map = {
    left: "left",
    center: "center",
    right: "right",
    justify: "justify",
    start: direction === "rtl" ? "right" : "left",
    end: direction === "rtl" ? "left" : "right"
  };
  return map[value] || "";
}

// 解析水平对齐：显式 text-align 优先；未显式（start/end）时，仅当父级是「单列纵向排布」
// （块流 / flex 纵向）才按渲染盒左右留白推断居中/靠右——兼容 flex align-items:center / margin:auto 居中的标题；
// ⚠ 网格 / flex 横向多列里，元素位置只反映所在列，不代表对齐意图，绝不据此推断（否则同排卡片会各自左/中/右）。
function resolveAlign(node, style) {
  const raw = style.textAlign;
  if (raw === "center" || raw === "right" || raw === "justify") return normalizeAlign(raw, style.direction);
  if (raw === "left") return "left";
  const parent = node.parentElement;
  if (parent && node.getBoundingClientRect && parent.getBoundingClientRect) {
    const view = node.ownerDocument && node.ownerDocument.defaultView;
    const ps = view ? view.getComputedStyle(parent) : null;
    const pdisp = ps ? ps.display : "";
    const singleColumn = pdisp === "block" || pdisp === "flow-root" ||
      ((pdisp === "flex" || pdisp === "inline-flex") && /^column/.test(ps.flexDirection || "row"));
    if (singleColumn) {
      const r = node.getBoundingClientRect();
      const p = parent.getBoundingClientRect();
      const padL = ps ? parseFloat(ps.paddingLeft) || 0 : 0;
      const padR = ps ? parseFloat(ps.paddingRight) || 0 : 0;
      const gapL = r.left - (p.left + padL);
      const gapR = (p.right - padR) - r.right;
      if (gapL > 2 || gapR > 2) {                       // 元素盒明显窄于父内容宽 → 被 shrink + 定位
        const tol = Math.max(4, (gapL + gapR) * 0.18);
        if (Math.abs(gapL - gapR) <= tol && gapL > 2) return "center";
        if (gapL > gapR + tol) return "right";
      }
    }
  }
  return normalizeAlign(raw, style.direction);
}

// 元素是否靠 margin:0 auto 之类水平居中：左右外边距相等且为正、且比父容器窄。
// （getComputedStyle 会把 auto 解析成实际像素，直接取会烙进视口相关的固定边距——如 260px——导致换宽度就偏。）
function isAutoCentered(node, style) {
  // 无宽度约束时 margin:auto 会塌成 0；此时的对称正边距多半是固定值（如 margin:0 20px），不能动。
  if (style.maxWidth === "none" || style.maxWidth === "") return false;
  const ml = parseFloat(style.marginLeft) || 0;
  const mr = parseFloat(style.marginRight) || 0;
  if (ml <= 0 || mr <= 0) return false;
  if (Math.abs(ml - mr) > Math.max(2, (ml + mr) * 0.12)) return false;
  const parent = node.parentElement;
  if (!parent || !node.getBoundingClientRect || !parent.getBoundingClientRect) return false;
  const r = node.getBoundingClientRect();
  const p = parent.getBoundingClientRect();
  return r.width > 0 && p.width > 0 && r.width < p.width * 0.97;
}

function typography(settings, prefix, style, options) {
  if (options.fontMode === "site") return;
  settings[`${prefix}_typography`] = "custom";
  // ⚠ 只取字体栈的第一个字体。Elementor 的排版组把值渲染成 font-family: "{{VALUE}}" —— 整个值加引号当**一个**字体名
  //   （typography.php:109）。原来写整条栈「Arial, sans-serif」，页面上就成了 font-family: "Arial, sans-serif", Sans-serif，
  //   第一个是不存在的字体，所有文字静默退到通用字体。深度审计 D 抓出：字体还原率实际为 0。
  const family = (style.fontFamily || "").split(",")[0].replace(/["']/g, "").trim();
  if (family) settings[`${prefix}_font_family`] = family;
  const size = unit(style.fontSize);
  if (size) settings[`${prefix}_font_size`] = size;
  // ⚠ 400 / none / normal 也要显式写：Elementor 前端 CSS 给标题、按钮套全局字体的字重（新站主字体 600、强调字体 500），
  //   不写就被它顶上 —— Bootstrap 示例页 400 的大标题导入后全成了 600（真实渲染比对抓出）。
  if (style.fontWeight) settings[`${prefix}_font_weight`] = style.fontWeight;
  if (/^(none|uppercase|lowercase|capitalize)$/.test(style.textTransform)) settings[`${prefix}_text_transform`] = style.textTransform;
  if (/^(normal|italic|oblique)$/.test(style.fontStyle)) settings[`${prefix}_font_style`] = style.fontStyle;
  if (/^(none|underline|overline|line-through)$/.test(style.textDecorationLine)) settings[`${prefix}_text_decoration`] = style.textDecorationLine;
  const lineHeight = unit(style.lineHeight);
  if (lineHeight) settings[`${prefix}_line_height`] = lineHeight;
  const spacing = unit(style.letterSpacing);
  if (spacing) settings[`${prefix}_letter_spacing`] = spacing;
}

// computed 颜色 "rgb(r, g, b)" / "rgba(r, g, b, a)" → {r,g,b,a}；其他格式返回 null
function parseRgba(value) {
  const m = String(value || "").match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] == null ? 1 : Number(m[4]) } : null;
}

function parseLinearGradient(value) {
  const match = value.match(/^linear-gradient\(\s*(?:(-?\d+(?:\.\d+)?)deg\s*,\s*)?(.+)\)$/i);
  if (!match) return null;
  const stops = match[2].split(/,(?![^()]*\))/).map(part => part.trim());
  if (stops.length !== 2) return null;
  const parseStop = stop => {
    const result = stop.match(/^(.*?)(?:\s+(-?\d+(?:\.\d+)?)%)?$/);
    return { color: result?.[1]?.trim(), stop: result?.[2] == null ? null : Number(result[2]) };
  };
  const first = parseStop(stops[0]);
  const second = parseStop(stops[1]);
  if (!first.color || !second.color) return null;
  return { angle: Number(match[1] ?? 180), first, second };
}

function parseBoxShadow(value) {
  if (!value || value === "none") return null;
  const shadows = splitCssSelectors(value);
  if (!shadows.length) return null;
  // Elementor's box-shadow control holds a single shadow; keep the first (front-most) layer.
  const shadowValue = shadows[0];
  const inset = /\binset\b/i.test(shadowValue);
  const numbers = [...shadowValue.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]));
  const shadowColor = shadowValue.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|hsla?\([^)]*\)/i)?.[0];
  if (numbers.length < 2 || !shadowColor) return null;
  return {
    horizontal: numbers[0],
    vertical: numbers[1],
    blur: numbers[2] || 0,
    spread: numbers[3] || 0,
    color: shadowColor,
    inset
  };
}

function backgroundAndBorder(settings, style, options, shadowPrefix = "box_shadow") {
  const bg = color(style.backgroundColor);
  if (bg && options.colorMode !== "site") {
    settings.background_background = "classic";
    settings.background_color = bg;
  }
  if (style.backgroundImage && style.backgroundImage !== "none") {
    if (style.backgroundImage.startsWith("url(")) {
      const bgUrl = style.backgroundImage.slice(4, -1).replace(/^["']|["']$/g, "");
      // Base64 背景图默认丢弃（避免把巨大的 data URL 塞进 Elementor 容器设置、且导入媒体库会失败）；
      // 「媒体 URL：保持原样」才保留。绝对/相对 URL 原样带过去。
      const dropBg = /^data:/i.test( bgUrl ) && ( options.assetUrlMode || "safe" ) !== "preserve";
      if ( dropBg ) {
        warning( options.warnings || [], "data-background-placeholder", "Base64 background images were removed so the import does not fail; set the background again in the editor." );
      } else {
        settings.background_background = "classic";
        settings.background_image = { url: bgUrl, id: "" };
        settings.background_position = style.backgroundPosition || "center center";
        settings.background_repeat = style.backgroundRepeat || "no-repeat";
        settings.background_size = style.backgroundSize || "cover";
      }
    } else if (options.colorMode !== "site") {
      const gradient = parseLinearGradient(style.backgroundImage);
      if (gradient) {
        // ⚠ CSS 里渐变叠在底色上面；Elementor 的渐变模式会取代底色。半透明色标（Bootstrap 的 bg-gradient 是
        //   白 15%→0% 的高光）直接写进去，蓝色徽章就只剩一层近乎透明的白（真实渲染比对抓出）。
        //   有不透明底色时，把每个色标先和底色混合成不透明色，效果与浏览器叠加一致。
        const under = parseRgba(style.backgroundColor);
        const flatten = c => {
          const top = parseRgba(c);
          if (!under || under.a < 1 || !top || top.a >= 1) return c;
          const mix = k => Math.round(top[k] * top.a + under[k] * (1 - top.a));
          return `rgb(${mix("r")}, ${mix("g")}, ${mix("b")})`;
        };
        settings.background_background = "gradient";
        settings.background_gradient_type = "linear";
        settings.background_color = flatten(gradient.first.color);
        settings.background_color_b = flatten(gradient.second.color);
        settings.background_gradient_angle = { unit: "deg", size: gradient.angle, sizes: [] };
        if (gradient.first.stop != null) settings.background_color_stop = { unit: "%", size: gradient.first.stop, sizes: [] };
        if (gradient.second.stop != null) settings.background_color_b_stop = { unit: "%", size: gradient.second.stop, sizes: [] };
      } else if (!settings.background_color) {
        // radial / 多色标等无法解析为双色渐变时，回退为首个纯色，避免生成无颜色的空渐变背景
        const fallbackColor = style.backgroundImage.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|hsla?\([^)]*\)/i)?.[0];
        if (fallbackColor) {
          settings.background_background = "classic";
          settings.background_color = fallbackColor;
        }
      }
    }
  }
  // 样式与颜色取「第一条真有边框的边」，不能只看上边：只有 border-left 的引用条/时间线竖线
  // 原来整条边框都丢了（上边是 none）。各边宽度由 dimensions() 分别取，无边框的边计算值本来就是 0。
  const borderSide = ["Top", "Right", "Bottom", "Left"].find(side => {
    const s = style[`border${side}Style`];
    return s && s !== "none" && s !== "hidden" && parseFloat(style[`border${side}Width`]) > 0;
  });
  if (borderSide) {
    settings.border_border = style[`border${borderSide}Style`];
    if (options.colorMode !== "site") settings.border_color = style[`border${borderSide}Color`];
    settings.border_width = dimensions(style, "border");
  }
  const radius = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map(value => parseFloat(value) || 0);
  if (radius.some(Boolean)) settings.border_radius = { unit: "px", top: String(radius[0]), right: String(radius[1]), bottom: String(radius[2]), left: String(radius[3]), isLinked: radius.every(value => value === radius[0]) };
  if (options.colorMode !== "site") {
    const shadow = parseBoxShadow(style.boxShadow);
    if (shadow) {
      if (splitCssSelectors(style.boxShadow).length > 1) {
        warning(options.warnings || [], "box-shadow-multi", "An element has several shadows; only the top one was kept, add the rest in Elementor.");
      }
      // ⚠ Elementor 的阴影是**一个复合控件**，不是五个分离键。对照官方 4.1.1：
      //   includes/controls/groups/box-shadow.php:57 init_fields() 只产出两个字段
      //     $controls['box_shadow']          → Controls_Manager::BOX_SHADOW
      //     $controls['box_shadow_position'] → SELECT(' ' | 'inset')
      //   加上 base.php:564 的弹层开关（starter_name='box_shadow_type'、starter_value='yes'）。
      //   控件 id = get_controls_prefix() + 字段名 = "{name}_" + 字段（base.php:181）。
      // BOX_SHADOW 的值结构见 includes/controls/box-shadow.php:44 get_default_value()：
      //   { horizontal, vertical, blur, spread, color }（数字，不带单位对象）
      //
      // 之前写的 `${prefix}_color` / `_horizontal` / `_vertical` / `_blur` / `_spread`
      // / `_position` 这六个控件**根本不存在**，Elementor 对未知 settings 键静默丢弃
      // ——不报错、不告警，结果是转换出来的卡片/按钮阴影全部消失。
      // 且 `${prefix}_box_shadow` 名字虽对，值却写成字符串 "yes"，同样渲染不出来。
      settings[`${shadowPrefix}_box_shadow_type`] = "yes";
      settings[`${shadowPrefix}_box_shadow`] = {
        horizontal: shadow.horizontal,
        vertical: shadow.vertical,
        blur: shadow.blur,
        spread: shadow.spread,
        color: shadow.color
      };
      // Outline 在官方 options 里是一个空格，不是空串（box-shadow.php:72）。
      settings[`${shadowPrefix}_box_shadow_position`] = shadow.inset ? "inset" : " ";
    }
  }
}

function splitGridTracks(value) {
  const tokens = [];
  let current = "";
  let depth = 0;
  for (const char of String(value || "")) {
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  // Named grid lines ([col]) are not real tracks; drop them so the count is accurate.
  return tokens.filter(token => !/^\[.*\]$/.test(token));
}

// Verified against Group_Control_Grid_Container (columns_grid SLIDER, units fr/custom).
function gridColumnsSetting(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "none") return null;
  const tracks = splitGridTracks(trimmed);
  if (!tracks.length) return null;
  // ⚠ getComputedStyle 把 repeat(N, 1fr) 解析成实际像素(如 241.597/241.604px，子像素渲染会有 ~0.01px 微差)。
  // 数值近似相等 → 视为等宽 → 用 fr(响应式、且在导航器里就是「网格」列数)，而不是烙死像素宽。
  const nums = tracks.map(track => parseFloat(track));
  const numericPx = /px/.test(trimmed) && nums.every(n => Number.isFinite(n) && n > 0);
  const nearEqual = numericPx && nums.every(n => Math.abs(n - nums[0]) <= Math.max(1, nums[0] * 0.02));
  const exactEqual = tracks.every(track => track === tracks[0]);
  if ((nearEqual || exactEqual) && tracks.length <= 12) return { unit: "fr", size: tracks.length, sizes: [] };
  return { unit: "custom", size: trimmed, sizes: [] };
}

// 取某个属性在源页面上的「声明值」（样式表规则 + 内联），而不是 computed 的解析结果。
// 收集所有命中的规则（含当前宽度下生效的 @media），逐个以 !important 回写到元素上试：
// computed 与原来一模一样才采用 —— 特异性、先后顺序都不会选错。skip(candidate) 为 true 的候选跳过。找不到返回 null。
function declaredProperty(node, prop, skip = () => false) {
  const win = node.ownerDocument && node.ownerDocument.defaultView;
  if (!win || !node.style) return null;
  // ⚠ 性能：原来每次调用都把整份样式表扫一遍、每个候选都临时改样式重算 —— 每个容器调用好几次、每个断点再来一遍，
  //   Bootstrap 整页（几千条规则）转换从 4.6 秒涨到 11.8 秒（自审实测）。
  //   现在：① 每份文档按属性建一次「声明了它的规则」索引；② 同一元素 + 属性 + 预览宽度的候选与验证结果缓存。
  const cacheKey = `${prop}|${win.innerWidth}`;
  let perNode = DECLARED_CACHE.get(node);
  if (!perNode) DECLARED_CACHE.set(node, perNode = new Map());
  let entry = perNode.get(cacheKey);
  if (!entry) {
    const candidates = [];
    const inline = node.style.getPropertyValue(prop);
    if (inline) candidates.push(inline.trim());
    for (const rule of declaredRuleIndex(node.ownerDocument, prop)) {
      if (rule.media.length && rule.media.some(m => !mediaMatches(win, m))) continue;
      try { if (node.matches(rule.selector)) candidates.push(rule.value); } catch { /* 选择器浏览器不认 */ }
    }
    entry = { ordered: [...new Set(candidates)].reverse(), verified: new Map() };
    perNode.set(cacheKey, entry);
  }
  const camel = prop.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
  // 只有一个候选就不用验证：所有命中规则和内联值都在候选里（简写也已展开），唯一的那个就是生效的那个。
  //   验证要临时改样式，每次都触发整页重排 —— 只在需要分辨特异性 / 先后顺序时才做。
  if (entry.ordered.length === 1) return skip(entry.ordered[0]) ? null : entry.ordered[0];
  let target = null;
  for (const candidate of entry.ordered) {
    if (skip(candidate)) continue;
    if (!entry.verified.has(candidate)) {
      if (target === null) target = win.getComputedStyle(node)[camel];
      const hadStyleAttr = node.hasAttribute("style");
      const saved = node.style.getPropertyValue(prop);
      const savedPriority = node.style.getPropertyPriority(prop);
      node.style.setProperty(prop, candidate, "important");
      entry.verified.set(candidate, win.getComputedStyle(node)[camel] === target);
      if (saved) node.style.setProperty(prop, saved, savedPriority);
      else node.style.removeProperty(prop);
      // 原来没有 style 属性的元素，试完别留下空的 style=""（会跟着 HTML 进文本编辑器 / HTML 小组件）
      if (!hadStyleAttr && !node.getAttribute("style")) node.removeAttribute("style");
    }
    if (entry.verified.get(candidate)) return candidate;
  }
  return null;
}

// declaredProperty 的缓存与索引（转换期间 DOM 不变，只是临时改内联样式再还原）
const DECLARED_CACHE = new WeakMap();
// 媒体查询结果按「条件 + 预览宽度」缓存：每次 new 一个 matchMedia 很贵，几百条规则 × 几千个节点就是几十万次
const MEDIA_CACHE = new WeakMap();
function mediaMatches(win, condition) {
  let perWin = MEDIA_CACHE.get(win);
  if (!perWin) MEDIA_CACHE.set(win, perWin = new Map());
  const key = `${win.innerWidth}|${condition}`;
  if (!perWin.has(key)) perWin.set(key, win.matchMedia(condition).matches);
  return perWin.get(key);
}
const DECLARED_RULE_INDEX = new WeakMap();
function declaredRuleIndex(doc, prop) {
  let byProp = DECLARED_RULE_INDEX.get(doc);
  if (!byProp) DECLARED_RULE_INDEX.set(doc, byProp = new Map());
  if (byProp.has(prop)) return byProp.get(prop);
  const list = [];
  const visit = (rules, media) => {
    for (const rule of rules || []) {
      if (rule.cssRules && rule.conditionText !== undefined) {
        visit(rule.cssRules, rule.constructor.name === "CSSMediaRule" ? [...media, rule.conditionText] : media);
        continue;
      }
      if (!rule.selectorText || !rule.style) continue;
      const value = rule.style.getPropertyValue(prop);
      if (value) list.push({ selector: rule.selectorText, value: value.trim(), media });
    }
  };
  for (const sheet of doc.styleSheets) {
    try { visit(sheet.cssRules, []); } catch { /* 跨域样式表读不到 */ }
  }
  byProp.set(prop, list);
  return list;
}

// grid 列轨道优先用源页面的「声明值」。⚠ computed 把 fr / minmax / auto-fit 全解析成像素：
//   原来 `1.1fr 1fr` 的 hero 导入后是 `596.391px 539.594px`，不再随宽度伸缩；
//   `repeat(auto-fit,minmax(220px,1fr))` 的自适应卡片墙也被钉死成固定列。
//   纯像素声明没有比 computed 更多的信息，跳过。找不到（比如扩展抓来的内联像素）返回 null。
function declaredGridColumns(node) {
  return declaredProperty(node, "grid-template-columns", c => /px/.test(c) && !/(fr|minmax|repeat|auto|%)/.test(c));
}

function gridColumnsFor(node, style) {
  const declared = declaredGridColumns(node);
  if (declared) {
    const repeat = declared.match(/^repeat\(\s*(\d+)\s*,\s*(?:1fr|minmax\(\s*0(?:px)?\s*,\s*1fr\s*\))\s*\)$/i);
    if (repeat && Number(repeat[1]) <= 12) return { unit: "fr", size: Number(repeat[1]), sizes: [] };
    // auto-fit / minmax / 其他 repeat 原样写成自定义（交给 gridColumnsSetting 会把整段当成「1 列」）
    if (/repeat\(|minmax\(|fit-content\(/i.test(declared)) return { unit: "custom", size: declared, sizes: [] };
    return gridColumnsSetting(declared);
  }
  return gridColumnsSetting(style.gridTemplateColumns);
}

function widget(type, settings) {
  return { id: id(), elType: "widget", settings, elements: [], widgetType: type };
}

function widgetWithGlobals(type, settings, options) {
  const globals = {};
  if (options.colorMode === "site") {
    if (type === "heading") globals.title_color = "globals/colors?id=primary";
    if (type === "text-editor") globals.text_color = "globals/colors?id=text";
    if (type === "button") globals.background_color = "globals/colors?id=accent";
    if (type === "icon") globals.primary_color = "globals/colors?id=primary";
    if (type === "divider") globals.color = "globals/colors?id=secondary";
  }
  if (options.fontMode === "site") {
    if (type === "heading") globals.typography_typography = "globals/typography?id=primary";
    if (type === "text-editor") globals.typography_typography = "globals/typography?id=text";
    if (type === "button") globals.typography_typography = "globals/typography?id=accent";
  }
  if (Object.keys(globals).length) settings.__globals__ = { ...(settings.__globals__ || {}), ...globals };
  return widget(type, settings);
}

function htmlWidget(html) {
  return widget("html", { html });
}

function resolveHeadingTag(originalTag, options) {
  if (/^h[1-6]$/.test(options.headingMode || "")) return options.headingMode;
  if (options.headingMode !== "semantic") return originalTag.toLowerCase();
  const originalLevel = Number(originalTag.slice(1));
  const topLevel = Math.max(1, Math.min(6, Number(options.headingTopLevel) || 1));
  const state = options.headingState || (options.headingState = { seen: false, levelMap: new Map() });
  if (!state.seen) {
    state.seen = true;
    state.levelMap.set(originalLevel, topLevel);
    return `h${topLevel}`;
  }
  if (state.levelMap.has(originalLevel)) return `h${state.levelMap.get(originalLevel)}`;
  const nearestLowerSourceLevel = [...state.levelMap.keys()]
    .filter(level => level < originalLevel)
    .sort((first, second) => second - first)[0];
  const level = nearestLowerSourceLevel == null
    ? topLevel
    : Math.min(6, state.levelMap.get(nearestLowerSourceLevel) + 1);
  state.levelMap.set(originalLevel, level);
  return `h${level}`;
}

const ICON_TEXT_MAP = new Map([
  ["✓", ["fas fa-check", "fa-solid"]],
  ["✔", ["fas fa-check", "fa-solid"]],
  ["✕", ["fas fa-times", "fa-solid"]],
  ["×", ["fas fa-times", "fa-solid"]],
  ["★", ["fas fa-star", "fa-solid"]],
  ["☆", ["far fa-star", "fa-regular"]],
  ["♥", ["fas fa-heart", "fa-solid"]],
  ["❤", ["fas fa-heart", "fa-solid"]],
  ["→", ["fas fa-arrow-right", "fa-solid"]],
  ["➜", ["fas fa-arrow-right", "fa-solid"]],
  ["←", ["fas fa-arrow-left", "fa-solid"]],
  ["↻", ["fas fa-redo", "fa-solid"]],
  ["↺", ["fas fa-undo", "fa-solid"]],
  ["✋", ["fas fa-hand-paper", "fa-solid"]],
  ["◎", ["fas fa-bullseye", "fa-solid"]],
  ["●", ["fas fa-circle", "fa-solid"]],
  ["○", ["far fa-circle", "fa-regular"]],
  ["+", ["fas fa-plus", "fa-solid"]],
  ["−", ["fas fa-minus", "fa-solid"]]
]);

const SVG_ICON_PATHS = new Map([
  ["✓", '<path d="m12 32 12 12 28-30" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>'],
  ["✔", '<path d="m12 32 12 12 28-30" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>'],
  ["✕", '<path d="M17 17l30 30M47 17 17 47" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>'],
  ["×", '<path d="M17 17l30 30M47 17 17 47" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>'],
  ["★", '<path d="m32 7 7.5 15.2 16.8 2.4-12.1 11.8 2.8 16.7L32 45.2 17 53.1l2.8-16.7L7.7 24.6l16.8-2.4z" fill="currentColor"/>'],
  ["☆", '<path d="m32 7 7.5 15.2 16.8 2.4-12.1 11.8 2.8 16.7L32 45.2 17 53.1l2.8-16.7L7.7 24.6l16.8-2.4z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>'],
  ["♥", '<path d="M32 53S8 40 8 23c0-12 15-17 24-6 9-11 24-6 24 6 0 17-24 30-24 30z" fill="currentColor"/>'],
  ["❤", '<path d="M32 53S8 40 8 23c0-12 15-17 24-6 9-11 24-6 24 6 0 17-24 30-24 30z" fill="currentColor"/>'],
  ["→", '<path d="M8 32h44M37 17l15 15-15 15" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>'],
  ["➜", '<path d="M8 32h44M37 17l15 15-15 15" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>'],
  ["←", '<path d="M56 32H12M27 17 12 32l15 15" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>'],
  ["+", '<path d="M32 11v42M11 32h42" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>'],
  ["−", '<path d="M11 32h42" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>']
]);

function iconDefinition(node) {
  const classList = [...node.classList];
  const iconName = classList.find(name => /^fa-[\w-]+$/.test(name) && !["fa-solid", "fa-regular", "fa-brands"].includes(name));
  if (iconName) {
    const prefix = classList.includes("fab") || classList.includes("fa-brands")
      ? ["fab", "fa-brands"]
      : classList.includes("far") || classList.includes("fa-regular")
        ? ["far", "fa-regular"]
        : ["fas", "fa-solid"];
    return [`${prefix[0]} ${iconName}`, prefix[1]];
  }
  // Elementor's own icon set (eicons library); value is the bare class, verified against
  // includes/widgets/video.php:1132 ({ value:'eicon-*', library:'eicons' }).
  const eiconName = classList.find(name => /^eicon-[\w-]+$/.test(name));
  if (eiconName) return [eiconName, "eicons"];
  return ICON_TEXT_MAP.get(cleanText(node.textContent)) || null;
}

/**
 * 1–3 个字符的「字符图标」：✓ ★ → ✗ 这类 Unicode 符号，外加几个常当列表圆点用的字符。
 * ⚠ 标点不算。原来的判据是「不含字母数字」，于是装饰用的大引号 “ 也被当成图标 → 映射不到图标库 →
 *   退成原始 HTML（模板库 pull-quote-band 实测；那个模板特意把引号写成文字字符就是为了让它作为文字保留下来）。
 *   引号、破折号、省略号是文字的一部分，应该留在文本里。
 */
function isGlyphIcon(text) {
  const t = String(text || "").replace(/\s+/g, "");
  // 只认「其他符号」(\p{So}：✓ ★ ✗ ☎…) 和箭头区段；货币符号 $ € 和数学符号 + = 不算 ——
  // 价格卡里的 <span class="currency">$</span> 是文字，按符号类全收的话会被当图标退成原始 HTML。
  return t.length > 0 && t.length <= 3 && /^[\p{So}←-⇿➠-➿➔•‣⁃◦]+$/u.test(t);
}

function isIconNode(node) {
  const tag = String(node.tagName || "").toUpperCase();
  // ⚠ <img> 永远不算图标。下面那条 class 正则里 \bicon\b 会命中 "tool-icon"、"card-icon"
  //   这类再普通不过的类名（'-' 是非词字符，构成词边界），于是一张带 URL 的普通图片
  //   被判成图标；而图标模式默认「保留原样」，结果就是整张图退化成原始 HTML 小组件。
  //   Elementor 的图标控件只吃图标库或已上传的 SVG，接不了远程位图 URL ——
  //   对 <img> 来说唯一能真正工作的产物就是图片小组件。
  if (tag === "IMG" || tag === "PICTURE") return false;
  // ⚠ 带正经文字的元素不是图标。类名正则会命中 Bootstrap 的 <a class="icon-link">Call to action <svg></a>，
  //   整个链接被当图标：文字丢了、还退化成原始 HTML（真实站点体检：Bootstrap features/product 页）。
  //   <i> 同理 —— 它也是斜体标签，<i>emphasis</i> 按原规则会被当图标吞掉文字。
  if (/[\p{L}\p{N}]{2,}/u.test(cleanText(node.textContent))) return false;
  if (tag === "SVG" || tag === "I") return true;
  if (node.className && /\b(?:icon|eicon|fa[srb]?)\b/i.test(String(node.className))) return true;
  const text = cleanText(node.textContent);
  return tag === "SPAN" && isGlyphIcon(text);
}

function mappingSuggestion(node) {
  const tag = String(node.tagName || "").toUpperCase();
  const signature = `${node.id || ""} ${String(node.className || "")}`.toLowerCase();
  if (["SCRIPT", "NOSCRIPT", "STYLE", "TEMPLATE", "OBJECT", "EMBED", "APPLET"].includes(tag)) {
    return { target: "skip", confidence: "unsupported", reason: "活动内容或外部样式会被安全清理" };
  }
  const signatureRules = [
    [/\b(?:image-)?carousel\b|\bslider\b/, "widget:image-carousel", "识别为图片轮播结构"],
    [/\bgallery\b/, "widget:image-gallery", "识别为图片画廊结构"],
    [/\baccordion\b/, "widget:accordion", "识别为经典手风琴结构"],
    [/\btabs?\b/, "widget:tabs", "识别为选项卡结构"],
    [/\bsocial(?:-icons?)?\b/, "widget:social-icons", "识别为社交图标列表"],
    [/\btestimonial\b|\breview\b/, "widget:testimonial", "识别为评价/推荐内容"],
    [/\bcountdown\b/, "widget:countdown", "识别为倒计时组件"],
    [/\bcounter\b|\bstat(?:istic)?\b/, "widget:counter", "识别为计数器组件"],
    [/\bprice-(?:table|card)\b|\bpricing\b/, "widget:price-table", "识别为 Pro 价格表"],
    [/\balert\b|\bnotice\b/, "widget:alert", "识别为提示框"],
    [/\bsearch-form\b/, "widget:search-form", "识别为 Pro 搜索表单"],
    [/\blogin-form\b|\blogin\b/, "widget:login", "识别为 Pro 登录组件"],
    [/\btable-of-contents\b|\btoc\b/, "widget:table-of-contents", "识别为 Pro 目录组件"]
  ];
  const signatureMatch = signatureRules.find(([pattern]) => pattern.test(signature));
  if (signatureMatch) return { target: signatureMatch[1], confidence: "partial", reason: `${signatureMatch[2]}；数据与交互需复核` };
  // 按钮样式的 div/span（无块级子元素、短文本、类名含 btn/button/cta 或 role=button）先于容器判定。
  if (
    node.getAttribute("role") === "button" ||
    ((tag === "DIV" || tag === "SPAN") &&
      /\b(?:btn|button|cta)\b/i.test(signature) &&
      !node.querySelector("h1,h2,h3,h4,h5,h6,p,ul,ol,table,div,section,article,header,footer") &&
      cleanText(node.textContent).length <= 40)
  ) {
    return { target: "button", confidence: "partial", reason: "识别为按钮样式的区块（导入后可核对链接）" };
  }
  if (CONTAINER_TAGS.has(tag)) return { target: "container", confidence: "exact", reason: "可映射为 Elementor Container" };
  if (/^H[1-6]$/.test(tag)) return { target: "heading", confidence: "exact", reason: "可映射为标题小部件" };
  if (tag === "IMG") return { target: "image", confidence: "exact", reason: "可映射为图片小部件" };
  if (tag === "AUDIO") return { target: "html", confidence: "fallback", reason: "Elementor Audio 仅适合 SoundCloud/oEmbed；自托管音频保留为 HTML" };
  if (tag === "PROGRESS") return { target: "widget:progress", confidence: "partial", reason: "可映射进度值，样式需要复核" };
  if (tag === "FORM") return { target: "widget:form", confidence: "partial", reason: "可映射为 Elementor Pro Form；提交动作需在目标站点重新配置" };
  if (tag === "NAV") return { target: "widget:nav-menu", confidence: "fallback", reason: "可生成 Pro Nav Menu 空组件，但必须在目标站点选择 WordPress 菜单" };
  if (tag === "DETAILS") return { target: "widget:accordion", confidence: "partial", reason: "可生成经典 Accordion；复杂嵌套内容需复核" };
  if (tag === "BUTTON" || (tag === "A" && /\b(?:button|btn)\b/i.test(node.className || ""))) return { target: "button", confidence: "exact", reason: "可映射为按钮小部件" };
  if (tag === "HR") return { target: "divider", confidence: "exact", reason: "可映射为分隔线小部件" };
  if (["P", "BLOCKQUOTE", "UL", "OL", "TABLE", "DL", "PRE"].includes(tag)) return { target: "text", confidence: "exact", reason: "可映射为文本编辑器" };
  if (tag === "VIDEO") return { target: "video", confidence: "partial", reason: "YouTube/Vimeo 可原生映射，其他视频会回退 HTML" };
  if (tag === "SVG" || tag === "I" || /\b(?:icon|eicon|fa[srb]?)\b/i.test(String(node.className || ""))) return { target: "icon", confidence: "partial", reason: "需匹配 Font Awesome；失败时回退 HTML" };
  if (["IFRAME", "CANVAS"].includes(tag)) return { target: "html", confidence: "fallback", reason: "没有稳定的一一对应原生组件" };
  if (node.children.length) return { target: "auto", confidence: "partial", reason: "作为结构包裹层继续分析子元素" };
  return { target: "html", confidence: "fallback", reason: "无法可靠匹配，建议保留 HTML 或跳过" };
}

// 提示文案里给人看的组件名：「counter」「icon-box」→「Counter」「Icon Box」（e-heading 这类 Atomic id 去掉前缀）。
function componentLabel(id) {
  return String(id || "").replace(/^e-/, "").split(/[-_]/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function canAutomaticallyConvertComponent(target, node, options = {}) {
  switch (target) {
    case "widget:form":
      return node.tagName === "FORM";
    case "widget:progress":
      return node.tagName === "PROGRESS";
    case "widget:image-gallery":
    case "widget:image-carousel":
      return allMediaCouldProduceUrls(node, options);
    case "widget:social-icons":
      return Boolean(node.querySelector("a[href]"));
    case "widget:counter":
      return /-?[\d,.]+/.test(cleanText(node.textContent));
    case "widget:alert":
      return Boolean(cleanText(node.textContent));
    case "widget:accordion":
      return node.tagName === "DETAILS" || Boolean(node.querySelector("details > summary"));
    case "widget:tabs": {
      const titleCount = node.querySelectorAll("[role='tab'],.tab-title,.tabs-title,[data-tab]").length;
      const panelCount = node.querySelectorAll("[role='tabpanel'],.tab-content,.tabs-content").length;
      return titleCount > 0 && panelCount > 0;
    }
    default:
      return false;
  }
}

/* ---------- 结构识别（与类名无关） ----------
 *
 * ⚠ 原来一批小组件只靠类名识别（.stat → 计数器、.gallery → 画廊、.social → 社交图标）。
 *   Tailwind 这类工具类页面的类名全是 flex / gap-4 / text-sm，没有任何语义 —— 而扩展的主战场
 *   正是这类页面。基准（hte-cli/audit/widget-bench.mjs）实测：同一批写法，语义类名版 ✓17，
 *   Tailwind 版只有 ✓12，差的 5 种全是因为依赖类名。
 * 这里按「长什么样」识别。原则是**宁可不认，不能认错**：每个识别器都有收紧条件，
 * 不满足就回到原来的通用转换（原生容器 + 标题/文本），不会比现在差。
 * win 为空（网站映射面板用 DOMParser 解析，没有布局）时，需要量尺寸的识别器直接跳过。
 */
const SOCIAL_HOSTS = [
  ["facebook.com", "facebook"], ["fb.com", "facebook"], ["twitter.com", "x-twitter"], ["x.com", "x-twitter"],
  ["instagram.com", "instagram"], ["linkedin.com", "linkedin"], ["youtube.com", "youtube"], ["youtu.be", "youtube"],
  ["tiktok.com", "tiktok"], ["github.com", "github"], ["pinterest.com", "pinterest"], ["whatsapp.com", "whatsapp"],
  ["wa.me", "whatsapp"], ["t.me", "telegram"], ["telegram.me", "telegram"], ["discord.gg", "discord"],
  ["discord.com", "discord"], ["reddit.com", "reddit"], ["dribbble.com", "dribbble"], ["behance.net", "behance"],
  ["medium.com", "medium"], ["threads.net", "threads"], ["snapchat.com", "snapchat"], ["vimeo.com", "vimeo"], ["weibo.com", "weibo"]
];
// 图标名均已对官方包 assets/lib/font-awesome/json/brands.json 核对存在。

/** 按主机名判断社交品牌。⚠ 不能对整条 URL 跑 /x\.com/ —— 会误中 box.com、dropbox.com。 */
function socialBrand(href) {
  let host;
  try { host = new URL(href, "https://invalid.invalid/").hostname.toLowerCase().replace(/^(?:www|m)\./, ""); } catch { return null; }
  const hit = SOCIAL_HOSTS.find(([domain]) => host === domain || host.endsWith("." + domain));
  return hit ? hit[1] : null;
}

function socialLinks(node) {
  const items = [...node.children];
  if (items.length < 2) return null;
  const links = [];
  for (const item of items) {
    const a = item.tagName === "A" ? item : (item.tagName === "LI" && item.children.length === 1 && item.children[0].tagName === "A" ? item.children[0] : null);
    if (!a || !a.getAttribute("href") || !socialBrand(a.getAttribute("href"))) return null;
    // 只认「纯图标」链接：带文字的链接转成社交图标会把文字丢掉
    if (cleanText(a.textContent).length > 2) return null;
    links.push(a);
  }
  return links;
}

function galleryItems(node) {
  const items = [...node.children];
  if (items.length < 3) return null;
  const imgs = [];
  for (const item of items) {
    const img = item.tagName === "IMG" ? item : null;
    if (img) { imgs.push(img); continue; }
    if (!["A", "FIGURE", "PICTURE", "DIV", "LI", "SPAN"].includes(item.tagName)) return null;
    const inner = item.querySelectorAll("img");
    if (inner.length !== 1 || cleanText(item.textContent)) return null;
    if (item.querySelector("video, iframe, svg, button, input")) return null;
    imgs.push(inner[0]);
  }
  return imgs;
}

const STAR_FULL = "★⭐✭✮✯✪✫✬";
const STAR_HALF = "½⯨⯪";
const STAR_EMPTY = "☆✩";
function starText(node) {
  if (node.querySelector("img, svg, a, button, input")) return null;
  const text = String(node.textContent || "").replace(/\s+/g, "");
  if (text.length < 3 || text.length > 10) return null;
  for (const ch of text) if (!(STAR_FULL + STAR_HALF + STAR_EMPTY).includes(ch)) return null;
  return text;
}

/** 数字统计：一个大号数字 + 一句短标签，别的什么都没有。 */
// 后缀组连同前导空格一起捕获：Elementor 渲染是「前缀+数字+后缀」直接拼接，「120 KB」的空格要留在后缀里。
// ⚠ 单位要整个当后缀（KB / MB / ms / min，至多 3 个字母）：原来只认单个 k/M，
//   「0 KB」会被拆成后缀 K + 标题 B（offline.html 实测）。
const COUNTER_NUMBER = /^([+-]?[$€£¥₹]?)\s?(\d{1,3}(?:[,\s]\d{3})+|\d+)(?:\.(\d+))?(\s?(?:%|[A-Za-z]{1,3})?\+?)$/;
function counterParts(node, win) {
  if (!win || node.querySelector("img, svg, a, button, input, ul, ol, table, video, iframe")) return null;
  if (node.querySelectorAll("*").length > 4) return null;
  const parts = [];
  const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const text = cleanText(t.textContent);
    if (text) parts.push({ text, el: t.parentElement });
  }
  if (parts.length !== 2) return null;
  const numIndex = parts.findIndex(p => COUNTER_NUMBER.test(p.text));
  if (numIndex < 0) return null;
  const num = parts[numIndex];
  // 「2019 · 公司成立」是时间线里的年份，不是会跳动的统计数字
  if (/^(19|20)\d{2}$/.test(num.text)) return null;
  const label = parts[1 - numIndex];
  if (COUNTER_NUMBER.test(label.text) || !/\p{L}/u.test(label.text) || label.text.length > 40) return null;
  // 价格「$29 /mo」不是统计数字
  if (/^(\/|per\b|each\b|a\s)/i.test(label.text)) return null;
  const size = el => parseFloat(win.getComputedStyle(el).fontSize) || 0;
  if (size(num.el) < size(label.el) * 1.3) return null;
  const m = num.text.match(COUNTER_NUMBER);
  return { prefix: m[1], digits: m[2], decimals: m[3] || "", suffix: m[4] || "", label: label.text, numberEl: num.el, labelEl: label.el };
}

/** div 画的进度条：外层轨道 + 唯一一个填充子元素，里面没有任何文字。 */
function progressParts(node, win) {
  if (!win || node.tagName === "PROGRESS" || node.children.length !== 1 || cleanText(node.textContent)) return null;
  const fill = node.children[0];
  if (fill.children.length) return null;
  const r = node.getBoundingClientRect();
  const f = fill.getBoundingClientRect();
  if (r.height < 2 || r.height > 40 || r.width < 60) return null;
  if (f.height < r.height - 4 || f.width <= r.width * 0.01 || f.width >= r.width * 0.99) return null;
  const fs = win.getComputedStyle(fill);
  const painted = s => (s.backgroundColor && !/rgba\([^)]*,\s*0\)|transparent/.test(s.backgroundColor)) || (s.backgroundImage && s.backgroundImage !== "none");
  if (!painted(fs)) return null;
  return { percent: Math.round(f.width / r.width * 100), fill, fillStyle: fs, height: r.height };
}

/** 评价：一段引语 + 署名（可带头像、职位），没有别的内容。 */
function testimonialParts(node, win) {
  if (!["FIGURE", "DIV", "ARTICLE", "SECTION", "LI"].includes(node.tagName)) return null;
  const quotes = node.querySelectorAll("blockquote");
  if (quotes.length !== 1) return null;
  if (node.querySelector("h1, h2, h3, button, form, input, ul, ol, table, video, iframe")) return null;
  const imgs = node.querySelectorAll("img");
  if (imgs.length > 1) return null;
  const quote = quotes[0];
  const quoteText = cleanText(quote.textContent);
  const outside = cleanText(node.textContent.replace(quote.textContent, " "));
  if (quoteText.length < 15 || !outside || outside.length > 120) return null;
  const img = imgs[0] || null;
  if (img && quote.contains(img)) return null;
  if (img && win && img.getBoundingClientRect().width > 160) return null;   // 头像，不是配图
  // 用首字母做的头像（带底色/圆角的小方块里一两个字母）：评价小组件的头像只能是图片，转过去字母会被拼进职位
  //   （「MR Head of Product」），圆形头像也没了（2026-10-15 Northwind 测试页）。宁可不认，走通用转换。
  if (win && [...node.querySelectorAll("*")].some(el => !quote.contains(el) && !el.children.length
    && /^[\p{L}\p{N}]{1,3}$/u.test(cleanText(el.textContent)) && hasVisualFrame(win.getComputedStyle(el)))) return null;
  // 引用外有一行只由星号组成的评分（★★★★☆）：Elementor 的评价小组件没有星级字段，硬套会把星号当成姓名
  //   （名字变成「★」、职位开头一串星，2026-10 模板库 reviews 模块实测），评分也丢了。
  //   不认作评价，走通用转换 —— 星号那行会变成 Star Rating，引用变成文本，什么都不丢。
  if ([...node.querySelectorAll("*")].some(el => !quote.contains(el) && !el.contains(quote)
    && /^[★☆✩✭✮\s]+$/u.test(el.textContent) && /[★☆✩✭✮]/u.test(el.textContent))) return null;
  const outsideEls = [...node.querySelectorAll("cite, strong, b, figcaption, div, span, p")].filter(el => !quote.contains(el) && cleanText(el.textContent));
  const nameEl = outsideEls.find(el => /^(CITE|STRONG|B)$/.test(el.tagName)) || outsideEls.find(el => !el.querySelector("*")) || null;
  const name = cleanText(nameEl?.textContent) || outside;
  const job = cleanText(outside.replace(name, "")).replace(/^[\s·•—–\-,|]+/, "");
  return { quote, quoteText, name, nameEl, job, img };
}

/** 纯留白：没内容、没背景没边框、在块级流里只撑高度。 */
function spacerHeight(node, win) {
  if (!win || !["DIV", "SPAN"].includes(node.tagName) || node.childNodes.length && (node.children.length || cleanText(node.textContent))) return null;
  const s = win.getComputedStyle(node);
  const parent = node.parentElement ? win.getComputedStyle(node.parentElement) : null;
  if (!parent || !["block", "flow-root", "list-item"].includes(parent.display)) return null;   // flex/grid 里的空元素多半是占位，不是留白
  if (!["static", "relative"].includes(s.position) || !["block", "flow-root"].includes(s.display)) return null;
  const bg = s.backgroundColor && !/rgba\([^)]*,\s*0\)|transparent/.test(s.backgroundColor);
  const border = ["Top", "Right", "Bottom", "Left"].some(side => parseFloat(s[`border${side}Width`]) > 0);
  if (bg || (s.backgroundImage && s.backgroundImage !== "none") || border || s.boxShadow !== "none") return null;
  const h = node.getBoundingClientRect().height;
  return h >= 8 && h <= 400 ? Math.round(h) : null;
}

/**
 * 从谷歌地图嵌入地址里取出地图小组件要的「地址」。三种常见写法：
 *   ?q=Paris&output=embed          → 「Paris」
 *   /maps/embed?pb=...!2d2.29!3d48.85... （「分享 → 嵌入地图」给的就是这种，最常见）→ 「48.85,2.29」
 *   /maps/place/Eiffel+Tower/...   → 「Eiffel Tower」
 * 取不到地址就返回 null，照旧当普通 iframe 处理。
 */
function googleMapFromUrl(src) {
  let url;
  try { url = new URL(src, "https://html-to-elementor.local/"); } catch { return null; }
  if (!/(^|\.)google\.[a-z.]+$/i.test(url.hostname) || !/^\/maps\b/.test(url.pathname)) return null;
  const zoom = Number(url.searchParams.get("z")) || 0;
  const q = url.searchParams.get("q");
  if (q) return { address: q, zoom };
  const pb = url.searchParams.get("pb") || "";
  const lng = pb.match(/!2d(-?\d+(?:\.\d+)?)/);
  const lat = pb.match(/!3d(-?\d+(?:\.\d+)?)/);
  if (lat && lng) return { address: `${lat[1]},${lng[1]}`, zoom };
  const place = url.pathname.match(/\/maps\/place\/([^/]+)/);
  if (place) return { address: decodeURIComponent(place[1].replace(/\+/g, " ")), zoom };
  return null;
}

/**
 * 绝对定位：原来引擎完全不管 position:absolute —— 角标、装饰元素全都变成普通弹性子项，
 * 被拉伸成整卡高度的色条（腾讯工具页的「hot」就是这样变成一根红柱的）。
 * 只处理小组件，且要求定位参照物就是父元素（这样 Elementor 里的父容器正好是参照物；.e-con 默认 position:relative）。
 * 容器不处理：满铺遮罩这类绝对定位容器要算宽高，贸然改反而更糟，保持原来的流式排列。
 * 键名与取值已对 common-base.php 核对：_position=absolute，水平 _offset_orientation_h=start|end
 * 分别配 _offset_x / _offset_x_end，垂直同理。
 */
function applyAbsolutePosition(element, node, style, win) {
  if (!element || element.elType !== "widget" || style.position !== "absolute") return;
  const parent = node.parentElement;
  if (!parent || node.offsetParent !== parent) return;
  const r = node.getBoundingClientRect();
  const p = parent.getBoundingClientRect();
  if (!r.width || !p.width) return;
  setAbsoluteOffsets(element.settings, r, p);
}

/** 按「离哪条边近就贴哪条边」写绝对定位偏移（r = 元素矩形，p = 参照容器矩形）。 */
function setAbsoluteOffsets(s, r, p) {
  const px = v => ({ unit: "px", size: Math.round(v), sizes: [] });
  s._position = "absolute";
  s._element_width = "auto";
  const left = r.left - p.left, right = p.right - r.right, top = r.top - p.top, bottom = p.bottom - r.bottom;
  if (right < left) { s._offset_orientation_h = "end"; s._offset_x_end = px(right); }
  else { s._offset_orientation_h = "start"; s._offset_x = px(left); }
  if (bottom < top) { s._offset_orientation_v = "end"; s._offset_y_end = px(bottom); }
  else { s._offset_orientation_v = "start"; s._offset_y = px(top); }
  if (!s._z_index) s._z_index = "1";
}

/**
 * 按「长什么样」识别图片卡：1 张图 + 标题 + （可选）描述，标题/描述可以是任意标签。
 *
 * ⚠ 原来的 looksLikeImageBox 只认 h1–h6 + p。真实站点绝大多数这样写：
 *   <div class="tool-name">（粗体 16px 深色）+ <div class="tool-desc">（14px 灰色）——
 *   于是一张卡被拆成 5 层嵌套的容器 + 文本编辑器，图标缩成点，标题成了普通文字。
 *   选型基准里的卡片样本全是 h3+p，所以基准一直是绿的 —— 这是基准的盲区。
 * 标题靠视觉判：字重 ≥600 且比描述重，或字号比描述大 10% 以上；分不出主次就不认（宁可不认，不能认错）。
 * 卡上绝对定位的小角标（「hot」「NEW」）单独拿出来，不算正文。
 */
function visualCardParts(node, win) {
  if (!win || !CARD_ROOT_TAGS.has(node.tagName)) return null;
  const all = [...node.querySelectorAll("*")];
  const isHidden = el => win.getComputedStyle(el).visibility === "hidden";
  // 角标：绝对定位、字很短、没有图片、面积远小于卡片
  const nodeRect = node.getBoundingClientRect();
  if (!nodeRect.width || !nodeRect.height) return null;
  const badges = all.filter(el => {
    const cs = win.getComputedStyle(el);
    if (cs.position !== "absolute" || isHidden(el) || el.querySelector("img")) return false;
    const r = el.getBoundingClientRect();
    const t = cleanText(el.textContent);
    return t && t.length <= 12 && r.width < nodeRect.width * 0.4 && r.height < nodeRect.height * 0.6;
  });
  if (badges.length > 1) return null;
  const badge = badges[0] || null;
  const inBadge = el => badge && (el === badge || badge.contains(el));
  const hidden = all.filter(el => isHidden(el) && !inBadge(el));
  const content = all.filter(el => !inBadge(el) && !hidden.some(h => h === el || h.contains(el)));
  const imgs = content.filter(el => el.tagName === "IMG");
  if (imgs.length !== 1) return null;
  // ⚠ 必须忽略大小写：SVG 元素在 HTML 文档里的 tagName 是小写「svg」。原来写成 /SVG/ 永远匹配不到，
  //   团队成员卡（头像+姓名+职位+社交图标）被整张认成图片框，两个社交链接直接丢了。
  if (content.some(el => /^(BUTTON|INPUT|SELECT|TEXTAREA|UL|OL|TABLE|FORM|VIDEO|IFRAME|SVG)$/i.test(el.tagName))) return null;
  // 卡片里另有可点的链接（社交图标、「阅读更多」）：图片框只有一个整卡链接，装不下，不认
  if (content.some(el => el.tagName === "A" && el.getAttribute("href"))) return null;
  // 文字叶子：自身直接带文字的元素
  const leaves = content.filter(el => [...el.childNodes].some(n => n.nodeType === 3 && cleanText(n.textContent)));
  if (leaves.length < 1 || leaves.length > 2) return null;
  // 不能有游离文字（全部文字都要落在这 1–2 个叶子里）
  const squash = v => String(v || "").replace(/\s+/g, "");
  const leafText = leaves.map(l => squash(l.textContent)).join("");
  let bodyText = squash(node.textContent);
  const outermostHidden = hidden.filter(h => !hidden.some(o => o !== h && o.contains(h)));
  for (const x of [badge, ...outermostHidden]) if (x) bodyText = bodyText.replace(squash(x.textContent), "");
  if (leafText !== bodyText) return null;
  const weight = el => Number(win.getComputedStyle(el).fontWeight) || 400;
  const size = el => parseFloat(win.getComputedStyle(el).fontSize) || 16;
  let titleEl, descEl = null;
  if (leaves.length === 1) {
    titleEl = leaves[0];
    if (!(weight(titleEl) >= 600 || size(titleEl) >= 18)) return null;
  } else {
    const [a, b] = leaves;
    const score = el => weight(el) + size(el) * 20;
    [titleEl, descEl] = score(a) >= score(b) ? [a, b] : [b, a];
    const heavier = weight(titleEl) >= 600 && weight(titleEl) >= weight(descEl) + 100;
    const bigger = size(titleEl) >= size(descEl) * 1.1;
    if (!heavier && !bigger) return null;
    if (squash(titleEl.textContent).length > 80) return null;   // 太长的不是标题
  }
  return { img: imgs[0], titleEl, descEl, badge };
}

/**
 * 卡片内容到卡片四边的实际距离。
 * ⚠ 很多卡片自身 padding 为 0，留白靠子元素的 margin 撑出来（腾讯工具页：图片 margin-left 20、
 *   文字块 margin-left 10、右侧空 30）。转成图片框后子元素的 margin 全没了，图标会贴着卡片左边。
 *   所以用「内容包围盒到四边的距离」当小组件的内边距，这个值同时涵盖了 padding 和子元素 margin。
 */
function contentInsets(node, els) {
  const c = node.getBoundingClientRect();
  const rs = els.filter(Boolean).map(e => e.getBoundingClientRect()).filter(r => r.width || r.height);
  if (!rs.length || !c.width) return null;
  const clamp = v => Math.max(0, Math.round(v));
  return {
    top: clamp(Math.min(...rs.map(r => r.top)) - c.top),
    right: clamp(c.right - Math.max(...rs.map(r => r.right))),
    bottom: clamp(c.bottom - Math.max(...rs.map(r => r.bottom))),
    left: clamp(Math.min(...rs.map(r => r.left)) - c.left),
  };
}
const insetsToDims = i => ({ unit: "px", top: String(i.top), right: String(i.right), bottom: String(i.bottom), left: String(i.left), isLinked: i.top === i.right && i.right === i.bottom && i.bottom === i.left });

/** 图片卡的统一识别入口：先认语义标签（h/p），再按视觉认。 */
function imageCardParts(node, win) {
  if (looksLikeImageBox(node)) {
    return { img: node.querySelector("img"), titleEl: node.querySelector("h1,h2,h3,h4,h5,h6"), descEl: node.querySelector("p"), badge: null };
  }
  return visualCardParts(node, win);
}

/**
 * SVG 画的星级：3–10 个 SVG 并排、没有文字、每个 SVG 的路径完全相同（同一个星形）。
 * 亮星 = 和第一颗同色的那些；aria-label 里写了分数就以它为准。
 * 原来 5 个 SVG 各自变成一个原始 HTML 小组件。
 */
function svgStars(node) {
  const kids = [...node.children];
  if (kids.length < 3 || kids.length > 10 || cleanText(node.textContent)) return null;
  if (!kids.every(k => /^svg$/i.test(k.tagName))) return null;
  const pathOf = svg => svg.querySelector("path")?.getAttribute("d") || "";
  const first = pathOf(kids[0]);
  if (!first || !kids.every(k => pathOf(k) === first)) return null;
  const fillOf = svg => svg.getAttribute("fill") || svg.querySelector("path")?.getAttribute("fill") || svg.getAttribute("color") || "";
  const on = fillOf(kids[0]);
  const lit = kids.filter(k => fillOf(k) === on).length;
  const off = kids.map(fillOf).find(f => f !== on) || "";
  return { total: kids.length, lit, on, off };
}

/** div 写的手风琴：每一项 = 带 aria-expanded / aria-controls 的触发器 + 紧跟的面板。 */
function ariaAccordionItems(node) {
  const items = [...node.children];
  if (!items.length || items.length > 30) return null;
  const out = [];
  for (const item of items) {
    if (item.children.length !== 2) return null;
    const [head, panel] = item.children;
    // ⚠ 触发器必须就是标题行本身，或是标题行唯一的子元素（<h3><button aria-expanded>）。
    //   原来在标题行里随便深找一个 —— 外层包裹 div 只有一个子元素（整个 FAQ）时，被当成「一项」：
    //   第一个问题成了标题，第二个问题整个塞进了内容。
    const isTrigger = el => el.matches("[aria-expanded],[aria-controls]");
    const trigger = isTrigger(head) ? head : (head.children.length === 1 && isTrigger(head.children[0]) ? head.children[0] : null);
    if (!trigger || !cleanText(trigger.textContent) || panel.matches("[aria-expanded],[aria-controls]")) return null;
    out.push({ title: cleanText(trigger.textContent), content: panel.innerHTML.trim() });
  }
  return out;
}

/** Bootstrap 选项卡：导航（data-bs-toggle="tab"/"pill"）+ .tab-content 里的 .tab-pane，按 href="#id" 对应。 */
function bootstrapTabs(node) {
  const kids = [...node.children];
  if (kids.length !== 2) return null;
  const toggle = "[data-bs-toggle='tab'],[data-toggle='tab'],[data-bs-toggle='pill'],[data-toggle='pill']";
  const nav = kids.find(k => k.querySelector(toggle));
  const content = kids.find(k => k.classList.contains("tab-content"));
  if (!nav || !content || nav === content) return null;
  const links = [...nav.querySelectorAll(toggle)];
  const panes = [...content.children].filter(p => p.classList.contains("tab-pane"));
  if (!links.length || !panes.length) return null;
  return links.map((a, i) => {
    const target = (a.getAttribute("href") || a.getAttribute("data-bs-target") || a.getAttribute("data-target") || "").replace(/^#/, "");
    const pane = panes.find(p => p.id && p.id === target) || panes[i];
    return { title: cleanText(a.textContent), content: pane ? pane.innerHTML.trim() : "" };
  });
}

/** 表单里「不是字段、不是按钮、不是标签」的文字块，取最外层的那个，按文档顺序。 */
function formExtraText(form) {
  const skip = "label, button, select, option, textarea, input, legend";
  const out = [];
  for (const el of form.querySelectorAll("*")) {
    if (el.matches(skip) || el.closest(skip)) continue;
    if (out.some(o => o.contains(el))) continue;
    const ownText = [...el.childNodes].some(n => n.nodeType === 3 && cleanText(n.textContent));
    if (!ownText) continue;
    // 块里如果还夹着字段，说明它是布局包裹不是说明文字
    if (el.querySelector("input, select, textarea, button")) continue;
    out.push(el);
  }
  return out;
}

/** 只含文字和行内标签的叶子元素（span/label/small/time/dt/dd/td…），没有图片/图标/块级子元素。 */
const INLINE_LEAF_TAGS = new Set(["SPAN", "LABEL", "SMALL", "TIME", "DT", "DD", "TD", "TH", "CAPTION", "LEGEND", "SUMMARY", "OUTPUT", "BDI", "BDO", "DFN", "SAMP"]);
function isInlineTextLeaf(node) {
  if (!INLINE_LEAF_TAGS.has(node.tagName) || !cleanText(node.textContent)) return false;
  for (const el of node.querySelectorAll("*")) {
    if (!(INLINE_TEXT_TAGS.has(el.tagName) || el.tagName === "SPAN" || el.tagName === "BR" || el.tagName === "WBR")) return false;
    if (el.tagName === "A" && el.querySelector("img, svg")) return false;
  }
  return true;
}

/**
 * 块级元素里只有「直接文字 + 行内标签」：至少一段非空的直接文字，后代全是行内文字标签且真的按行内排（computed display 是 inline*）、
 * 没有浮动 / 绝对定位。自己是 flex/grid 的不算 —— 那时子元素各自是一个排版块。
 */
function isInlineContentBlock(node, style, win) {
  if (!win || !/^(block|inline-block|list-item|flow-root)$/.test(style.display)) return false;
  if (![...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && cleanText(child.textContent))) return false;
  const descendants = [...node.querySelectorAll("*")];
  if (!descendants.length) return false;   // 纯文字的 div 由文字节点分支处理，维持原状
  return descendants.every(el => {
    if (!(INLINE_TEXT_TAGS.has(el.tagName) || el.tagName === "SPAN" || el.tagName === "BR" || el.tagName === "WBR")) return false;
    if (el.tagName === "A" && el.querySelector("img, svg")) return false;
    if (el.tagName === "BR" || el.tagName === "WBR") return true;
    const s = win.getComputedStyle(el);
    // 只认真正随文字排的 display:inline。inline-block / inline-flex 是自带盒子的东西（句子里的按钮、胶囊），
    //   并进一段文字就丢了按钮小组件（自审发现）。
    return s.display === "inline" && s.float === "none" && !/^(absolute|fixed)$/.test(s.position) && !looksLikeButton(el, s);
  });
}

/** ul/ol 是不是被拿来做布局：flex/grid 排版，或者里面装着图片、图标、块级内容。纯文字链接列表不算。 */
function isLayoutList(node, win) {
  if (!node || !/^(UL|OL)$/.test(node.tagName) || !win) return false;
  if (/flex|grid/.test(win.getComputedStyle(node).display)) return true;
  return !!node.querySelector("img, svg, h1, h2, h3, h4, h5, h6, p, div, button, form, table, video");
}

/** 返回结构上确定的目标组件；不确定就返回 null，交给原来的流程。 */
function structuralTarget(node, win) {
  const tag = node.tagName;
  if (tag === "PROGRESS") return "widget:progress";
  if (node.getAttribute("role") === "alert" && cleanText(node.textContent) && !node.querySelector("img, form, table, h1, h2, video, iframe")) return "widget:alert";
  const kids = [...node.children];
  if (kids.length >= 2 && kids.some(c => c.getAttribute("role") === "tablist") && kids.some(c => c.getAttribute("role") === "tabpanel")
    && kids.every(c => ["tablist", "tabpanel"].includes(c.getAttribute("role")))) return "widget:tabs";
  if (starText(node) || svgStars(node)) return "widget:star-rating";
  if (bootstrapTabs(node)) return "widget:tabs";
  if (ariaAccordionItems(node)) return "widget:accordion";
  // 一串并列的 <details>（FAQ 列表）= 一个手风琴。原来每个 <details> 各自变成一个只有一项的手风琴（2026-10-15 Northwind 测试页）。
  if (kids.length >= 2 && kids.every(c => c.tagName === "DETAILS" && c.querySelector(":scope > summary"))) return "widget:accordion";
  if (socialLinks(node)) return "widget:social-icons";
  if (CONTAINER_TAGS.has(tag) || tag === "UL") {
    if (galleryItems(node)) return "widget:image-gallery";
  }
  if (!win) return null;
  if (progressParts(node, win)) return "widget:progress";
  if (counterParts(node, win)) return "widget:counter";
  if (testimonialParts(node, win)) return "widget:testimonial";
  if (spacerHeight(node, win)) return "widget:spacer";
  return null;
}

function parseForAnalysis(source) {
  const doc = new DOMParser().parseFromString(source, "text/html");
  const nodes = [...doc.body.querySelectorAll("*")];
  const nodeIds = new Map(nodes.map((node, index) => [node, `n${index}`]));
  return { nodes, nodeIds };
}

function analyzeNode(node, index, nodeIds) {
  const suggestion = mappingSuggestion(node);
  const directText = [...node.childNodes]
    .filter(child => child.nodeType === Node.TEXT_NODE)
    .map(child => child.textContent)
    .join(" ");
  const rawPreview = node.getAttribute("alt")
    || node.getAttribute("aria-label")
    || directText
    || node.querySelector("img[alt]")?.getAttribute("alt")
    || boundedDescendantText(node)
    || "";
  const text = cleanText(rawPreview.slice(0, 500));
  return {
    id: `n${index}`,
    parentId: nodeIds.get(node.parentElement) || "",
    tag: node.tagName.toLowerCase(),
    path: elementPath(node),
    preview: text.slice(0, 72) || node.getAttribute("src")?.slice(0, 72) || "无文本内容",
    ...suggestion
  };
}

export function analyzeHtml(source, limit = Number.POSITIVE_INFINITY) {
  const { nodes, nodeIds } = parseForAnalysis(source);
  const items = nodes.slice(0, limit).map((node, index) => analyzeNode(node, index, nodeIds));
  return { items, total: nodes.length, truncated: nodes.length > limit };
}

// Chunked variant: yields to the event loop every 200 nodes so a large document
// stays responsive and can paint a progress indicator. Output is identical to analyzeHtml.
export async function analyzeHtmlChunked(source, { onProgress, limit = Number.POSITIVE_INFINITY } = {}) {
  const { nodes, nodeIds } = parseForAnalysis(source);
  const capped = nodes.slice(0, limit);
  const items = [];
  for (let index = 0; index < capped.length; index++) {
    items.push(analyzeNode(capped[index], index, nodeIds));
    if ((index & 199) === 199) {
      onProgress?.((index + 1) / capped.length);
      await new Promise(resolve => setTimeout(resolve));
    }
  }
  onProgress?.(1);
  return { items, total: nodes.length, truncated: nodes.length > limit };
}

function elementPath(node) {
  const parts = [];
  let current = node;
  while (current && current.tagName !== "BODY" && parts.length < 5) {
    let part = current.tagName.toLowerCase();
    if (current.id) part += `#${current.id}`;
    else if (current.classList.length) part += `.${[...current.classList].slice(0, 2).join(".")}`;
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(" > ");
}

function markMappingNodes(doc) {
  [...doc.body.querySelectorAll("*")].forEach((node, index) => node.setAttribute(INTERNAL_MAPPING_ATTRIBUTE, `n${index}`));
}

function svgPathForIcon(node) {
  const text = cleanText(node.textContent);
  if (SVG_ICON_PATHS.has(text)) return SVG_ICON_PATHS.get(text);
  const definition = iconDefinition(node)?.[0] || "";
  if (/\bfa-check\b/.test(definition)) return '<path d="m12 32 12 12 28-30" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>';
  if (/\bfa-(?:times|xmark|close)\b/.test(definition)) return '<path d="M17 17l30 30M47 17 17 47" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>';
  if (/\bfa-star\b/.test(definition)) return '<path d="m32 7 7.5 15.2 16.8 2.4-12.1 11.8 2.8 16.7L32 45.2 17 53.1l2.8-16.7L7.7 24.6l16.8-2.4z" fill="currentColor"/>';
  if (/\bfa-heart\b/.test(definition)) return '<path d="M32 53S8 40 8 23c0-12 15-17 24-6 9-11 24-6 24 6 0 17-24 30-24 30z" fill="currentColor"/>';
  if (/\bfa-arrow-left\b/.test(definition)) return '<path d="M56 32H12M27 17 12 32l15 15" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>';
  if (/\bfa-arrow-right\b/.test(definition)) return '<path d="M8 32h44M37 17l15 15-15 15" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>';
  if (/\bfa-plus\b/.test(definition)) return '<path d="M32 11v42M11 32h42" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>';
  if (/\bfa-minus\b/.test(definition)) return '<path d="M11 32h42" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>';
  return '<path d="M32 8 56 32 32 56 8 32z" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/>';
}

function svgMarkup(node) {
  let markup;
  if (String(node.tagName || "").toUpperCase() === "SVG") {
    markup = node.outerHTML.includes("xmlns=")
      ? node.outerHTML
      : node.outerHTML.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  } else {
    const path = svgPathForIcon(node);
    markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${path}</svg>`;
  }
  return markup;
}

function svgIconHtml(node, style, options) {
  const size = parseFloat(style.width) || parseFloat(style.fontSize) || 24;
  const colorValue = options.colorMode === "site" ? "currentColor" : color(style.color);
  return `<span class="hte-inline-svg-icon" style="display:inline-flex;width:${size}px;height:${size}px;color:${colorValue}">${svgMarkup(node)}</span>`;
}

function convertIcon(node, style, options) {
  if (options.iconMode === "preserve") return htmlWidget(node.outerHTML);
  const common = commonSettings(node, style);
  if (options.iconMode === "svg") {
    warning(options.warnings || [], "svg-icon-inline-html", "Icons were kept as inline SVG so they do not become placeholders after import.");
    return htmlWidget(svgIconHtml(node, style, options));
  }
  const definition = iconDefinition(node);
  if (!definition) {
    // 匹配不到图标库时：无类内联 SVG 用尺寸化的内联 SVG 兜底，避免脱离页面 CSS 后按默认尺寸放大、fill 变黑。
    if (String(node.tagName || "").toUpperCase() === "SVG") {
      warning(options.warnings || [], "svg-icon-sized-fallback", "Inline SVG icons with no match in the icon library were kept at their rendered size.");
      return htmlWidget(svgIconHtml(node, style, options));
    }
    return htmlWidget(node.outerHTML);
  }
  const settings = {
    ...common,
    selected_icon: { value: definition[0], library: definition[1] },
    view: "default",
    align: normalizeAlign(style.textAlign, style.direction) || "center",
    size: unit(style.fontSize) || { unit: "px", size: 24, sizes: [] }
  };
  if (options.colorMode !== "site") settings.primary_color = color(style.color);
  // 外框（底色 / 边框方块）+ 图标 → Icon 小组件的 stacked / framed 视图，逻辑与图标框相同（iconFrameSettings）；
  // 尺寸按图标本体（字号 / SVG 宽度），不按外框。
  const win = node.ownerDocument && node.ownerDocument.defaultView;
  if (win) {
    const inner = /^(SVG|I)$/i.test(node.tagName) ? node : (node.querySelector("svg, i[class]") || node);
    const px = iconGlyphSize(node, win);
    if (px >= 4) {
      settings.size = { unit: "px", size: Math.round(px), sizes: [] };
      const frame = iconFrameSettings(inner, node.parentElement, win, px, options);
      if (frame) Object.assign(settings, frame);
    }
  }
  return widgetWithGlobals("icon", settings, options);
}

function hasVisualFrame(style) {
  return !!color(style.backgroundColor) || (style.backgroundImage && style.backgroundImage !== "none")
    || (parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== "none");
}

// 关键词 → Font Awesome 图标（按图标类名/aria-label/<title> + 卡片标题文字匹配）。
const ICON_KEYWORD_FA = [
  [/shield|secure|safe|protect|guard/, "fas fa-shield-alt"],
  [/check|tick|verified|quality|approve/, "fas fa-check-circle"],
  [/star|rating|favou?rite|premium/, "fas fa-star"],
  [/heart|love|\bcare\b/, "fas fa-heart"],
  [/bolt|fast|speed|flash|lightning|power|instant/, "fas fa-bolt"],
  [/leaf|eco|green|natural|organic/, "fas fa-leaf"],
  [/recycle|reuse|reusable|durable|sustain/, "fas fa-recycle"],
  [/hand|grip|touch|ergonomic|comfort/, "fas fa-hand-paper"],
  [/gear|cog|setting|custom|config|option/, "fas fa-cog"],
  [/lock|privacy|private|encrypt/, "fas fa-lock"],
  [/truck|ship|delivery|deliver|logistic/, "fas fa-truck"],
  [/clock|time|quick|schedule/, "fas fa-clock"],
  [/wrench|tool|repair|maintain/, "fas fa-wrench"],
  [/water|drop|liquid|clean|wash|rinse/, "fas fa-tint"],
  [/microfiber|fiber|fibre|cloth|towel|fabric|soft|smooth|surface/, "fas fa-feather"],
  [/box|package|product|kit/, "fas fa-box"],
  [/globe|world|global|international/, "fas fa-globe"],
  [/phone|call|contact/, "fas fa-phone"],
  [/envelope|email|mail|message/, "fas fa-envelope"],
  [/user|person|people|team|expert/, "fas fa-user"],
  [/award|medal|trophy|\bwin\b|best|certified/, "fas fa-award"],
  [/dollar|price|cost|money|value|save|budget/, "fas fa-dollar-sign"],
  [/thumbs?-?up|\blike\b|recommend/, "fas fa-thumbs-up"],
  [/leather|vinyl|plastic|trim|material/, "fas fa-layer-group"]
];
function matchIconName(iconNode, hintText) {
  if (iconNode) {
    const def = iconDefinition(iconNode); // 源码已是 Font Awesome / eicon → 直接用
    if (def) return { value: def[0], library: def[1] };
  }
  const bits = [];
  if (iconNode) {
    bits.push(iconNode.getAttribute("class") || "");
    bits.push(iconNode.getAttribute("aria-label") || "");
    bits.push(iconNode.getAttribute("data-icon") || "");
    bits.push(iconNode.getAttribute("alt") || "");
    const titleEl = iconNode.querySelector ? iconNode.querySelector("title") : null;
    if (titleEl) bits.push(titleEl.textContent || "");
  }
  if (hintText) bits.push(hintText); // 卡片标题是最强的语义线索
  const signal = bits.join(" ").toLowerCase();
  for (let i = 0; i < ICON_KEYWORD_FA.length; i++) {
    if (ICON_KEYWORD_FA[i][0].test(signal)) return { value: ICON_KEYWORD_FA[i][1], library: "fa-solid" };
  }
  return { value: "", library: "" }; // 匹配不到 → 空，用户在 Elementor 图标库里选
}

// 卡片模式识别：容器内恰好 1 个标题 + 1 段文本 + ≥1 个图标，且无其他内容元素 → Elementor 图标框。
function looksLikeIconBox(node) {
  if (!CARD_ROOT_TAGS.has(node.tagName)) return false;
  const headings = node.querySelectorAll("h1,h2,h3,h4,h5,h6");
  const paras = node.querySelectorAll("p");
  if (headings.length !== 1 || paras.length !== 1) return false;
  const icon = node.querySelector("svg, i[class], [class*='icon'], [class*='fa-'], [class*='eicon']");
  if (!icon) return false;
  // 不能含其他内容元素（按钮/链接/图片/列表/表格/表单/视频等），否则不是纯图标卡。
  if (node.querySelector("a, button, img, ul, ol, table, form, input, select, textarea, video, iframe")) return false;
  // 图标不能包住标题/段落（避免整卡被当成图标）。
  if (icon.querySelector && icon.querySelector("h1,h2,h3,h4,h5,h6,p")) return false;
  return true;
}

// 图标框里那个图标能不能落到图标库（与 buildIconBox 取图标、取标题的方式一致）。
function iconBoxIconMatches(node) {
  const iconNode = node.querySelector("svg, i[class]") || node.querySelector("[class*='icon'], [class*='fa-'], [class*='eicon']");
  const heading = node.querySelector("h1,h2,h3,h4,h5,h6");
  if (!matchIconName(iconNode, heading ? cleanText(heading.textContent) : "").value) return false;
  // 源里是一枚内联 SVG、只能按标题关键词「猜」字体图标时：同一排的兄弟卡片只要有一张猜不出，整排都保留原 SVG。
  //   否则一排里一半是原图标、一半是猜出来的实心图标（盾牌猜成锁、多人猜成单人；2026-10-15 Northwind 测试页）。
  //   单独一张卡、或整排都能猜中时照旧转图标框（「Instant」+ 闪电 → fa-bolt，线上选型基准的用例）。
  if (iconNode && iconNode.tagName.toLowerCase() === "svg" && !iconDefinition(iconNode)) {
    const siblings = [...(node.parentElement?.children || [])].filter(sib => sib !== node && looksLikeIconBox(sib));
    return siblings.every(sib => {
      const sibIcon = sib.querySelector("svg, i[class]") || sib.querySelector("[class*='icon'], [class*='fa-'], [class*='eicon']");
      const sibHeading = sib.querySelector("h1,h2,h3,h4,h5,h6");
      return !!matchIconName(sibIcon, sibHeading ? cleanText(sibHeading.textContent) : "").value;
    });
  }
  return true;
}

// 图标本体的显示尺寸：内联 SVG 取渲染宽度；<i> 字体图标、✓ ★ → 这类符号取字号。拿不到返回 0。
function iconGlyphSize(iconNode, win) {
  if (!win || !win.getComputedStyle) return 0;
  const inner = iconNode.matches("svg, i[class]") ? iconNode : iconNode.querySelector("svg, i[class]");
  if (inner && inner.tagName.toLowerCase() === "svg") {
    const r = inner.getBoundingClientRect();
    return r.width || r.height || 0;
  }
  if (inner) return parseFloat(win.getComputedStyle(inner).fontSize) || 0;
  if (isGlyphIcon(iconNode.textContent)) return parseFloat(win.getComputedStyle(iconNode).fontSize) || 0;
  return 0;
}

// 图标外框：源里常见「带底色或边框的方块 / 圆 + 里面一个小图标」。Elementor 图标框的 stacked / framed 视图就是这个形状
// （icon-box.php:127 view / :145 shape / :419 primary_color / :435 secondary_color / :540 icon_padding / :619 border_radius）：
//   stacked：底色 = primary_color，图标色 = secondary_color；framed：图标与边框色 = primary_color，底色 = secondary_color
//   方块边长 = icon_size + 2 × icon_padding；圆角够一半 → circle，否则 rounded + 精确 border_radius。
// 外框取图标节点自己或它的直接父级（父级不能是卡片本身）。没有外框返回 null，维持 default 视图。
function iconFrameSettings(iconNode, cardNode, win, iconPx, options) {
  if (!win || !win.getComputedStyle) return null;
  const candidates = [iconNode];
  if (iconNode.parentElement && iconNode.parentElement !== cardNode) candidates.push(iconNode.parentElement);
  const hasBg = s => { const c = color(s.backgroundColor); return !!c && c !== "transparent"; };
  const hasBorder = s => parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== "none";
  const frameNode = candidates.find(n => { const s = win.getComputedStyle(n); return hasBg(s) || hasBorder(s); });
  if (!frameNode) return null;
  const fs = win.getComputedStyle(frameNode);
  const rect = frameNode.getBoundingClientRect();
  const side = Math.min(rect.width, rect.height);
  if (!side || side < iconPx) return null;
  const inner = iconNode.matches("svg, i[class]") ? iconNode : (iconNode.querySelector("svg, i[class]") || iconNode);
  const glyphColor = color(win.getComputedStyle(inner).color);
  const stacked = hasBg(fs);
  const out = {
    view: stacked ? "stacked" : "framed",
    icon_padding: { unit: "px", size: Math.max(0, Math.round((side - iconPx) / 2)), sizes: [] }
  };
  const radius = parseFloat(fs.borderTopLeftRadius) || 0;
  if (radius >= side / 2 - 0.5) out.shape = "circle";
  else if (radius > 0) {
    const r = String(Math.round(radius));
    out.shape = "rounded";
    out.border_radius = { unit: "px", top: r, right: r, bottom: r, left: r, isLinked: true };
  } else out.shape = "square";
  if (!stacked) {
    const w = String(Math.round(parseFloat(fs.borderTopWidth)));
    out.border_width = { unit: "px", top: w, right: w, bottom: w, left: w, isLinked: true };
  }
  if (options.colorMode !== "site") {
    if (stacked) {
      out.primary_color = color(fs.backgroundColor);
      if (glyphColor) out.secondary_color = glyphColor;
    } else {
      out.primary_color = glyphColor || color(fs.borderTopColor);
      out.secondary_color = "";
    }
  }
  return out;
}

// 从卡片结构与已有值配好一个 Elementor 图标框（icon-box）：标题/描述/图标标签，图标按名匹配否则留空。
function buildIconBox(node, style, win, options) {
  const heading = node.querySelector("h1,h2,h3,h4,h5,h6");
  const para = node.querySelector("p");
  const iconNode = node.querySelector("svg, i[class]") || node.querySelector("[class*='icon'], [class*='fa-'], [class*='eicon']");
  const gcs = n => (n && win && win.getComputedStyle ? win.getComputedStyle(n) : null);
  const hStyle = gcs(heading);
  const pStyle = gcs(para);
  const iStyle = gcs(iconNode);
  const headingText = heading ? cleanText(heading.textContent) : "";
  const settings = {
    selected_icon: matchIconName(iconNode, headingText),
    view: "default",
    position: "block-start",
    title_text: headingText,
    description_text: para ? cleanText(para.textContent) : "",
    title_size: heading ? heading.tagName.toLowerCase() : "h3",
    text_align: normalizeAlign(style.textAlign, style.direction) || "center"
  };
  // 图标大小 + 图标到内容的间距（尽量贴近源，让图标框不至于偏小偏挤）。
  let frame = null;
  if (iconNode) {
    // 图标本体尺寸：SVG 取渲染宽度，字体图标 / 符号取字号（Elementor 的图标是 1em 见方，icon_size 就是字号）。
    // ⚠ 不能直接取 iconNode 的宽度：iconNode 常是「48px 带底色方块」本身，里面的符号只有 22px ——
    //   原来这样取，真实 Elementor 渲染比对里图标整整大一倍、底色方块消失。
    let iconPx = iconGlyphSize(iconNode, win);
    if (!iconPx) {
      iconPx = parseFloat(iStyle && iStyle.width) || parseFloat(iStyle && iStyle.height) || 0;
      if ((!iconPx || iconPx < 4) && iconNode.getBoundingClientRect) {
        const rect = iconNode.getBoundingClientRect();
        iconPx = rect.width || rect.height || 0;
      }
    }
    if (iconPx >= 4) settings.icon_size = { unit: "px", size: Math.round(iconPx), sizes: [] }; // Icon Box 图标尺寸键是 icon_size（不是 Icon 组件的 size），已对官方源码 icon-box.php:523 核对
    frame = iconPx >= 4 ? iconFrameSettings(iconNode, node, win, iconPx, options) : null;
    if (frame) Object.assign(settings, frame);
    // 图标到标题的间距通常在图标外层包裹 div（如 .icon）上，不在 svg 上。
    const iconBlock = (iconNode.parentElement && iconNode.parentElement !== node) ? iconNode.parentElement : iconNode;
    const ibStyle = gcs(iconBlock);
    // 图标在文字的哪一侧 + 间距：按渲染位置判断（icon-box.php:234 position，取值 block-start / inline-start / inline-end / block-end）。
    // ⚠ 原来固定 top：Bootstrap 的「图标在左、文字在右」特性列表导入后全变成图标在上（真实渲染比对抓出）。
    //   手机端有自己的默认值 block-start（mobile_default），要显式写同一个值，否则手机上又变回图标在上。
    const ir = iconBlock.getBoundingClientRect ? iconBlock.getBoundingClientRect() : null;
    const hr = heading && heading.getBoundingClientRect ? heading.getBoundingClientRect() : null;
    let position = "block-start", space = ibStyle ? parseFloat(ibStyle.marginBottom) || 0 : 0;
    if (ir && hr && ir.width && hr.width) {
      if (ir.right <= hr.left + 2) { position = "inline-start"; space = hr.left - ir.right; }
      else if (ir.left >= hr.right - 2) { position = "inline-end"; space = ir.left - hr.right; }
      else if (ir.top >= hr.bottom - 2) { position = "block-end"; space = ir.top - hr.bottom; }
      else space = Math.max(0, hr.top - ir.bottom);
    }
    settings.position = position;
    settings.position_mobile = position;
    settings.icon_space = { unit: "px", size: Math.max(0, Math.round(space)), sizes: [] };
  }
  // 标题 / 描述排版（字号、字重、行高等，复用 typography 助手；它自身已判 fontMode）。
  if (hStyle) typography(settings, "title_typography", hStyle, options);
  if (pStyle) typography(settings, "description_typography", pStyle, options);
  if (hStyle) {
    const titleGap = unit(hStyle.marginBottom);
    if (titleGap) settings.title_bottom_space = titleGap; // 标题到描述的间距
  }
  if (options.colorMode !== "site") {
    if (hStyle) settings.title_color = color(hStyle.color);
    if (pStyle) settings.description_color = color(pStyle.color);
    if (iStyle && !frame) settings.primary_color = color(iStyle.color);
  }
  // 参与构成图标框的子节点标记为已转换，避免被单独再处理或当作裸 HTML 保留。
  options.convertedNodes.add(node);
  [heading, para, iconNode].forEach(n => n && options.convertedNodes.add(n));
  return widgetWithGlobals("icon-box", settings, options);
}

// 图片卡识别：容器内恰好 1 张图片 + 1 个标题 + ≤1 段文本，且无其它内容元素、无多余文字（如步骤序号）→ Elementor 图片框。
/**
 * 卡片 → 图片框/图标框，外框（背景/边框/圆角/阴影）转到小组件自身，直接进父级。
 *
 * ⚠ 识别器是「这个节点里恰好 1 张图 + 1 个标题 + 至多 1 段文字」，所以**只包着一张卡的外层 div
 *   同样满足**。原来直接在最外层建小组件，于是：
 *   - 链接丢了：<a> 在里面，buildImageBox 用 closest("a") 只会往上找；
 *   - 卡片自己的背景、圆角、内边距、阴影丢了：外框取的是那个外层 div 的（通常什么都没有）。
 *   扩展里用户最常做的就是「选中一张卡」，而选择器还会在根外面再套一层保宽度的 div ——
 *   等于每次选单张卡都中招。多张卡并列时外层有多张图，识别不成立，所以之前没暴露。
 * 现在：沿「只有一个子元素、且子元素也是卡」的链往里走到最内层建小组件；
 *   外框取链上第一个真有外框的节点；链接取链上任一带 href 的 <a>；宽度仍按最外层在父级里的占比。
 */
function buildCardWidget(node, style, win, options, detect, build) {
  const chain = [node];
  let inner = node;
  while (inner.children.length === 1 && detect(inner.children[0])) {
    inner = inner.children[0];
    chain.push(inner);
  }
  const styleOf = (n) => (n === node ? style : win.getComputedStyle(n));
  const widget = build(inner, styleOf(inner), win, options);
  const frameNode = chain.find((n) => {
    const probe = {};
    backgroundAndBorder(probe, styleOf(n), options);
    return Object.keys(probe).length > 0;
  }) || node;
  const anchor = chain.find((n) => n.tagName === "A" && n.getAttribute("href"));
  chain.forEach((n) => options.convertedNodes.add(n));

  // 卡上有角标（「hot」「NEW」）：图片框装不下子元素，外面包一层卡片容器，
  // 容器承载外框（背景/圆角/阴影/内边距）和链接，里面是图片框 + 绝对定位的角标。
  // 原来角标被当普通弹性子项，拉伸成整卡高度的色条。
  const parts = detect(inner);
  const badge = parts && typeof parts === "object" ? parts.badge : null;
  // 内边距取「内容到卡片四边的实际距离」（涵盖子元素 margin 撑出来的留白），与图片百分比同一口径
  const insets = parts && typeof parts === "object" ? contentInsets(inner, [parts.img, parts.titleEl, parts.descEl]) : null;
  if (badge) {
    const badgeWidget = buildBadge(badge, frameNode, win, options);
    delete widget.settings.link;   // 链接放在外层容器上：嵌套 <a> 会弄坏排版（container.php 的官方警告）
    const wrap = container(frameNode, styleOf(frameNode), [widget, badgeWidget], options);
    // 竖排 + 拉伸：卡片原本是横排弹性盒，照搬的话图片框会被挤成内容宽
    wrap.settings.flex_direction = "column";
    wrap.settings.flex_align_items = "stretch";
    if (insets) wrap.settings.padding = insetsToDims(insets);
    if (anchor) { wrap.settings.html_tag = "a"; wrap.settings.link = linkValue(anchor); }
    options.convertedNodes.add(badge);
    return wrap;
  }
  applyCardFrameToWidget(widget, frameNode, styleOf(frameNode), options);
  if (insets) widget.settings._padding = insetsToDims(insets);
  if (!widget.settings.link?.url && anchor) widget.settings.link = linkValue(anchor);
  return widget;
}

/** 角标 → 标题小组件（span），绝对定位到卡片角上，保留底色/圆角/内边距/字号颜色。 */
function buildBadge(badge, card, win, options) {
  const leaf = [badge, ...badge.querySelectorAll("*")].reverse().find(el => [...el.childNodes].some(n => n.nodeType === 3 && cleanText(n.textContent))) || badge;
  const ls = win.getComputedStyle(leaf);
  const settings = { title: cleanText(badge.textContent), header_size: "span" };
  if (options.colorMode !== "site") settings.title_color = color(ls.color);
  typography(settings, "typography", ls, options);
  // 角标本身是链接（悬停才出现的「Quick view」这类）：它是个按钮，不是标签 —— 用按钮小组件，链接跟着走。
  // 原来一律当标题（span）处理，链接直接丢。
  const badgeLink = badge.tagName === "A" ? badge : badge.querySelector("a[href]");
  if (badgeLink && badgeLink.getAttribute("href")) {
    const btn = buildButton(badgeLink, win.getComputedStyle(badgeLink), options);
    setAbsoluteOffsets(btn.settings, badge.getBoundingClientRect(), card.getBoundingClientRect());
    return btn;
  }
  const w = widgetWithGlobals("heading", settings, options);
  applyCardFrameToWidget(w, badge, win.getComputedStyle(badge), options);   // 底色、圆角、内边距
  setAbsoluteOffsets(w.settings, badge.getBoundingClientRect(), card.getBoundingClientRect());
  return w;
}

function looksLikeImageBox(node) {
  if (!CARD_ROOT_TAGS.has(node.tagName)) return false;
  if (node.querySelectorAll("img").length !== 1) return false;
  const headings = node.querySelectorAll("h1,h2,h3,h4,h5,h6");
  const paras = node.querySelectorAll("p");
  if (headings.length !== 1 || paras.length > 1) return false;
  // 不能含其它内容元素（按钮/图标/列表/表格/表单/视频等），否则不是纯图片卡。
  if (node.querySelector("button, svg, i[class], [class*='fa-'], [class*='eicon'], ul, ol, table, form, input, select, textarea, video, iframe")) return false;
  // 非破坏性护栏：卡片文字必须≈标题+描述，出现多余文字（如步骤序号「1」「2」）就不当图片框，避免丢内容。
  // ⚠ 这里必须**剔除全部空白**再比，不能用 cleanText 后拼一个空格去比。
  //   `</h3><p>` 之间没有空白时，textContent 里就没有那个空格，
  //   于是护栏对一张完全正常的卡片判 false —— 图片框识别静默失效，
  //   卡片退化成一堆散装小组件甚至文本块。护栏的用意是「有没有多余文字」，
  //   跟标签之间有没有换行无关。
  const squash = value => String(value || "").replace(/\s+/g, "");
  const headingText = squash(headings[0].textContent);
  const paraText = paras.length ? squash(paras[0].textContent) : "";
  if (squash(node.textContent) !== headingText + paraText) return false;
  return true;
}

// 从图片卡结构与已有值配好一个 Elementor 图片框（image-box）：图片/标题/描述/标签，图片位置按渲染布局判定。
function buildImageBox(node, style, win, options, parts = null) {
  // parts 由 imageCardParts 给出：标题/描述可能是任意标签（视觉识别），不再写死 h/p
  const img = parts?.img || node.querySelector("img");
  const heading = parts ? parts.titleEl : node.querySelector("h1,h2,h3,h4,h5,h6");
  const para = parts ? parts.descEl : node.querySelector("p");
  const gcs = n => (n && win && win.getComputedStyle ? win.getComputedStyle(n) : null);
  const hStyle = gcs(heading);
  const pStyle = gcs(para);
  const imageUrl = options.imageMode === "placeholder" ? "" : mediaSource(img, options);
  // 外框容器（container 包裹）已承载卡片的 margin/padding/背景，图片框自身不再重复取 commonSettings，避免双重内外边距。
  const settings = {};
  settings.image = { url: imageUrl, id: "" };
  settings.thumbnail_size = "full"; // 图片尺寸组控件名为 thumbnail → 键是 thumbnail_size（已对 image-box.php:131 核对）
  // 显示宽度：图占卡片的百分比。⚠ 键名是 image_size（不是 image_width！已对 image-box.php:364 核对），
  // 且 Elementor 默认只有 30% —— 转换的卡片图几乎都是满铺，必须显式给，否则用户每张都要手动改宽度（低效根因）。
  let imgSizePct = 100;
  if (img && node.getBoundingClientRect && img.getBoundingClientRect) {
    // ⚠ 分母用卡片的「内容宽」：卡片的内边距会转到小组件上，Elementor 里图片百分比是相对内容区算的。
    //   原来用含内边距的外框宽：360px 卡片里 60px 的图标算成 16.67%，导入后只剩 53px。
    //   卡片自身 padding 常为 0、留白靠子元素 margin（腾讯工具页），所以按内容包围盒到四边的距离算，
    //   和 buildCardWidget 写进 _padding 的是同一组数，两边口径一致。
    const ins = contentInsets(node, [img, heading, para]);
    const cardW = node.getBoundingClientRect().width - (ins ? ins.left + ins.right : 0);
    const imgW = img.getBoundingClientRect().width;
    if (cardW > 0 && imgW > 0 && imgW < cardW * 0.97) imgSizePct = Math.round(imgW / cardW * 10000) / 100;
  }
  settings.image_size = { unit: "%", size: imgSizePct, sizes: [] };
  // 源图用 object-fit 填充固定高度（如满铺裁切的场景卡）时，把高度 + object-fit 带到图片框；
  // 这样即使占位模式，用户在 Elementor 里放进真实图后也按原设计裁切铺满，不会缩成小图。
  if (img) {
    const imgStyle = gcs(img);
    const fit = imgStyle && imgStyle.objectFit;
    if (fit && fit !== "fill" && fit !== "none") {
      let hPx = parseFloat(imgStyle.height) || 0;
      if ((!hPx || hPx < 8) && img.getBoundingClientRect) hPx = img.getBoundingClientRect().height || 0;
      if (hPx >= 8) {
        settings.image_height = { unit: "px", size: Math.round(hPx), sizes: [] };
        settings.image_object_fit = fit; // cover/contain/scale-down（需配合 image_height 才生效，已对 image-box.php:405 核对）
      }
    }
  }
  // 图片圆角：扁平结构下小组件没有 overflow 裁切控件，满铺图靠图片自身圆角(image_border_radius)呈现卡片圆角。
  // ⚠ 圆角先取图片自己的；只有图片满铺卡片（占宽 ≥97%）时才借卡片圆角。
  //   原来一律用卡片圆角 —— 卡片 10px 圆角被套到 60px 的小图标上，原图标根本没有圆角。
  const imgOwnRadius = img ? parseFloat(gcs(img)?.borderTopLeftRadius) || 0 : 0;
  const cardRadius = parseFloat(style.borderTopLeftRadius) || 0;
  const radius = imgOwnRadius > 0 ? imgOwnRadius : (imgSizePct >= 97 ? cardRadius : 0);
  if (radius > 0) settings.image_border_radius = { unit: "px", size: Math.round(radius), sizes: [] }; // 单值滑块（已对 image-box.php:461 核对）
  settings.title_text = heading ? cleanText(heading.textContent) : "";
  settings.description_text = para ? cleanText(para.textContent) : "";
  // 标题标签按原样：h1–h6 / div / span / p 都是 image-box 的合法取值（image-box.php title_size 选项）
  const tagName = heading ? heading.tagName.toLowerCase() : "h3";
  settings.title_size = /^(h[1-6]|div|span|p)$/.test(tagName) ? tagName : "div";
  settings.text_align = resolveAlign(node, style) || "center";
  // 图片位置：横排卡（图在文字左/右）判为 left/right，否则 top。
  let position = "top";
  if (img && heading && img.getBoundingClientRect && heading.getBoundingClientRect) {
    const ir = img.getBoundingClientRect();
    const hr = heading.getBoundingClientRect();
    if (ir.right <= hr.left + 4) position = "left";
    else if (ir.left >= hr.right - 4) position = "right";
    // 图文间距：原来没带，横排卡的图标会贴着标题
    const textRect = (para ? [heading, para] : [heading]).map(n => n.getBoundingClientRect())
      .reduce((a, b) => ({ left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top) }));
    const gap = position === "left" ? textRect.left - ir.right : position === "right" ? ir.left - textRect.right : textRect.top - ir.bottom;
    if (gap > 0 && gap < 200) settings.image_space = { unit: "px", size: Math.round(gap), sizes: [] };
    // 横排卡的垂直对齐：图标和文字块中线对齐就是 middle
    if (position !== "top") {
      const textMid = (heading.getBoundingClientRect().top + (para || heading).getBoundingClientRect().bottom) / 2;
      const imgMid = (ir.top + ir.bottom) / 2;
      settings.content_vertical_alignment = Math.abs(textMid - imgMid) <= 6 ? "middle" : (imgMid < textMid ? "top" : "bottom");
    }
  }
  settings.position = position;
  if (hStyle) typography(settings, "title_typography", hStyle, options);
  if (pStyle) typography(settings, "description_typography", pStyle, options);
  if (options.colorMode !== "site") {
    if (hStyle) settings.title_color = color(hStyle.color);
    if (pStyle) settings.description_color = color(pStyle.color);
  }
  // 卡片被链接包裹时保留链接。
  const anchor = node.closest ? node.closest("a") : null;
  if (anchor && anchor.getAttribute("href")) settings.link = linkValue(anchor);
  // 参与图片框的子节点标记为已转换。
  options.convertedNodes.add(node);
  [img, heading, para].forEach(n => n && options.convertedNodes.add(n));
  return widgetWithGlobals("image-box", settings, options);
}

// 收集一行里的「图标标记」，并折叠嵌套（span.icon > svg 只算 1 个）。
function iconNodesIn(el) {
  // ⚠ 字符图标（<span>✓</span>）也要算：isIconNode 早就把「≤3 个非字母数字字符的 span」当图标，
  //   这里却只按选择器找 svg / i / 含 icon 的类名 —— 两处口径不一，Tailwind 写的勾选清单
  //   （类名只有 text-green-600）永远认不成图标列表。
  const glyphs = [...el.querySelectorAll("span, i")].filter(n => !n.children.length && (() => {
    const t = cleanText(n.textContent);
    return isGlyphIcon(t);
  })());
  const all = [...new Set([...el.querySelectorAll("svg, i[class], [class*='icon'], [class*='fa-'], [class*='eicon']"), ...glyphs])];
  return all.filter(n => !all.some(other => other !== n && other.contains(n)));
}

// 图标列表识别：容器的直接子元素是 ≥2 个「1 图标 + 文本」重复行，且不含标题/图片/按钮/嵌套列表 → Elementor 图标列表。
function looksLikeIconList(node) {
  if (!CONTAINER_TAGS.has(node.tagName) && node.tagName !== "UL" && node.tagName !== "OL") return false;
  const rows = [...node.children];
  if (rows.length < 2) return false;
  for (const row of rows) {
    if (row.nodeType !== Node.ELEMENT_NODE) return false;
    // 行内出现更"重"的内容元素就不是纯图标列表。
    if (row.querySelector("h1,h2,h3,h4,h5,h6,img,button,ul,ol,table,form,input,select,textarea,video,iframe")) return false;
    const icons = iconNodesIn(row);
    if (icons.length !== 1) return false;         // 每行恰好 1 个图标
    if (!cleanText(row.textContent)) return false; // 每行必须有文本
  }
  return true;
}

// 图标列表某一行的文本：去掉图标后，优先把首个 strong/b 作为加粗前缀，其余为描述（图标列表 text 支持行内 HTML）。
function iconListItemText(row) {
  const clone = row.cloneNode(true);
  iconNodesIn(clone).forEach(n => n.remove());
  const strongEl = clone.querySelector("strong, b");
  if (strongEl) {
    const title = cleanText(strongEl.textContent);
    strongEl.remove();
    const rest = cleanText(clone.textContent);
    if (title && rest) return `<strong>${escapeHtml(title)}</strong> ${escapeHtml(rest)}`;
    if (title) return escapeHtml(title);
  }
  return escapeHtml(cleanText(clone.textContent));
}

function iconSignature(iconNode) {
  if (!iconNode) return "";
  const def = iconDefinition(iconNode);
  if (def) return def[0];
  const path = iconNode.querySelector ? iconNode.querySelector("path") : null;
  if (path) return "path:" + (path.getAttribute("d") || "");
  return "svg:" + cleanText(iconNode.textContent || "") + iconNode.tagName;
}

// 从「图标 + 文本」重复行构建 Elementor 图标列表（icon-list）：每行一个可编辑条目，图标按名匹配 FA、间距/尺寸/颜色/排版对应到组件控件。
function buildIconList(node, style, win, options) {
  const rows = [...node.children];
  const gcs = n => (n && win && win.getComputedStyle ? win.getComputedStyle(n) : null);
  const icons = rows.map(row => iconNodesIn(row)[0] || null);
  // 各行图标是否一致：一致（如清单勾号）→ 全部用同一个图标；不一致 → 逐行按文字线索匹配。
  const uniform = icons.every(ic => iconSignature(ic) === iconSignature(icons[0]));
  const fallbackCheck = { value: "fas fa-check", library: "fa-solid" };
  let sharedIcon = null;
  if (uniform) {
    sharedIcon = matchIconName(icons[0], "");
    if (!sharedIcon.value) sharedIcon = fallbackCheck;
  }
  const items = rows.map((row, i) => {
    let selected = uniform ? sharedIcon : matchIconName(icons[i], cleanText(row.textContent));
    if (!selected.value) selected = fallbackCheck;
    // 行里有链接（mailto: / tel: / 普通链接）就带到条目的 link 上。原来只取文字，链接全丢。
    const rowLink = row.tagName === "A" ? row : row.querySelector("a[href]");
    const item = { _id: id().slice(0, 7), text: iconListItemText(row), selected_icon: { value: selected.value, library: selected.library } };
    if (rowLink && rowLink.getAttribute("href")) item.link = linkValue(rowLink);
    return item;
  });
  const settings = commonSettings(node, style);
  settings.view = "traditional";
  settings.icon_list = items;
  // 行间距：容器的 row-gap / gap。
  const rowGap = parseFloat(style.rowGap) || parseFloat(style.gap) || 0;
  if (rowGap) settings.space_between = { unit: "px", size: Math.round(rowGap), sizes: [] };
  // 图标尺寸 + 颜色：取首行图标的实际渲染尺寸；svg 取描边/填充色，i 取文字色。
  const firstIcon = icons.find(Boolean);
  if (firstIcon) {
    const iStyle = gcs(firstIcon);
    // 符号 / 字体图标取字号（✓ 这类符号的 span 宽度只有字宽的一部分），SVG 取渲染宽度
    let iconPx = iconGlyphSize(firstIcon, win) || parseFloat(iStyle && iStyle.width) || parseFloat(iStyle && iStyle.height) || 0;
    if ((!iconPx || iconPx < 4) && firstIcon.getBoundingClientRect) {
      const rect = firstIcon.getBoundingClientRect();
      iconPx = rect.width || rect.height || 0;
    }
    if (iconPx >= 4) settings.icon_size = { unit: "px", size: Math.round(iconPx), sizes: [] };
    if (options.colorMode !== "site" && iStyle) {
      let iconColor = "";
      if (String(firstIcon.tagName || "").toUpperCase() === "SVG") {
        const fill = iStyle.fill && iStyle.fill !== "none" ? color(iStyle.fill) : "";
        const stroke = iStyle.stroke && iStyle.stroke !== "none" ? color(iStyle.stroke) : "";
        iconColor = fill || stroke || color(iStyle.color);
      } else {
        iconColor = color(iStyle.color);
      }
      if (iconColor) settings.icon_color = iconColor;
    }
  }
  // 文本颜色 + 排版：取一行里代表性文本元素（优先 strong，否则 span/p）。
  // ⚠ 要跳过图标本身：每行第一个 span 常常就是 <span class="tick">✓</span>，原来把勾号的绿色和字号当成了文字样式
  //   （真实渲染比对：定价卡清单文字变成 16px 绿色）
  const icon0 = icons[0];
  const textEl = [...rows[0].querySelectorAll("strong, b, span, p, a")]
    .find(el => !(icon0 && (el === icon0 || icon0.contains(el) || el.contains(icon0))) && cleanText(el.textContent)) || rows[0];
  const tStyle = gcs(textEl);
  if (tStyle) {
    if (options.colorMode !== "site") {
      const textColor = color(tStyle.color);
      if (textColor) settings.text_color = textColor;
    }
    typography(settings, "icon_typography", tStyle, options); // icon_typography 组控件实际作用于列表文字（已对 icon-list.php:638 核对）
  }
  // 图标到文字的间距 → text_indent（icon-list.php:521，作用为图标格的 padding-inline-end）。
  // ⚠ Elementor 给每个图标留 1.25em 宽的格子（16px 图标占 20px），源页面 ✓ 这类符号本身只有字宽的一半左右 ——
  //   直接抄 gap 会让文字右移一截（真实渲染比对：定价卡清单文字偏右 13px）。按「源文字左边 − 图标左边 − 1.25 × 图标尺寸」算。
  if (icon0 && settings.icon_size && textEl !== rows[0]) {
    const gapPx = textEl.getBoundingClientRect().left - icon0.getBoundingClientRect().left - 1.25 * settings.icon_size.size;
    settings.text_indent = { unit: "px", size: Math.max(0, Math.round(gapPx)), sizes: [] };
  }
  // 参与图标列表的所有子节点标记为已转换，避免被重复处理或当作裸 HTML 保留。
  options.convertedNodes.add(node);
  node.querySelectorAll("*").forEach(n => options.convertedNodes.add(n));
  return widgetWithGlobals("icon-list", settings, options);
}

// 分割线识别：无文本、无实体内容、渲染为细横条（有背景色或边框）的空 div/span → Elementor 分割线。
function looksLikeDivider(node, style) {
  const tag = String(node.tagName || "").toUpperCase();
  if (tag !== "DIV" && tag !== "SPAN") return false;
  if (cleanText(node.textContent)) return false;
  if (node.querySelector("img,svg,i,input,button,a,ul,ol,table,h1,h2,h3,h4,h5,h6,p")) return false;
  if (!node.getBoundingClientRect) return false;
  const rect = node.getBoundingClientRect();
  if (!rect.width || rect.width < 12) return false;
  if (rect.height > 8) return false;                 // 必须是细条
  if (rect.width < rect.height * 3) return false;    // 必须横向长条
  const hasBg = Boolean(color(style.backgroundColor)) || (style.backgroundImage && style.backgroundImage !== "none");
  const hasBorder = (parseFloat(style.borderTopWidth) || 0) > 0 || (parseFloat(style.borderBottomWidth) || 0) > 0;
  return Boolean(hasBg || hasBorder);
}

// 元素是否写死了高度：临时把 height 设成 auto，渲染高度变了就是写死的，返回原高度；否则 0。
// （computed height 永远是像素，分不出 auto 和 66px，只能这样试。）
function explicitHeight(node) {
  if (!node || !node.style || !node.getBoundingClientRect) return 0;
  const h = node.getBoundingClientRect().height;
  if (!h) return 0;
  // ⚠ 不能用「临时设成 auto 看高度变不变」：一排都是 height:66px 的格子，被改成 auto 的那个又被 grid 行拉伸回 66，
  //   看起来像没写死（真实渲染比对：logo 墙格子高度丢失）。改为查样式表里是否声明了具体高度。
  // 扩展抓取只内联 min-height、不内联 height，所以这里找到的 height 一定是作者写的。
  const declared = declaredHeight(node);
  // var() 声明可能解析成 auto：Bootstrap 的 .card{height:var(--bs-card-height)} 变量为空 = 没写高度。
  //   原来当成写死，把平板上两列等高的 450px 钉成最小高度，手机上每张卡多 70px（真实渲染比对抓出）。
  //   这种情况和 auto 比一次；纯数值声明不比（一排 66px 格子里改成 auto 会被同行拉伸回原高，误判成没写）。
  if (declared && /var\(/.test(declared) && behavesAsAutoHeight(node, declared)) return 0;
  // 百分比高度（Bootstrap 的 h-100）是「撑满父级」，不是写死的数值：钉成像素会把桌面等高卡片的 450px 带到手机上，
  //   每张卡多出 70px（真实渲染比对抓出）。它由 fillsParentHeight → flex 伸展表达。
  return declared && !/%$/.test(declared) ? h : 0;
}

function behavesAsAutoHeight(node, declared) {
  const win = node.ownerDocument.defaultView;
  const saved = node.style.getPropertyValue("height");
  const priority = node.style.getPropertyPriority("height");
  const measure = value => { node.style.setProperty("height", value, "important"); return win.getComputedStyle(node).height; };
  const same = measure(declared) === measure("auto");
  if (saved) node.style.setProperty("height", saved, priority);
  else node.style.removeProperty("height");
  return same;
}

function declaredHeight(node) {
  return declaredProperty(node, "height", c => /^(auto|fit-content|min-content|max-content|inherit|initial|unset)$/i.test(c));
}

// height:100% → 在 Elementor 父容器（纵向 flex）里伸展填满：flex 子项的 _flex_size:"grow"（Group_Control_Flex_Item，container.php:1500）
function fillsParentHeight(node) {
  const declared = node && node.style ? declaredHeight(node) : null;
  return !!declared && /^100(\.0+)?%$/.test(declared);
}

// 容器的 min_height：min-height 与写死的 height 取大（桌面和各断点必须同一个口径，否则断点上读到 min-height:0 会把桌面的固定高度清掉）
// ⚠ Elementor 容器一律 border-box：源页面没写 box-sizing（默认 content-box）时，min-height 不含上下内边距 / 边框，
//   要加回去。原来直接抄 360px，带 28px 内边距的面板实际 416px 高，导入后矮 56px，同一行里居中的文字栏跟着上移 28px。
function containerMinHeight(node, style) {
  // 视口单位（min-height:100vh 的全屏 hero）原样写 vh：换算成像素就钉死在转换时预览框的高度上，
  //   换一块屏幕就不对了（自审发现；这个问题在上一版之前就存在）。Elementor 的 min_height 支持 vh。
  const vhDecl = declaredProperty(node, "min-height", c => !/^[\d.]+(vh|svh|lvh|dvh)$/.test(c))
    || declaredProperty(node, "height", c => !/^[\d.]+(vh|svh|lvh|dvh)$/.test(c));
  if (vhDecl) return { unit: "vh", size: parseFloat(vhDecl), sizes: [] };
  const fixed = explicitHeight(node);
  let min = parseFloat(style.minHeight) || 0;
  if (min > 0 && style.boxSizing === "content-box") {
    min += (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
      + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
  }
  if (fixed > min) return { unit: "px", size: Math.round(fixed), sizes: [] };
  if (min > 0) return { unit: "px", size: Math.round(min), sizes: [] };
  // auto / 0 也返回 0：断点上返回 null 会被跳过，继承上一档的最小高度
  return unit(style.minHeight) || { unit: "px", size: 0, sizes: [] };
}

// boxed_width = 内容区宽度（见 container() 里的说明）：border-box 的 max-width 要扣掉左右内边距 / 边框
function boxedWidthFor(style) {
  const maxWidth = unit(style.maxWidth);
  if (!maxWidth || maxWidth.unit !== "px" || !Number.isFinite(maxWidth.size)) return null;
  if (style.boxSizing !== "border-box") return maxWidth;
  const insetX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
    + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
  return { ...maxWidth, size: Math.max(0, Math.round(maxWidth.size - insetX)) };
}

// ⚠ 容器的 width / boxed_width 在平板、手机上有自己的默认值（container.php：tablet_default / mobile_default），
//   不继承桌面值。桌面写了，每个断点就必须显式写 —— 否则 64px 的图标徽章到手机上变成 100% 宽的长条，
//   1120 的限宽区块到平板上退回默认宽度（真实渲染比对：Bootstrap features 页）。
function responsiveContainerWidths(settings, node, style, suffix) {
  const w = elementWidthSettings(node, node.parentElement).width;
  // 桌面写了宽度 → 每档显式写（满宽写 100%）；桌面满宽、到这一档变窄 → 也要写（自审补回：上一版只处理了前一种）
  if (settings.width || w) settings[`width_${suffix}`] = w || { unit: "%", size: 100, sizes: [] };
  if (settings.content_width === "boxed" && settings.boxed_width) {
    const b = boxedWidthFor(style);
    settings[`boxed_width_${suffix}`] = b || settings.boxed_width;
  }
}

function container(node, style, elements = [], options = {}) {
  const settings = commonSettings(node, style);
  if (settings._css_classes) {
    settings.css_classes = settings._css_classes;
    delete settings._css_classes;
  }
  if (settings._z_index) {
    settings.z_index = settings._z_index;
    delete settings._z_index;
  }
  if (settings._margin) {
    settings.margin = settings._margin;
    delete settings._margin;
  }
  if (settings._padding) {
    settings.padding = settings._padding;
    delete settings._padding;
  }
  const display = style.display;
  settings.content_width = "full";
  const fixedHeight = explicitHeight(node);
  if (fillsParentHeight(node)) settings._flex_size = "grow";
  const rowGap = parseFloat(style.rowGap) || 0;
  const columnGap = parseFloat(style.columnGap) || 0;
  if (display.includes("grid")) {
    settings.container_type = "grid";
    // 让编辑器导航器/面板把它显示为「网格」而不是「容器」：Elementor 用 settings.presetTitle 覆盖标题（已对 editor.js:39581 + container.php:104 核对）。
    settings.presetTitle = "Grid";
    settings.presetIcon = "eicon-container-grid";
    const columns = gridColumnsFor(node, style);
    if (columns) settings.grid_columns_grid = columns;
    // Let rows size to content instead of Elementor's default repeat(2, 1fr).
    settings.grid_rows_grid = { unit: "custom", size: "auto", sizes: [] };
    // ⚠ Elementor 的 grid 默认 --grid-align-content:start（行挤在顶部），CSS 默认 normal = 行拉伸填满。
    //   有最小高度的单行 grid（图片占位面板这类 place-items:center 的块）行不拉伸，内容就贴顶了（真实渲染比对抓出）。
    //   单行时写 1fr 与「拉伸」完全等价；多行拉伸没有等价写法，维持 auto。
    const rowTracks = String(style.gridTemplateRows || "").trim().split(/\s+/).filter(Boolean);
    if (rowTracks.length === 1 && /^(normal|stretch)$/.test(style.alignContent) && (parseFloat(style.minHeight) > 0 || fixedHeight)) {
      settings.grid_rows_grid = { unit: "custom", size: "1fr", sizes: [] };
    }
    const gridItems = { start: "start", "flex-start": "start", center: "center", end: "end", "flex-end": "end", stretch: "stretch" };
    const gridContent = { ...gridItems, "space-between": "space-between", "space-around": "space-around", "space-evenly": "space-evenly" };
    if (gridItems[style.justifyItems]) settings.grid_justify_items = gridItems[style.justifyItems];
    if (gridItems[style.alignItems]) settings.grid_align_items = gridItems[style.alignItems];
    if (gridContent[style.justifyContent] && style.justifyContent !== "normal") settings.grid_justify_content = gridContent[style.justifyContent];
    // ⚠ gap 为 0 也必须显式写：不写 = 套用站点默认的元素间距（新站 20px），真实 Elementor 渲染比对抓出每块多 20px
    settings.grid_gaps = { unit: "px", column: String(columnGap), row: String(rowGap), isLinked: rowGap === columnGap };
  } else {
    if (display.includes("flex")) {
      settings.flex_direction = style.flexDirection || "row";
      if (style.flexWrap !== "nowrap") settings.flex_wrap = "wrap";
    } else {
      settings.flex_direction = "column";
    }
    const justifyMap = { "flex-start": "flex-start", start: "flex-start", center: "center", "flex-end": "flex-end", end: "flex-end", "space-between": "space-between", "space-around": "space-around", "space-evenly": "space-evenly" };
    const alignMap = { "flex-start": "flex-start", start: "flex-start", center: "center", "flex-end": "flex-end", end: "flex-end", stretch: "stretch" };
    // 对齐同理只对 flex 生效（block 元素上写着 align-items:center 在源页面里不起作用）
    if (display.includes("flex") && justifyMap[style.justifyContent]) settings.flex_justify_content = justifyMap[style.justifyContent];
    if (display.includes("flex") && alignMap[style.alignItems]) settings.flex_align_items = alignMap[style.alignItems];
    // gap 只对 flex / grid 生效：block 元素上写着的 gap:28px 在源页面里没有效果，照抄会凭空多出间距
    const flexGap = display.includes("flex") ? { row: rowGap, column: columnGap } : { row: 0, column: 0 };
    settings.flex_gap = { unit: "px", size: flexGap.column || flexGap.row, column: String(flexGap.column), row: String(flexGap.row), isLinked: flexGap.row === flexGap.column };
  }
  // min-height 与写死的高度（height:66px 的 logo 格子）都落到 min_height：Elementor 容器没有 height 控件，
  //   内容放得下时两者等价。原来固定高度直接丢掉，格子缩成内容高度，里面居中的文字整体上移（真实渲染比对抓出）。
  const minHeight = containerMinHeight(node, style);
  if (minHeight) settings.min_height = minHeight;
  // ⚠ Elementor 的 boxed_width 是「内容区」宽度（内边距在外层 .e-con 上）。源页面 border-box 时 max-width 含左右内边距 /
  //   边框，要扣掉，否则内容区宽出一截（Tailwind 这类全局 border-box 的页面每个限宽区块都中招）；content-box 时就是内容宽。
  const insetX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
    + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
  const boxed = boxedWidthFor(style);
  if (boxed) {
    settings.content_width = "boxed";
    settings.boxed_width = boxed;
  }
  // margin:0 auto 居中块（左右边距已在 commonSettings 清零）→ 用 boxed 居中：有 max-width 用之，否则用渲染宽度兜底。
  if (isAutoCentered(node, style) && settings.content_width !== "boxed") {
    const rectW = node.getBoundingClientRect ? Math.round(node.getBoundingClientRect().width - insetX) : 0;   // 渲染宽是边框盒
    if (rectW > 0) {
      settings.content_width = "boxed";
      settings.boxed_width = { unit: "px", size: rectW, sizes: [] };
    }
  }
  // overflow:hidden（如卡片 overflow:hidden 把满铺图裁到圆角内）→ 容器 overflow 控件（已对 container.php:557 核对）。
  if (style.overflowX === "hidden" || style.overflowY === "hidden" || style.overflow === "hidden") {
    settings.overflow = "hidden";
  }
  backgroundAndBorder(settings, style, options);
  return { id: id(), elType: "container", settings, elements, isInner: false };
}

// 把「卡片外框」样式（背景/边框/圆角/阴影/内外边距/类名）转到小组件自身的高级设置（下划线前缀键），
// 让卡片就是一个小组件、直接进网格/弹性容器，不再每张多包一层容器——贴合人工搭法（一排图片框/图标框直接放进网格或方向容器）。
function applyCardFrameToWidget(widgetEl, node, style, options) {
  const s = widgetEl.settings;
  Object.assign(s, commonSettings(node, style)); // _element_id / _css_classes / _margin / _padding / _z_index
  const frame = {};
  backgroundAndBorder(frame, style, options);    // background_* / border_* / border_radius / box_shadow_*
  for (const key of Object.keys(frame)) s["_" + key] = frame[key]; // 加下划线前缀 = 小组件高级标签的背景/边框/圆角/阴影键
}

function elementWidthSettings(node, parent) {
  // Grid tracks already size their items; an explicit width would shrink the item inside its cell.
  const parentDisplay = parent?.ownerDocument?.defaultView?.getComputedStyle(parent).display || "";
  if (parentDisplay.includes("grid")) return {};
  // margin:0 auto 居中块靠 boxed 居中，不能再加固定 width%（否则和 boxed 打架、且 flex_grow:0 会把它顶到一边）。
  const selfView = node.ownerDocument && node.ownerDocument.defaultView;
  if (selfView && isAutoCentered(node, selfView.getComputedStyle(node))) return {};
  const rect = node.getBoundingClientRect();
  const parentRect = parent?.getBoundingClientRect();
  // ⚠ 用父容器的「内容宽」(减掉左右 padding) 做分母：否则填满内容区的子元素会被算成 <100%（如父有 72px padding → 得 89.89%）→ 误加 width% 顶到一边。
  const pView = parent?.ownerDocument?.defaultView;
  const pStyle = pView ? pView.getComputedStyle(parent) : null;
  const padL = pStyle ? parseFloat(pStyle.paddingLeft) || 0 : 0;
  const padR = pStyle ? parseFloat(pStyle.paddingRight) || 0 : 0;
  const parentContentW = (parentRect?.width || 0) - padL - padR;
  if (!rect.width || parentContentW <= 0 || rect.width >= parentContentW * 0.97) return {};
  // 声明的是固定长度（width:4rem 的图标徽章、240px 的侧栏）→ 写像素；百分比会让它在两个采样宽度之间被拉成长方形
  const declaredW = declaredProperty(node, "width", c => !/^[\d.]+(px|rem|em)$/.test(c));
  if (declaredW) return { width: { unit: "px", size: Math.round(rect.width), sizes: [] }, _flex_size: "none" };
  // 横向 flex 行里「没声明宽度、右边缘顶到父级内容区末端」的那一栏 = 占满剩余空间（图标在左、文字栏在右）。
  //   钉成百分比 + 禁止伸缩的话，48px 图标 + 间距 + 84% 稍有舍入就超出一行，文字栏被挤到下一行
  //   （真实渲染比对：Bootstrap「Hanging icons」手机端）。改为可伸可缩（flex-item.php：size=custom 时 grow/shrink 才生效）。
  //   ⚠ 只限不换行的行、且这一栏没声明任何宽度：Bootstrap 栅格（flex-wrap:wrap）每行最后一列 width:33% 也顶到行末，
  //   误判成「填满剩余」会丢掉 33%，三列挤成两行（真实渲染比对：album 桌面高度 ×1.55）。
  const rowFlex = pStyle && pStyle.display.includes("flex") && !pStyle.flexDirection.startsWith("column") && pStyle.flexWrap === "nowrap";
  //   靠 margin-left:auto 推到右边的（导航栏 ms-auto）也不算：它顶到行末是被推过去的，不是在填空间
  //   （几何条件先判，声明值查询放后面：大多数元素在第一步就排除了，不必去扫样式表）
  if (rowFlex) {
    const contentRight = (parentRect?.right || 0) - padR - (parseFloat(pStyle.borderRightWidth) || 0);
    const reachesEnd = Math.abs(rect.right + (parseFloat(selfView.getComputedStyle(node).marginRight) || 0) - contentRight) <= 2;
    if (reachesEnd
      && declaredProperty(node, "margin-left", c => c !== "auto") !== "auto"
      && declaredProperty(node, "margin-inline-start", c => c !== "auto") !== "auto"
      && !declaredProperty(node, "flex-basis", c => /^auto$/.test(c))
      && !declaredProperty(node, "width", c => /^auto$/.test(c))) {
      return { _flex_size: "custom", _flex_grow: 1, _flex_shrink: 1 };
    }
  }
  const size = Math.max(1, Math.min(100, Number((rect.width / parentContentW * 100).toFixed(2))));
  // ⚠ 伸缩项控件归 Group_Control_Flex_Item，注册名 '_flex'
  //   （container.php:1500、common-base.php:478 各注册一次），所以裸的
  //   flex_grow / flex_shrink **不是有效控件名**，Elementor 会静默丢弃 ——
  //   定宽元素在 flex 容器里照样被默认的 flex-shrink:1 压缩，width% 守不住。
  //
  //   正确写法不是 `_flex_grow` + `_flex_shrink`：这两个字段都带
  //   `'condition' => ['size' => 'custom']`（flex-item.php:167、181），
  //   不把 `_flex_size` 设成 'custom' 就不参与 CSS 生成。
  //   而 size='none' 的 selectors_dictionary 正是 `--flex-grow: 0; --flex-shrink: 0;`
  //   （flex-item.php:150）—— 一个无条件控件就等价，且是官方面板里的同一个选择。
  return { width: { unit: "%", size, sizes: [] }, _flex_size: "none" };
}

// 小组件的宽度。⚠ 控件是 _element_width + _element_custom_width（common-base.php:335 / :357），
//   不是容器的 width —— 原来给小组件也写 width，Elementor 静默丢弃，于是限宽的引言段落、窄标题导入后全部铺满
//   （真实 Elementor 渲染比对抓出：660px 的居中引言变成整行）。
// 只处理「父级是纵向排布」的情况：grid 单元格自己定宽，横向 flex 里的小组件本来就按内容宽排。
// 用像素：限宽文字的每行长度取决于绝对宽度；窄屏由响应式采样改回满宽（见 applyResponsiveSettings）。
// accordion：FAQ 常是 max-width + margin:auto 的居中窄栏，不写宽度就铺满整行（2026-10-15 Northwind 测试页）
const WIDTH_AWARE_WIDGETS = new Set(["heading", "text-editor", "icon-list", "accordion"]);
function widgetWidthSettings(node, parent, widgetType) {
  const view = node.ownerDocument && node.ownerDocument.defaultView;
  if (!view || !parent) return {};
  const pStyle = view.getComputedStyle(parent);
  if (pStyle.display.includes("grid")) return {};
  const rect = node.getBoundingClientRect();
  const parentContentW = parent.getBoundingClientRect().width - (parseFloat(pStyle.paddingLeft) || 0) - (parseFloat(pStyle.paddingRight) || 0)
    - (parseFloat(pStyle.borderLeftWidth) || 0) - (parseFloat(pStyle.borderRightWidth) || 0);
  if (pStyle.display.includes("flex") && !pStyle.flexDirection.startsWith("column")) {
    // 横向 flex 行里的小组件：只有「声明过宽度」的才写（Bootstrap 栅格 .row-cols-lg-4>*{width:25%}、flex:0 0 33%）。
    //   ⚠ 原来一律不写：features 页每个 .col 直接识别成图标框，丢了 25% → 4 列变 2 列（真实渲染比对抓出）。
    //   没声明的（按内容自适应的导航链接、按钮）不动，否则会被钉死宽度。百分比按渲染宽度占父内容宽算。
    const declared = declaredProperty(node, "width", c => !/(%|px|em|rem|vw)$/.test(c))
      || declaredProperty(node, "flex-basis", c => !/(%|px|em|rem)$/.test(c));
    if (!declared || !rect.width || parentContentW <= 0) return {};
    const custom = /%$/.test(declared)
      ? { unit: "%", size: Math.min(100, Math.round(rect.width / parentContentW * 10000) / 100), sizes: [] }
      : { unit: "px", size: Math.ceil(rect.width), sizes: [] };
    return { _element_width: "initial", _element_custom_width: custom };
  }
  if (!WIDTH_AWARE_WIDGETS.has(widgetType)) return {};
  if (!rect.width || parentContentW <= 0 || rect.width >= parentContentW * 0.97) return {};
  // 对齐看实际位置（margin:auto 在 computed 里已解析成像素）：左右留白相等 = 居中，只有左侧留白 = 靠右
  const leftGap = rect.left - (parent.getBoundingClientRect().left + (parseFloat(pStyle.paddingLeft) || 0) + (parseFloat(pStyle.borderLeftWidth) || 0));
  const rightGap = parentContentW - leftGap - rect.width;
  const align = Math.abs(leftGap - rightGap) <= 2 && leftGap > 2 ? "center" : (leftGap > 2 && rightGap <= 2 ? "flex-end" : "flex-start");
  return {
    _element_width: "initial",
    _element_custom_width: { unit: "px", size: Math.ceil(rect.width), sizes: [] },
    _flex_align_self: align
  };
}

// Shared widget builders — used by both the forced-mapping path (convertForcedNode)
// and the tag-based path (convertNode) so a fix lands in exactly one place.
function buildHeading(node, style, options) {
  const settings = commonSettings(node, style);
  const isHeadingTag = /^H[1-6]$/.test(node.tagName);
  settings.title = isHeadingTag ? node.innerHTML.trim() : escapeHtml(cleanText(node.textContent) || "Heading");
  settings.header_size = resolveHeadingTag(isHeadingTag ? node.tagName : "H2", options);
  widgetFrame(settings, style, options);
  if (options.colorMode !== "site") settings.title_color = color(style.color);
  settings.align = resolveAlign(node, style);
  typography(settings, "typography", style, options);
  return widgetWithGlobals("heading", settings, options);
}

// 文本编辑器内容根元素的外边距 / 内边距归零（内联）。它们已经由 commonSettings 搬到小组件自己的 _margin / _padding，
// 根元素上再留着就会被主题的全局重置补上一份：Hello 主题给每个 <p> 加 margin-block-end:.9rem、表格 15px ——
// 真实 Elementor 渲染比对里每个段落都多出 14.4px，逐段累积，整页越往下偏得越多。
// 写内联而不写进本块 CSS：不依赖「保留样式」选项，扩展 / CLI 的产物同样生效。
function positionalRulesHitChildren(doc, parent) {
  if (!doc || !parent) return false;
  const kids = new Set(parent.children);
  const visit = rules => [...(rules || [])].some(rule => {
    if (rule.cssRules && rule.conditionText !== undefined) return visit(rule.cssRules);
    if (!rule.selectorText || !/:(first-child|nth-child|only-child|nth-last-child|first-of-type|nth-of-type|only-of-type)/.test(rule.selectorText)) return false;
    try { return [...doc.querySelectorAll(rule.selectorText)].some(el => kids.has(el)); } catch { return false; }
  });
  return [...doc.styleSheets].some(sheet => { try { return visit(sheet.cssRules); } catch { return false; } });
}

function treeHasCssClass(elements, cls) {
  return (elements || []).some(e => String(e.settings?._css_classes || "").split(/\s+/).includes(cls) || treeHasCssClass(e.elements, cls));
}

function treeHasWidget(elements, types) {
  return (elements || []).some(e => types.includes(e.widgetType) || treeHasWidget(e.elements, types));
}

function zeroRootBox(html) {
  const ZERO = "margin:0;padding:0";
  const tableWrap = /^(<div style="overflow-x:auto">)<table\b/i;
  if (tableWrap.test(html)) return html.replace(tableWrap, `$1<table style="${ZERO}"`);
  const m = html.match(/^<([a-z][a-z0-9-]*)\b([^>]*)>/i);
  if (!m) return html;
  const attrs = m[2];
  const styled = /\sstyle\s*=\s*"([^"]*)"/i.test(attrs)
    ? attrs.replace(/\sstyle\s*=\s*"([^"]*)"/i, (all, css) => ` style="${ZERO};${css}"`)
    : `${attrs} style="${ZERO}"`;
  return `<${m[1]}${styled}>` + html.slice(m[0].length);
}

// 小组件自身的外框（背景 / 边框 / 圆角 / 阴影）→ 高级标签里的 _background / _border / _border_radius / _box_shadow
// （common-base.php:906 / :981 / :989 / :1001）。键名 = 容器键名前加下划线。
// ⚠ 原来只有容器写外框：角标、胶囊标签、带底色的提示条这类「文字自己带底色」的元素导入后底色、圆角全丢
//   （真实 Elementor 渲染比对：hero 顶部的「NO ACCOUNT NEEDED」胶囊消失）。
function widgetFrame(settings, style, options) {
  const frame = {};
  backgroundAndBorder(frame, style, options, "_box_shadow");
  for (const [key, value] of Object.entries(frame)) settings[key.startsWith("_box_shadow") ? key : "_" + key] = value;
}

function buildTextEditor(node, style, options, editorHtml) {
  const settings = commonSettings(node, style);
  settings.editor = zeroRootBox(editorHtml);
  widgetFrame(settings, style, options);
  if (options.colorMode !== "site") settings.text_color = color(style.color);
  const align = resolveAlign(node, style);
  if (align && align !== "left") settings.align = align; // 居中/靠右副标题等：显式设对齐，避免被容器默认左对齐；左对齐是默认值不用写
  typography(settings, "typography", style, options);
  return widgetWithGlobals("text-editor", settings, options);
}

// grid 子项所在网格区域的宽度：按父级解析后的列轨道（computed 的 grid-template-columns 是像素列表）找出
//   子项左边缘落在哪一列、右边缘延伸到哪一列，加上中间的列间距。父级不是 grid 或解析不了返回 0。
function gridAreaWidth(node, parent) {
  const view = node.ownerDocument && node.ownerDocument.defaultView;
  if (!view || !parent) return 0;
  const ps = view.getComputedStyle(parent);
  if (!ps.display.includes("grid")) return 0;
  const tracks = ps.gridTemplateColumns.split(/\s+/).map(parseFloat).filter(n => Number.isFinite(n) && n > 0);
  if (!tracks.length) return 0;
  const gap = parseFloat(ps.columnGap) || 0;
  const pr = parent.getBoundingClientRect();
  const r = node.getBoundingClientRect();
  let x = pr.left + (parseFloat(ps.borderLeftWidth) || 0) + (parseFloat(ps.paddingLeft) || 0);
  let start = -1;
  let width = 0;
  for (let i = 0; i < tracks.length; i++) {
    const end = x + tracks[i];
    if (start < 0 && r.left < end - 0.5) start = i;
    if (start >= 0) {
      width += tracks[i] + (i > start ? gap : 0);
      if (r.right <= end + 0.5) return width;
    }
    x = end + gap;
  }
  return start >= 0 ? width : 0;
}

function buildImage(node, style, options, { linkAndBorder = false } = {}) {
  const imageNode = node.tagName === "IMG" ? node : node.querySelector("img");
  const settings = commonSettings(node, style);
  const imageUrl = options.imageMode === "placeholder" ? "" : mediaSource(imageNode, options);
  settings.image = { url: imageUrl, id: "" };
  // 图槽为空时（占位模式，或 Base64/相对地址被安全丢弃），把原图 alt 写成图片说明，
  // 让每个空槽都带标签（"Dashboard"、"Microfiber close-up"…），在 Elementor 里一眼知道该填哪张；
  // 填完真实图后如不需要可一键删掉说明。
  if (!imageUrl) {
    const alt = imageNode && imageNode.getAttribute("alt") ? imageNode.getAttribute("alt").trim() : "";
    if (alt) {
      settings.caption_source = "custom";
      settings.caption = alt; // Image 组件自定义说明键是 caption（非 custom_caption），已对官方源码 image.php:173 核对
    }
  }
  settings.image_size = "full";
  if (linkAndBorder) {
    settings.link_to = node.closest("a") ? "custom" : "none";
    if (node.closest("a")) settings.link = linkValue(node);
  }
  // 宽度：computed 会把 %/100% 宽解析成视口相关的定值像素，直接取会烙死。改用「占父容器百分比」表达（视口无关）：
  // 满宽（≥97%）不写 width 交给默认自适应；窄图写百分比；拿不到父容器尺寸才回退像素。
  const iRect = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
  const ipRect = node.parentElement && node.parentElement.getBoundingClientRect ? node.parentElement.getBoundingClientRect() : null;
  // ⚠ 父级是 grid 时，Elementor 里图片小组件坐在单元格里，宽度百分比的分母是单元格，不是整个网格。
  //   原来按整个网格算：两栏 hero 右侧满格的大图成了 44%，导入后只剩三分之一大（2026-10-15 Northwind 测试页）。
  const areaW = node.parentElement ? gridAreaWidth(node, node.parentElement) : 0;
  if (iRect && ipRect && ipRect.width > 0) {
    const pct = iRect.width / (areaW || ipRect.width) * 100;
    if (pct < 97) settings.width = { unit: "%", size: Math.round(pct * 100) / 100, sizes: [] };
  } else {
    const width = unit(style.width);
    if (width) settings.width = width;
  }
  // 对齐：computed 已把 margin:auto 解析成像素（原 === "auto" 永不成立），改用 resolveAlign 按渲染盒判居中（含单列护栏）。
  settings.align = resolveAlign(node, style);
  if (linkAndBorder) {
    // ⚠ backgroundAndBorder 写的是容器的键名（border_radius / border_* / box_shadow_* / background_*），
    //   图片小组件里对应的是 image_border_radius、image_border 组、image_box_shadow 组（image.php），
    //   而且图片小组件自身没有背景控件。原来直接写进 settings：圆角、边框、阴影全部被静默忽略 ——
    //   Tailwind 页面上 rounded-xl 的图片导入后变直角。选型基准加了键名对账才抓出来。
    const frame = {};
    backgroundAndBorder(frame, style, options, "image_box_shadow");
    for (const [key, value] of Object.entries(frame)) {
      if (key === "border_radius") settings.image_border_radius = value;
      else if (/^border_(border|width|color)$/.test(key)) settings["image_" + key] = value;
      else if (key.startsWith("image_box_shadow")) settings[key] = value;
      else if (key.startsWith("background_")) settings["_" + key] = value;   // 背景只能放高级标签
    }
  }
  return widget("image", settings);
}

// 按钮对齐。text-align 只说明按钮在行内怎么放；display:block / width:100% 的按钮撑满父级内容宽，
// Elementor 里要用 align:"justify"（按钮拉满）表达 —— 原来一律按 text-align，定价卡里的满宽按钮变成居中小按钮（真实渲染比对抓出）。
function buttonAlign(node, style) {
  const parent = node.parentElement;
  const view = node.ownerDocument && node.ownerDocument.defaultView;
  if (parent && view) {
    const ps = view.getComputedStyle(parent);
    const rowFlex = ps.display.includes("flex") && !ps.flexDirection.startsWith("column");
    // ⚠ 按钮自己得是「会撑满」的：块级（display:block / flex / grid）或声明了 100% 宽。
    //   行内块按钮恰好等于父级宽，往往是父级按内容收缩（inline-block 包裹层），那层被折叠后在 Elementor 里
    //   就成了横跨整行的大按钮（自审发现）。
    const blockLevel = /^(block|flex|grid|table|list-item|flow-root)$/.test(style.display)
      || /^100(\.0+)?%$/.test(declaredProperty(node, "width") || "");
    if (blockLevel && !rowFlex && !ps.display.includes("grid")) {
      const contentW = parent.getBoundingClientRect().width - (parseFloat(ps.paddingLeft) || 0) - (parseFloat(ps.paddingRight) || 0)
        - (parseFloat(ps.borderLeftWidth) || 0) - (parseFloat(ps.borderRightWidth) || 0);
      if (contentW > 0 && node.getBoundingClientRect().width >= contentW - 1) return "justify";
    }
  }
  return normalizeAlign(style.textAlign, style.direction);
}

function buildButton(node, style, options) {
  const settings = commonSettings(node, style);
  settings.text = cleanText(node.textContent) || "Button";
  settings.link = node.tagName === "A" ? linkValue(node) : { url: "", is_external: "", nofollow: "", custom_attributes: "" };
  if (options.colorMode !== "site") {
    settings.button_text_color = color(style.color);
    // 透明背景（线框按钮）要显式写 transparent：留空 = Elementor 套全局强调色，新站是绿色（真实渲染比对：Bootstrap 线框按钮变绿）
    settings.background_color = color(style.backgroundColor) || "transparent";
    if (settings.background_color === "transparent") settings.background_background = "classic";
  }
  settings.text_padding = settings._padding;
  delete settings._padding;
  settings.align = buttonAlign(node, style);
  typography(settings, "typography", style, options);
  backgroundAndBorder(settings, style, options, "button_box_shadow");
  return widgetWithGlobals("button", settings, options);
}

function buildDivider(node, style, options) {
  const settings = commonSettings(node, style);
  const borderW = parseFloat(style.borderTopWidth) || parseFloat(style.borderBottomWidth) || 0;
  let weightPx, colorVal;
  if (borderW > 0) {
    weightPx = borderW;
    colorVal = style.borderTopColor && style.borderTopColor !== "rgba(0, 0, 0, 0)" ? style.borderTopColor : style.borderBottomColor;
  } else {
    // 用背景色 + 高度表现的横条（空 div/span 分割线）。
    const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : { height: 0 };
    weightPx = Math.max(1, Math.round(rect.height || parseFloat(style.height) || 1));
    colorVal = style.backgroundColor;
  }
  if (options.colorMode !== "site") settings.color = color(colorVal) || colorVal;
  settings.weight = { unit: "px", size: weightPx || 1, sizes: [] };
  // 短横线（明显窄于父容器）→ 设定宽度 + 对齐，避免被拉成整行。
  if (node.getBoundingClientRect && node.parentElement && node.parentElement.getBoundingClientRect) {
    const rect = node.getBoundingClientRect();
    const prect = node.parentElement.getBoundingClientRect();
    if (rect.width && prect.width && rect.width < prect.width * 0.9) {
      settings.width = { unit: "px", size: Math.round(rect.width), sizes: [] };
      settings.align = normalizeAlign(style.textAlign, style.direction) || "left";
    }
  }
  return widgetWithGlobals("divider", settings, options);
}

function buildVideo(node) {
  const src = node.getAttribute("src") || node.querySelector("source")?.getAttribute("src") || "";
  // youtube_url 直接吃 /embed/ 形式：官方 includes/embed.php 的 YouTube 正则同时认 watch?v= / embed/ / shorts/
  if (/youtube(?:-nocookie)?\.com|youtu\.be/.test(src)) return widget("video", { video_type: "youtube", youtube_url: src });
  if (/vimeo\.com/.test(src)) return widget("video", { video_type: "vimeo", vimeo_url: src });
  // 自托管视频：原来一律退成原始 HTML，而视频小组件本身就支持。
  // ⚠ 三个键必须一起写：external_url 带 condition video_type=hosted 且 insert_url=yes（video.php），
  //   缺任何一个都会被静默忽略，结果是一个播不了的空播放器。
  if (node.tagName === "VIDEO" && /^https?:\/\//i.test(src)) {
    const flag = attr => (node.hasAttribute(attr) ? "yes" : "");
    return widget("video", {
      video_type: "hosted",
      insert_url: "yes",
      external_url: { url: src, is_external: "", nofollow: "", custom_attributes: "" },
      controls: flag("controls"),
      autoplay: flag("autoplay"),
      mute: flag("muted"),
      loop: flag("loop"),
    });
  }
  return htmlWidget(node.outerHTML);
}

function convertForcedNode(target, node, style, win, options, emit, depth = 0) {
  if (!target || target === "auto") return null;
  if (target === "skip") return [];
  if (target.startsWith("atomic:")) {
    const componentId = target.slice(7);
    const component = COMPONENT_REGISTRY.get(`atomic:${componentId}`);
    if (!componentAllowedForTarget(component, options)) {
      warning(options.warnings || [], `component-unavailable-${componentId}`, `${componentLabel(componentId)} is not available on the selected target site; the original content was kept.`);
      return null;
    }
    options.convertedNodes.add(node);
    const children = component?.kind === "element"
      ? [...node.childNodes].flatMap(child => convertNode(child, win, options, depth + 1))
      : [];
    const atomicMessage = VERIFIED_ATOMIC_COMPONENTS.has(componentId)
      ? `${componentLabel(componentId)} was created from the verified Atomic props schema; the target site needs Atomic Widgets enabled.`
      : `${componentLabel(componentId)} has no reliable HTML mapping yet, so an empty Atomic element was created; fill in its content in Elementor.`;
    warning(options.warnings || [], `atomic-component-${componentId}`, atomicMessage);
    return emit(atomicComponent(componentId, node, children, component?.kind === "element", options));
  }
  if (target.startsWith("widget:")) {
    const componentId = target.slice(target.indexOf(":") + 1);
    const component = COMPONENT_REGISTRY.get(`classic:${componentId}`);
    if (!componentAllowedForTarget(component, options)) {
      warning(options.warnings || [], `component-unavailable-${componentId}`, `${componentLabel(componentId)} is not available on the selected target site; the original content was kept.`);
      return null;
    }
    if (["image-gallery", "image-carousel"].includes(componentId) && !allMediaCouldProduceUrls(node, options)) {
      warning(options.warnings || [], `${componentId}-media-incomplete`, `${componentLabel(componentId)} contains relative or data images that would become empty; they were kept as separate Image widgets.`);
      return null;
    }
    options.convertedNodes.add(node);
    const settings = genericComponentSettings(componentId, node, style, options);
    warning(options.warnings || [], `generic-component-${componentId}`, `${componentLabel(componentId)} was created as a native Elementor widget; check the settings the HTML cannot express, such as animation or behaviour, in Elementor.`);
    if (componentId === "form") {
      // ⚠ 表单小组件只装得下字段和按钮。表单里的标题、说明、「点击注册即表示同意…」原来整段丢了
      //   （真实站点体检：Bootstrap heroes 的注册框、footers 的订阅框）。按文档顺序取出来，放到表单上方/下方。
      const firstField = node.querySelector("input:not([type=hidden]), select, textarea, button");
      const parts = formExtraText(node).map(el => {
        const s = win.getComputedStyle(el);
        const w = /^H[1-6]$/.test(el.tagName)
          ? buildHeading(el, s, options)
          : buildTextEditor(el, s, options, el.tagName === "P" ? outerHtmlWithoutRootStyle(el) : `<p>${el.innerHTML.trim()}</p>`);
        options.convertedNodes.add(el);
        const before = firstField && (el.compareDocumentPosition(firstField) & Node.DOCUMENT_POSITION_FOLLOWING);
        return { w, before };
      });
      const formWidget = emit(widget(componentId, settings));
      return [...parts.filter(p => p.before).map(p => p.w), ...formWidget, ...parts.filter(p => !p.before).map(p => p.w)];
    }
    return emit(widget(componentId, settings));
  }
  if (target === "html") {
    options.convertedNodes.add(node);
    return emit(htmlWidget(node.outerHTML));
  }
  if (target === "container") {
    const children = [];
    [...node.childNodes].forEach(child => children.push(...convertNode(child, win, options, depth + 1)));
    options.convertedNodes.add(node);
    const result = container(node, style, children, options);
    Object.assign(result.settings, elementWidthSettings(node, node.parentElement));
    return emit(result);
  }
  if (target === "heading") {
    options.convertedNodes.add(node);
    return emit(buildHeading(node, style, options));
  }
  if (target === "text") {
    options.convertedNodes.add(node);
    const editor = ["P", "BLOCKQUOTE", "UL", "OL", "TABLE", "DL", "PRE"].includes(node.tagName)
      ? blockEditorHtml(node)
      : `<p>${escapeHtml(cleanText(node.textContent))}</p>`;
    return emit(buildTextEditor(node, style, options, editor));
  }
  if (target === "image") {
    options.convertedNodes.add(node);
    return emit(buildImage(node, style, options));
  }
  if (target === "button") {
    options.convertedNodes.add(node);
    return emit(buildButton(node, style, options));
  }
  if (target === "icon") {
    options.convertedNodes.add(node);
    return emit(convertIcon(node, style, options));
  }
  if (target === "divider") {
    options.convertedNodes.add(node);
    return emit(buildDivider(node, style, options));
  }
  if (target === "video") {
    options.convertedNodes.add(node);
    return emit(buildVideo(node));
  }
  return null;
}

function atomicValue(type, value) {
  return { "$$type": type, value };
}

function atomicHtml(value) {
  return atomicValue("html-v3", { content: atomicValue("string", value), children: [] });
}

function atomicComponent(componentId, node, children, isElement, options) {
  const text = cleanText(node.textContent);
  const settings = {};
  if (componentId === "e-heading") {
    settings.title = atomicHtml(text || "Heading");
    const headingTag = /^H[1-6]$/.test(node.tagName) ? resolveHeadingTag(node.tagName, options) : "h2";
    settings.tag = atomicValue("string", headingTag);
  } else if (componentId === "e-paragraph") {
    settings.paragraph = atomicHtml(text);
    settings.tag = atomicValue("string", node.tagName === "SPAN" ? "span" : "p");
  } else if (componentId === "e-button") {
    settings.text = atomicHtml(text || "Button");
    settings.tag = atomicValue("string", node.tagName === "A" ? "a" : "button");
    const href = node.closest?.("a")?.getAttribute("href") || node.getAttribute("href") || "";
    if (href) settings.link = atomicValue("link", {
      destination: atomicValue("url", href),
      isTargetBlank: atomicValue("boolean", node.getAttribute("target") === "_blank"),
      tag: atomicValue("string", "a")
    });
  } else if (componentId === "e-image") {
    const image = node.tagName === "IMG" ? node : node.querySelector("img");
    const url = options.imageMode === "placeholder" ? "" : mediaSource(image, options);
    if (url) settings.image = atomicValue("image", {
      src: atomicValue("image-src", {
        id: null,
        url: atomicValue("url", url),
        alt: atomicValue("string", image?.getAttribute("alt") || "")
      }),
      size: atomicValue("string", "full")
    });
  }
  if (isElement) {
    return { id: id(), elType: componentId, settings, elements: children, isLocked: false, editor_settings: {} };
  }
  return { id: id(), elType: "widget", settings, elements: [], widgetType: componentId, isLocked: false, editor_settings: {} };
}

function formFieldId(field, index, usedIds) {
  const source = field.getAttribute("name") || field.id || `field_${index + 1}`;
  const base = source.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^(\d)/, "_$1") || `field_${index + 1}`;
  let value = base;
  let suffix = 2;
  while (usedIds.has(value)) value = `${base}_${suffix++}`;
  usedIds.add(value);
  return value;
}

function formFields(node, fieldEls = null) {
  const fields = [...node.querySelectorAll("input,textarea,select")]
    .filter(field => !["submit", "button", "reset", "image"].includes(field.type));
  const usedIds = new Set();
  const grouped = new Set();
  return fields.flatMap((field, index) => {
    const inputType = String(field.type || "text").toLowerCase();
    const groupName = field.getAttribute("name") || "";
    if (["radio", "checkbox"].includes(inputType) && groupName) {
      const groupKey = `${inputType}:${groupName}`;
      if (grouped.has(groupKey)) return [];
      grouped.add(groupKey);
    }
    const customId = formFieldId(field, index, usedIds);
    let fieldType = field.tagName === "TEXTAREA" ? "textarea" : field.tagName === "SELECT" ? "select" : inputType;
    if (fieldType === "file") fieldType = "upload";
    if (fieldType === "range") fieldType = "number";
    const allowedTypes = new Set(["text", "email", "textarea", "tel", "url", "number", "date", "time", "select", "checkbox", "radio", "password", "hidden", "search", "upload"]);
    if (!allowedTypes.has(fieldType)) fieldType = "text";
    let fieldOptions = "";
    if (field.tagName === "SELECT") {
      fieldOptions = [...field.options].map(option => {
        const label = cleanText(option.textContent);
        return option.value && option.value !== label ? `${label}|${option.value}` : label;
      }).join("\n");
    } else if (["radio", "checkbox"].includes(fieldType)) {
      const optionFields = groupName
        ? [...node.querySelectorAll(`input[type="${fieldType}"][name="${CSS.escape(groupName)}"]`)]
        : [field];
      fieldOptions = optionFields.map(option => {
        const label = option.labels?.[0]?.textContent?.trim() || option.getAttribute("aria-label") || option.value || "Option";
        return option.value && option.value !== label ? `${label}|${option.value}` : label;
      }).join("\n");
    }
    if (fieldEls) fieldEls.push(field);
    return [{
      _id: id(),
      custom_id: customId,
      field_type: fieldType,
      field_label: field.labels?.[0]?.textContent?.trim() || field.getAttribute("aria-label") || groupName || customId,
      placeholder: field.getAttribute("placeholder") || "",
      required: field.required ? "true" : "",
      field_options: fieldOptions,
      field_value: field.value || "",
      width: "100",
      allow_multiple: field.multiple ? "yes" : ""
    }];
  });
}

// Pro 表单的布局与样式（控件名对照 elementor-pro/modules/forms/widgets/form.php）。
// ⚠ 原来只转字段和按钮文字：只有 aria-label 的输入框导入后多出一行可见标签（show_labels 默认开），
//   「输入框 + 按钮同一行」变成两行、按钮铺满（字段 width / button_width 默认 100），按钮字体被站点全局字体换掉
//   （真实 Elementor 渲染比对抓出）。宽度控件是下拉，只能吸附到固定百分比。
const FORM_WIDTHS = [20, 25, 30, 33, 40, 50, 60, 66, 70, 75, 80, 100];
function snapFormWidth(pct) {
  return FORM_WIDTHS.reduce((best, w) => (Math.abs(w - pct) < Math.abs(best - pct) ? w : best), 100);
}
function formLayoutAndStyle(settings, node, fieldEls, submit, view, options) {
  const visible = fieldEls.map((el, i) => ({ el, i, r: el.getBoundingClientRect() })).filter(f => f.r.width > 0);
  // 标签：一个可见的 <label> 都没有 → 关掉标签（有就保持默认的「显示」）
  const hasVisibleLabel = fieldEls.some(el => [...(el.labels || [])].some(l => l.getBoundingClientRect().width > 0));
  if (!hasVisibleLabel) settings.show_labels = "";
  const formRect = node.getBoundingClientRect();
  const items = submit ? [...visible, { el: submit, i: -1, r: submit.getBoundingClientRect() }] : visible;
  if (formRect.width > 0 && items.length) {
    // 同一行的元素之间的水平间距 → column_gap；上下两行之间 → row_gap
    const sorted = [...items].sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
    let colGap = null, rowGap = null;
    for (let k = 1; k < sorted.length; k++) {
      const a = sorted[k - 1].r, b = sorted[k].r;
      if (Math.abs(a.top - b.top) < 4) colGap = colGap ?? Math.max(0, Math.round(b.left - a.right));
      else rowGap = rowGap ?? Math.max(0, Math.round(b.top - a.bottom));
    }
    const g = colGap ?? 0;
    settings.column_gap = { unit: "px", size: g, sizes: [] };
    settings.row_gap = { unit: "px", size: rowGap ?? 0, sizes: [] };
    // Elementor 的每个字段组宽 = 百分比 × (表单宽 + 间距)，组内左右各留半个间距
    const pct = r => ((r.width + g) / (formRect.width + g)) * 100;
    // 勾选框 / 单选框：控件本身只有十几像素宽，按它算会吸附成 20%，导入后整行文字被挤成窄条。
    // 改量「控件 + 它的 label」的外接矩形；包着它的父元素里没有别的表单字段时，量父元素（整行）。
    const fieldRect = el => {
      if (!/^(checkbox|radio)$/i.test(el.type || "")) return el.getBoundingClientRect();
      const parent = el.parentElement;
      if (parent && parent !== node && parent.querySelectorAll("input,select,textarea").length === 1) return parent.getBoundingClientRect();
      const rects = [el, ...(el.labels || [])].map(x => x.getBoundingClientRect()).filter(r => r.width > 0);
      const left = Math.min(...rects.map(r => r.left)), right = Math.max(...rects.map(r => r.right));
      return { width: right - left };
    };
    for (const f of visible) settings.form_fields[f.i].width = String(snapFormWidth(pct(fieldRect(f.el))));
    if (submit) settings.button_width = String(snapFormWidth(pct(submit.getBoundingClientRect())));
  }
  const first = visible[0]?.el;
  if (first) {
    const fs = view.getComputedStyle(first);
    typography(settings, "field_typography", fs, options);
    if (options.colorMode !== "site") {
      settings.field_text_color = color(fs.color);
      settings.field_background_color = color(fs.backgroundColor);
      if (fs.borderTopStyle !== "none") settings.field_border_color = color(fs.borderTopColor);
    }
    settings.field_border_width = dimensions(fs, "border");
    const r = Math.round(parseFloat(fs.borderTopLeftRadius) || 0);
    settings.field_border_radius = { unit: "px", top: String(r), right: String(r), bottom: String(r), left: String(r), isLinked: true };
  }
  if (submit) {
    const bs = view.getComputedStyle(submit);
    typography(settings, "button_typography", bs, options);
    if (options.colorMode !== "site") {
      settings.button_background_color = color(bs.backgroundColor);
      settings.button_text_color = color(bs.color);
    }
    const r = Math.round(parseFloat(bs.borderTopLeftRadius) || 0);
    settings.button_border_radius = { unit: "px", top: String(r), right: String(r), bottom: String(r), left: String(r), isLinked: true };
    const pad = dimensions(bs, "padding", true);
    if (pad) settings.button_text_padding = pad;
  }
}

function genericComponentSettings(componentId, node, style, options) {
  const settings = commonSettings(node, style);
  const text = cleanText(node.textContent);
  const anchor = node.closest?.("a") || node.querySelector?.("a");
  const image = node.tagName === "IMG" ? node : node.querySelector?.("img");
  if (/heading|title|headline/.test(componentId)) settings.title = text || "Heading";
  if (/button/.test(componentId)) {
    settings.text = text || "Button";
    settings.link = anchor ? linkValue(anchor) : { url: "", is_external: "", nofollow: "", custom_attributes: "" };
  }
  if (/image|logo/.test(componentId) && !["image-gallery", "image-carousel"].includes(componentId) && image) {
    settings.image = { url: options.imageMode === "placeholder" ? "" : mediaSource(image, options), id: "" };
  }
  const view = node.ownerDocument?.defaultView || null;
  if (componentId === "progress") {
    // ⚠ 三个键必须显式写空：官方默认 title=「My Skill」、inner_text=「Web Designer」、
    //   display_percentage=show。原来只写了 title/percent，导入后条里凭空出现「Web Designer」。
    //   标签文字在原页面上是独立元素，会单独转成文本，这里不再重复。
    settings.title = node.getAttribute("aria-label") || "";
    settings.inner_text = "";
    settings.display_percentage = "";
    const bar = progressParts(node, view);
    if (bar) {
      settings.percent = { unit: "%", size: bar.percent, sizes: [] };
      if (options.colorMode !== "site") {
        const fillColor = color(bar.fillStyle.backgroundColor);
        if (fillColor) settings.bar_color = fillColor;
        const trackColor = color(style.backgroundColor);
        if (trackColor) settings.bar_bg_color = trackColor;
      }
      settings.bar_height = { unit: "px", size: Math.round(bar.height), sizes: [] };
    } else {
      settings.percent = { unit: "%", size: Math.round(Number(node.getAttribute("value") || 0) / Number(node.getAttribute("max") || 100) * 100), sizes: [] };
    }
  }
  if (componentId === "star-rating" && !starText(node) && svgStars(node)) {
    const sv = svgStars(node);
    const aria = (node.getAttribute("aria-label") || "").match(/(\d+(?:\.\d+)?)\s*(?:out of|\/|of)\s*(\d+)/i);
    const total = aria ? Number(aria[2]) : sv.total;
    settings.rating_scale = total > 5 ? "10" : "5";
    settings.rating = aria ? Number(aria[1]) : sv.lit;
    settings.title = "";
    settings.unmarked_star_style = "solid";
    if (options.colorMode !== "site") {
      const on = color(sv.on); if (on) settings.stars_color = on;
      const off = color(sv.off); if (off) settings.stars_unmarked_color = off;
    }
    const size = node.children[0].getBoundingClientRect?.().width;
    if (size) settings.icon_size = { unit: "px", size: Math.round(size), sizes: [] };
  } else if (componentId === "star-rating") {
    const stars = starText(node) || "";
    let rating = 0;
    for (const ch of stars) rating += STAR_FULL.includes(ch) ? 1 : STAR_HALF.includes(ch) ? 0.5 : 0;
    const aria = (node.getAttribute("aria-label") || "").match(/(\d+(?:\.\d+)?)\s*(?:out of|\/|of)\s*(\d+)/i);
    const total = aria ? Number(aria[2]) : [...stars].length;
    settings.rating_scale = total > 5 ? "10" : "5";
    settings.rating = aria ? Number(aria[1]) : rating;
    settings.title = "";
    settings.star_style = "star_unicode";
    settings.unmarked_star_style = [...stars].some(ch => STAR_EMPTY.includes(ch)) ? "outline" : "solid";
    if (options.colorMode !== "site") { const c = color(style.color); if (c) settings.stars_color = c; }
    const fs = parseFloat(style.fontSize);
    if (fs) settings.icon_size = { unit: "px", size: Math.round(fs), sizes: [] };
  }
  if (componentId === "testimonial") {
    const t = testimonialParts(node, view);
    if (t) {
      settings.testimonial_content = t.quoteText;
      settings.testimonial_name = t.name;
      settings.testimonial_job = t.job;   // 必须写（哪怕是空）：默认是「Designer」
      settings.testimonial_image = t.img
        ? { url: options.imageMode === "placeholder" ? "" : mediaSource(t.img, options), id: "" }
        : { url: "", id: "" };             // 必须写（哪怕是空）：默认是占位图
      if (t.img && t.nameEl && t.img.getBoundingClientRect().bottom <= t.nameEl.getBoundingClientRect().top + 2) settings.testimonial_image_position = "top";
      // 对齐看引语本身：识别根常常是外层 section（左对齐），居中写在里层的 .quote 上
      const align = (view?.getComputedStyle(t.quote) || style).textAlign;
      // ⚠ 取值是逻辑方向 start/center/end（testimonial.php），不是 left/right —— 写 left 会被静默忽略
      settings.testimonial_alignment = align === "center" ? "center" : (align === "right" || align === "end") ? "end" : "start";
      const qs = view?.getComputedStyle(t.quote);
      if (qs) {
        typography(settings, "content_typography", qs, options);
        if (options.colorMode !== "site") settings.content_content_color = color(qs.color);
      }
      if (t.nameEl && view) {
        const ns = view.getComputedStyle(t.nameEl);
        typography(settings, "name_typography", ns, options);
        if (options.colorMode !== "site") settings.name_text_color = color(ns.color);
      }
    }
  }
  if (componentId === "spacer") {
    settings.space = { unit: "px", size: spacerHeight(node, view) || Math.round(node.getBoundingClientRect?.().height || 50), sizes: [] };
  }
  if (componentId === "shortcode") settings.shortcode = text;
  if (componentId === "html") settings.html = node.outerHTML;
  if (componentId === "form") {
    settings.form_name = node.getAttribute("name") || node.getAttribute("id") || "Converted Form";
    const fieldEls = [];
    settings.form_fields = formFields(node, fieldEls);
    const submit = node.querySelector("button[type='submit'],button:not([type]),input[type='submit']");
    settings.button_text = cleanText(submit?.textContent) || submit?.getAttribute("value") || "Submit";
    settings.submit_actions = [];
    if (view) formLayoutAndStyle(settings, node, fieldEls, submit, view, options);
  }
  const images = [...node.querySelectorAll("img")]
    .map(item => ({ url: options.imageMode === "placeholder" ? "" : mediaSource(item, options), id: "" }))
    .filter(item => options.imageMode === "placeholder" || item.url);
  if (componentId === "image-gallery") {
    settings.wp_gallery = images;
    // 列数按实际排版数：第一行里有几张就是几列。原来按 √张数 猜 —— 6 张图的三列网格会被猜成 2 列。
    const items = [...node.children];
    let columns = Math.round(Math.sqrt(images.length || 1));
    if (items.length && items[0].getBoundingClientRect) {
      const top = items[0].getBoundingClientRect().top;
      const firstRow = items.filter(item => Math.abs(item.getBoundingClientRect().top - top) < 4).length;
      if (firstRow > 0 && node.getBoundingClientRect().width > 0) columns = firstRow;
    }
    settings.gallery_columns = String(Math.min(10, Math.max(1, columns)));
    settings.thumbnail_size = "full";
  }
  if (componentId === "image-carousel") {
    settings.carousel_name = node.getAttribute("aria-label") || "Converted Carousel";
    settings.carousel = images;
    settings.slides_to_show = String(Math.min(4, Math.max(1, images.length))); // 该控件是字符串选项（image-carousel.php:525 默认 '1'），传数字会被忽略
    settings.thumbnail_size = "full";
  }
  if (componentId === "social-icons") {
    // 按主机名判断品牌（socialBrand）；原来对整条 URL 跑 /x\.com/，会把 box.com、dropbox.com 认成 X。
    settings.social_icon_list = [...node.querySelectorAll("a[href]")].map(link => {
      const name = socialBrand(link.getAttribute("href")) || "link";
      return {
        _id: id(),
        social_icon: { value: `${name === "link" ? "fas" : "fab"} fa-${name}`, library: name === "link" ? "fa-solid" : "fa-brands" },
        link: linkValue(link),
        item_icon_color: "default"
      };
    });
  }
  if (componentId === "counter") {
    settings.starting_number = 0;
    const parts = counterParts(node, view);
    if (parts) {
      // 前缀/后缀要拆出来：原来「10,000+ Happy users」的标题会变成「+ Happy users」
      settings.ending_number = Number(parts.digits.replace(/[,\s]/g, "") + (parts.decimals ? "." + parts.decimals : ""));
      settings.prefix = parts.prefix;
      settings.suffix = parts.suffix;
      settings.title = parts.label;
      // ⚠ 千分位默认是开（counter.php:198）：原页面写 10000 的话不关掉就会显示成 10,000
      settings.thousand_separator = /[,\s]/.test(parts.digits) ? "yes" : "";
      if (view) {
        const ns = view.getComputedStyle(parts.numberEl);
        typography(settings, "typography_number", ns, options);
        if (options.colorMode !== "site") settings.number_color = color(ns.color);
        // 标签的排版原来只在类名兜底路径里写，结构识别路径漏了（深度审计 D：Bootstrap 统计数字的「Clients」没字号没字体）
        if (parts.labelEl) {
          const ls = view.getComputedStyle(parts.labelEl);
          typography(settings, "typography_title", ls, options);
          if (options.colorMode !== "site") settings.title_color = color(ls.color);
          // 数字与标题的间距 → title_gap（counter.php:368）；数字行高是 normal 时量出实际像素写进去
          // （Elementor 的计数数字默认行高 1，比浏览器 normal 矮一截）。原来两样都没写，标题整体上移 11~14px（真实渲染比对抓出）。
          const nr = parts.numberEl.getBoundingClientRect();
          const lr = parts.labelEl.getBoundingClientRect();
          settings.title_gap = { unit: "px", size: Math.max(0, Math.round(Math.max(lr.top - nr.bottom, nr.top - lr.bottom))), sizes: [] };
          if (options.fontMode !== "site" && ns.lineHeight === "normal" && nr.height) {
            settings.typography_number_line_height = { unit: "px", size: Math.round(nr.height), sizes: [] };
          }
        }
      }
    } else {
      // 类名识别进来的（如 id="stat-size" 的「0 KB」）：整段就是一个数字，标签在别的元素里
      const whole = text.match(COUNTER_NUMBER);
      if (whole) {
        settings.ending_number = Number(whole[2].replace(/[,\s]/g, "") + (whole[3] ? "." + whole[3] : ""));
        settings.prefix = whole[1];
        settings.suffix = whole[4] || "";
        settings.title = "";   // 空就空着：默认是「Cool Number」
        settings.thousand_separator = /[,\s]/.test(whole[2]) ? "yes" : "";
      } else {
        // 类名识别进来、但数字和标签同字号的（结构识别因此没认）：数字 + 后缀 + 其余当标题。
        // ⚠ 后缀必须单独捕获：原来只匹配数字，「10,000+ Happy users」的「+」漏进了标题，变成「+Happy users」（深度审计 D 抓出）。
        const m = text.match(/^([+-]?[$€£¥₹]?)\s?(\d{1,3}(?:[,\s]\d{3})+|\d+(?:\.\d+)?)(\s?(?:%|[A-Za-z]{1,3})?\+?)\s*([\s\S]*)$/);
        settings.ending_number = Number((m?.[2] || "0").replace(/[,\s]/g, "")) || 0;
        settings.prefix = m?.[1] || "";
        settings.suffix = m?.[3] || "";
        settings.title = cleanText(m ? m[4] : text.replace(/[\d,.]+/, ""));
        settings.thousand_separator = /[,\s]/.test(m?.[2] || "") ? "yes" : "";
        // 标签和数字的排版：按文字找到各自的元素
        if (view) {
          const leaves = [];
          const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          for (let t = walker.nextNode(); t; t = walker.nextNode()) if (cleanText(t.textContent)) leaves.push(t.parentElement);
          const numberEl = leaves.find(el => /\d/.test(el.textContent));
          const labelEl = leaves.find(el => el !== numberEl && cleanText(el.textContent) === settings.title);
          if (numberEl) { const ns = view.getComputedStyle(numberEl); typography(settings, "typography_number", ns, options); if (options.colorMode !== "site") settings.number_color = color(ns.color); }
          if (labelEl) { const ls = view.getComputedStyle(labelEl); typography(settings, "typography_title", ls, options); if (options.colorMode !== "site") settings.title_color = color(ls.color); }
        }
      }
    }
  }
  if (componentId === "alert") {
    settings.alert_type = "info";
    // 没有标题就留空：原来兜底写「Notice」，等于凭空给用户的页面加了一个词（深度审计 D 抓出）
    settings.alert_title = cleanText(node.querySelector("strong,h1,h2,h3,h4")?.textContent) || "";
    settings.alert_description = text;
    settings.show_dismiss = "";
    // 颜色跟源走（键已对 alert.php 核对：background / border_color / title_color / description_color），否则一律是蓝色「info」样式
    if (options.colorMode !== "site") {
      const bg = color(style.backgroundColor); if (bg) settings.background = bg;
      const bc = color(style.borderLeftColor || style.borderTopColor); if (bc) settings.border_color = bc;
      const tc = color(style.color); if (tc) { settings.description_color = tc; settings.title_color = tc; }
    }
    // 排版组的名字是 alert_title / alert_description（alert.php:281/321），键就是 alert_description_font_size 这种
    typography(settings, "alert_description", style, options);
    const titleEl = node.querySelector("strong,h1,h2,h3,h4");
    if (titleEl && view) typography(settings, "alert_title", view.getComputedStyle(titleEl), options);
  }
  const ariaItems = componentId === "accordion" && !node.querySelector("details") ? ariaAccordionItems(node) : null;
  if (ariaItems) {
    // div + aria-expanded 写的手风琴（收起的面板带 hidden，内容照样要带过去）
    settings.tabs = ariaItems.map(item => ({ _id: id(), tab_title: item.title || "Item", tab_content: item.content }));
  } else if (componentId === "accordion") {
    const details = node.tagName === "DETAILS" ? [node] : [...node.querySelectorAll("details")];
    settings.tabs = details.map(detail => ({
      _id: id(),
      tab_title: cleanText(detail.querySelector("summary")?.textContent) || "Item",
      tab_content: [...detail.childNodes].filter(child => child.nodeName !== "SUMMARY").map(child => child.outerHTML || escapeHtml(child.textContent || "")).join("")
    }));
    if (view && details.length) accordionStyle(settings, details[0], view, options);
  }
  const bsTabs = componentId === "tabs" ? bootstrapTabs(node) : null;
  if (bsTabs) {
    // Bootstrap：.tab-content 是面板的容器而不是面板本身，按原来的选择器会把整个容器当成一个面板
    settings.tabs = bsTabs.map((tab, index) => ({ _id: id(), tab_title: tab.title || `Tab ${index + 1}`, tab_content: tab.content }));
  } else if (componentId === "tabs") {
    const titleSelectors = "[role='tab'],.tab-title,.tabs-title,[data-tab]";
    const panelSelectors = "[role='tabpanel'],.tab-content,.tabs-content";
    const titles = [...node.querySelectorAll(titleSelectors)].filter(item => !item.matches(panelSelectors));
    const panels = [...node.querySelectorAll(panelSelectors)].filter(item => !item.matches(titleSelectors));
    settings.tabs = titles.map((title, index) => ({
      _id: id(),
      tab_title: cleanText(title.textContent) || `Tab ${index + 1}`,
      tab_content: panels[index]?.innerHTML?.trim() || ""
    }));
  }
  return settings;
}

// <details> 手风琴的外观 → 经典手风琴的样式控件（键名已对 accordion.php 核对：title_color / tab_active_color /
//   title_typography / title_padding / icon_align / icon_color / icon_active_color / content_color / content_typography /
//   content_padding / border_width / border_color / selected_icon）。
//   原来只写标题和内容，导入后是 Elementor 默认外观：主题强调色（绿色）标题 + 灰色方框（2026-10-15 Northwind 测试页）。
const ACCORDION_LINES_CLASS = "hte-acc-lines";
function accordionStyle(settings, detail, view, options) {
  const summary = detail.querySelector("summary");
  if (!summary) return;
  const ds = view.getComputedStyle(detail);
  const ss = view.getComputedStyle(summary);
  const n = value => parseFloat(value) || 0;
  const box = (top, right, bottom, left) => ({ unit: "px", top: String(Math.round(top)), right: String(Math.round(right)), bottom: String(Math.round(bottom)), left: String(Math.round(left)), isLinked: false });
  const body = [...detail.children].find(child => child.tagName !== "SUMMARY") || null;
  const bs = body ? view.getComputedStyle(body) : ds;
  // 标题区 = details 的上下左右内边距 + summary 自己的内边距（收起时 details 的下内边距也在标题下方）。
  settings.title_padding = box(n(ds.paddingTop) + n(ss.paddingTop), n(ds.paddingRight) + n(ss.paddingRight), n(ds.paddingBottom) + n(ss.paddingBottom), n(ds.paddingLeft) + n(ss.paddingLeft));
  // 内容区：标题已带下内边距，内容上方不再加；下方补 details 的下内边距，展开时底部留白和源一致。
  settings.content_padding = box(0, n(ds.paddingRight), n(ds.paddingBottom), n(ds.paddingLeft));
  typography(settings, "title_typography", ss, options);
  if (body) typography(settings, "content_typography", bs, options);
  if (options.colorMode !== "site") {
    settings.title_color = color(ss.color);
    settings.tab_active_color = color(ss.color);
    if (body) settings.content_color = color(bs.color);
    settings.title_background = color(ss.backgroundColor);
    settings.content_background_color = color(ds.backgroundColor);
  }
  // 开合标记：::after 在右、::before 在左；都没有、又关掉了默认三角（list-style:none / 非 list-item）→ 不要图标。
  const marker = side => {
    const ps = view.getComputedStyle(summary, side);
    return ps.content && ps.content !== "none" && ps.content !== "normal" && ps.content !== '""' ? ps : null;
  };
  const after = marker("::after");
  const before = marker("::before");
  if (after || before) {
    settings.icon_align = after ? "right" : "left";
    if (options.colorMode !== "site") {
      const c = color((after || before).color);
      settings.icon_color = c;
      settings.icon_active_color = c;
    }
  } else if (ss.display !== "list-item") {
    settings.selected_icon = { value: "", library: "" };
  }
  // 边框：只有底边线（FAQ 最常见）时，经典手风琴的「整圈方框」不对 —— 打个标记类，由本块 CSS 改成只留底线。
  const widths = [ds.borderTopWidth, ds.borderRightWidth, ds.borderBottomWidth, ds.borderLeftWidth].map(n);
  const w = Math.max(...widths);
  settings.border_width = { unit: "px", size: Math.round(w), sizes: [] };   // 必须写（哪怕是 0）：默认 1px 灰框
  if (w > 0 && options.colorMode !== "site") settings.border_color = color(ds.borderBottomColor || ds.borderTopColor);
  if (w > 0 && widths[0] === 0 && widths[1] === 0 && widths[3] === 0) {
    settings._css_classes = [settings._css_classes, ACCORDION_LINES_CLASS].filter(Boolean).join(" ");
  }
}

// 转换阶段（有真实计算样式）：识别被 CSS 样式成按钮的 a/button/div/span，即使没有 .btn 类。
function looksLikeButton(node, style) {
  const tag = node.tagName;
  const isCandidate =
    tag === "A" ||
    tag === "BUTTON" ||
    node.getAttribute("role") === "button" ||
    ((tag === "SPAN" || tag === "DIV") && style.cursor === "pointer");
  if (!isCandidate) return false;
  // 按钮是单行内容，含块级子元素则不是按钮。
  const hasBlockChild = [...node.children].some(
    child =>
      CONTAINER_TAGS.has(child.tagName) ||
      ["P", "UL", "OL", "TABLE", "H1", "H2", "H3", "H4", "H5", "H6"].includes(child.tagName)
  );
  if (hasBlockChild) return false;
  const text = cleanText(node.textContent);
  if (!text || text.length > 48) return false;
  const bg = style.backgroundColor;
  const hasBg = bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)";
  const hasBorder =
    parseFloat(style.borderTopWidth) > 0 ||
    parseFloat(style.borderBottomWidth) > 0 ||
    parseFloat(style.borderLeftWidth) > 0 ||
    parseFloat(style.borderRightWidth) > 0;
  const radius = parseFloat(style.borderTopLeftRadius) || 0;
  const padX = parseFloat(style.paddingLeft) || 0;
  const padY = parseFloat(style.paddingTop) || 0;
  const disp = style.display;
  const buttonish = disp === "inline-block" || disp === "inline-flex" || disp === "flex" || disp === "block";
  return (hasBg || hasBorder) && radius >= 3 && (padX >= 6 || padY >= 4) && buttonish;
}

// 转换阶段：无任何视觉/布局作用的透传包裹层（纯嵌套），折叠掉以减少 Elementor 层级。
function isTransparentWrapper(node, style) {
  const disp = style.display;
  if (disp === "flex" || disp === "inline-flex" || disp === "grid" || disp === "inline-grid") return false;
  const pos = style.position;
  if (pos === "fixed" || pos === "absolute" || pos === "sticky") return false;
  const bg = style.backgroundColor;
  if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") return false;
  if (style.backgroundImage && style.backgroundImage !== "none") return false;
  const border =
    (parseFloat(style.borderTopWidth) || 0) +
    (parseFloat(style.borderRightWidth) || 0) +
    (parseFloat(style.borderBottomWidth) || 0) +
    (parseFloat(style.borderLeftWidth) || 0);
  if (border > 0) return false;
  const pad =
    (parseFloat(style.paddingTop) || 0) +
    (parseFloat(style.paddingRight) || 0) +
    (parseFloat(style.paddingBottom) || 0) +
    (parseFloat(style.paddingLeft) || 0);
  if (pad > 2) return false;
  if (style.boxShadow && style.boxShadow !== "none") return false;
  if (style.maxWidth && style.maxWidth !== "none") return false; // 居中约束容器保留
  if ((parseFloat(style.minHeight) || 0) > 0) return false;
  if (style.marginLeft === "auto" || style.marginRight === "auto") return false; // 居中包裹层保留
  return true;
}

function convertNode(node, win, options, depth = 0) {
  if (node.nodeType === Node.TEXT_NODE) {
    if (options.nativeStrategy === "framework") return [];
    const text = cleanText(node.textContent);
    if (!text) return [];
    // ⚠ 直接落在容器里的文字要带上父元素的字号/颜色/字体：原来空手转出一个文本编辑器，
    //   <div class="price">$29</div> 这种 40px 粗体的数字导入后就是默认 16px 黑字（深度审计 D 抓出）。
    //   只取排版和颜色，不取父元素的外边距/内边距 —— 那些归容器。
    const settings = { editor: `<p>${escapeHtml(text)}</p>` };
    const parent = node.parentElement;
    if (parent && win?.getComputedStyle) {
      const ps = win.getComputedStyle(parent);
      if (options.colorMode !== "site") settings.text_color = color(ps.color);
      typography(settings, "typography", ps, options);
    }
    return [widgetWithGlobals("text-editor", settings, options)];
  }
  // SOURCE/TRACK 只是 <picture>/<video> 的附属子元素：原来会被单独转成一个原始 HTML 小组件
  if (node.nodeType !== Node.ELEMENT_NODE || ["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE", "SOURCE", "TRACK"].includes(node.tagName)) return [];
  // 只装 <symbol> / <defs> 的 SVG 是图标库，本身永远不渲染；引用处已在清洗阶段就地展开，这里不必再生成一个空的 HTML 小组件
  if (node.tagName.toLowerCase() === "svg" && node.children.length && [...node.children].every(c => /^(symbol|defs|title|desc)$/i.test(c.tagName))) return [];
  if (depth > MAX_CONVERT_DEPTH) {
    warning(options.warnings || [], "max-depth-html-fallback", "Some markup is nested too deeply; the deepest part was kept as an HTML widget.");
    return [htmlWidget(node.outerHTML)];
  }
  const style = win.getComputedStyle(node);
  // visibility:hidden = 当前状态下看不见（悬停才出的角标、待激活的提示）。它照样占位，
  // 原来会被当普通元素转出来，在 Elementor 里变成一根看得见的色条（腾讯工具页 6 张卡右侧的蓝灰竖条就是它）。
  // 只有后代里有人显式 visibility:visible 时才保留（CSS 允许子元素重新显示）。
  if (style.visibility === "hidden" && ![...node.querySelectorAll("*")].some(d => win.getComputedStyle(d).visibility === "visible")) {
    options.convertedNodes.add(node);
    return [];
  }
  const emit = element => {
    options.nodeElementMap?.set(node, element);
    if (element.elType === "widget" && !element.settings._element_width) {
      Object.assign(element.settings, widgetWidthSettings(node, node.parentElement, element.widgetType));
    }
    applyAbsolutePosition(element, node, style, win);
    return [element];
  };
  if (options.nativeStrategy === "framework") {
    const children = [];
    [...node.childNodes].forEach(child => children.push(...convertNode(child, win, options, depth + 1)));
    if (!FRAMEWORK_CONTAINER_TAGS.has(node.tagName)) return children;
    options.convertedNodes.add(node);
    const result = container(node, style, children, options);
    Object.assign(result.settings, elementWidthSettings(node, node.parentElement));
    return emit(result);
  }
  // 谷歌地图：清洗阶段会删掉非视频 iframe，所以在那里先换成带地址的标记节点，这里再转成地图小组件。
  // ⚠ 必须排在结构识别之前：标记节点是个空 div，排后面会先被当成「留白」转成间距。
  if (node.hasAttribute && node.hasAttribute("data-hte-gmap-address")) {
    options.convertedNodes.add(node);
    const h = Math.round(parseFloat(node.getAttribute("data-hte-gmap-height")) || 300);
    return emit(widget("google_maps", {
      address: node.getAttribute("data-hte-gmap-address"),
      zoom: { unit: "px", size: Math.min(20, Math.max(1, Number(node.getAttribute("data-hte-gmap-zoom")) || 14)), sizes: [] },
      height: { unit: "px", size: h, sizes: [] },
    }));
  }
  if (options.nativeStrategy === "full" && !options.mappingByNode?.get(node)) {
    // 结构识别优先于类名识别：类名在 Tailwind 页面上没有语义。用户在网站上手动指定过映射的节点不碰。
    const structural = structuralTarget(node, win);
    if (structural) {
      const official = convertForcedNode(structural, node, style, win, options, emit, depth);
      if (official !== null) return official;
    }
  }
  if (options.nativeStrategy === "full") {
    const suggested = mappingSuggestion(node);
    if (SAFE_AUTOMATIC_COMPONENTS.has(suggested.target) && canAutomaticallyConvertComponent(suggested.target, node, options)) {
      const official = convertForcedNode(suggested.target, node, style, win, options, emit, depth);
      if (official !== null) return official;
    }
  }
  const forced = convertForcedNode(options.mappingByNode?.get(node), node, style, win, options, emit, depth);
  if (forced !== null) return forced;
  const tag = String(node.tagName || "").toUpperCase();
  if (/^H[1-6]$/.test(tag)) {
    options.convertedNodes.add(node);
    return emit(buildHeading(node, style, options));
  }
  // ⚠ 带底色 / 边框外框、里面的图标又对不上图标库（Bootstrap Icons 这类自定义 SVG）：别把外框整块变成 HTML 小组件 ——
  //   外框的底色、尺寸在本块 CSS 里会被当成「已写进设置」剥掉，HTML 小组件又没有设置承接，蓝色徽章就只剩个小黑图标
  //   （真实渲染比对：Bootstrap features 页）。改走下面的容器分支：外框进容器设置，SVG 单独成小组件。
  const framedCustomIcon = isIconNode(node) && options.iconMode !== "preserve" && !/^(SVG|I)$/.test(tag)
    && hasVisualFrame(style) && !(options.iconMode === "elementor" && iconDefinition(node));
  if (isIconNode(node) && !framedCustomIcon) {
    if (options.iconMode !== "preserve") options.convertedNodes.add(node);
    return emit(convertIcon(node, style, options));
  }
  if (tag === "IMG") {
    options.convertedNodes.add(node);
    return emit(buildImage(node, style, options, { linkAndBorder: true }));
  }
  if (
    tag === "BUTTON" ||
    (tag === "A" && (node.classList.contains("button") || node.classList.contains("btn") || style.display === "inline-block")) ||
    looksLikeButton(node, style)
  ) {
    options.convertedNodes.add(node);
    return emit(buildButton(node, style, options));
  }
  // <a> 分三类，不能一律当内联文本。
  //
  // ⚠ 原来这里写的是 `tag === "A" && !node.querySelector("img")`，守卫的用意是
  //   「带图片的链接放过去，让后面的卡片逻辑接手」—— 但下面 INLINE_TEXT_TAGS 里
  //   同样含 "A" 且没有任何守卫，于是又把它无条件抓了回来，做的正是守卫想避免的事。
  //   后果：整张卡（img + h3 + p）被塞进一个 `<p>` 里变成文本编辑器。
  //   而 `<p>` 内嵌 `<div>/<h3>` 是非法 HTML，浏览器解析时会自动断开 `<p>`，
  //   所以导入 Elementor 后看到的是一串带链接样式的裸文字，结构全丢。
  //   守卫写了、但下游没配套 —— 这类「拦了个寂寞」只有跑真实产物才看得见。
  if (tag === "A") {
    const imgs = node.querySelectorAll("img");
    // ① 纯图片链接：交给 IMG 分支，buildImage 里的 linkValue 会用 closest("a") 取回链接。
    if (imgs.length === 1 && cleanText(node.textContent) === "") {
      const kids = [];
      [...node.childNodes].forEach(child => kids.push(...convertNode(child, win, options, depth + 1)));
      if (kids.length) {
        options.convertedNodes.add(node);
        return kids;
      }
    }
    // ② 结构性链接（内含块级元素）：继续往下走卡片识别 / 容器兜底，不在这里拦截。
    // 图片 + 文字的链接（「图标 + 标签」式导航项）也不是内联文字：塞进文本编辑器就是 <p><a><img><span>…
    // 真实站点体检：腾讯工具页左侧导航 11 项全部这样塞进文本框。走结构分支 → 链接容器 + 图片 + 文字。
    // 自己是 flex/grid、里面有一块没文字的色块（logo 前面的渐变方块）：也是结构。塞进文本框后色块成了行内 span，
    //   宽高失效直接消失（2026-10-15 Northwind 测试页的 logo）。
    const structural = imgs.length > 0 || [...node.children].some(child =>
      CONTAINER_TAGS.has(child.tagName)
      || /^H[1-6]$/.test(child.tagName)
      || ["P", "UL", "OL", "TABLE", "DL", "BLOCKQUOTE", "PRE", "FIGURE"].includes(child.tagName))
      || (/flex|grid/.test(style.display) && [...node.children].some(child => !cleanText(child.textContent) && hasVisualFrame(win.getComputedStyle(child))));
    // ③ 纯内联文字链接：仍然是文本编辑器，这是对的。
    if (!structural) {
      options.convertedNodes.add(node);
      return emit(buildTextEditor(node, style, options, `<p>${outerHtmlWithoutRootStyle(node)}</p>`));
    }
  }
  if (tag === "HR") {
    options.convertedNodes.add(node);
    return emit(buildDivider(node, style, options));
  }
  // 无文本、渲染为细横条的空 div/span → 分割线（用户手工常用「分割线」小组件表现这类横线）。
  if (looksLikeDivider(node, style)) {
    options.convertedNodes.add(node);
    return emit(buildDivider(node, style, options));
  }
  // 勾选清单最常见的写法是 <ul><li>✓ …</li></ul>。原来 UL/OL 在这里先被整块送进文本编辑器，
  // 永远走不到图标列表识别（识别器本身也只认 div 类容器）。每行都带图标的列表先交给图标列表。
  if ((tag === "UL" || tag === "OL") && options.iconMode === "elementor" && looksLikeIconList(node)) {
    options.convertedNodes.add(node);
    const list = buildIconList(node, style, win, options);
    return emit(list);
  }
  // ⚠ 拿 ul/li 做布局的列表（flex/grid 排版的导航、元信息行、头像+图标+数字那种）不能整块塞进文本编辑器：
  //   真实站点体检里 Bootstrap features 页的 <ul class="d-flex list-unstyled">（头像 + SVG 图标 + 文字）
  //   整段 HTML 进了一个文本框。这类列表走下面的容器分支，li 也当容器。纯文字链接列表照旧是文本编辑器。
  const layoutList = (tag === "UL" || tag === "OL") && isLayoutList(node, win);
  if (!layoutList && (tag === "P" || tag === "BLOCKQUOTE" || tag === "UL" || tag === "OL" || tag === "TABLE" || tag === "DL" || tag === "PRE")) {
    options.convertedNodes.add(node);
    return emit(buildTextEditor(node, style, options, blockEditorHtml(node)));
  }
  // 只装着文字（和行内标签）的 span/label/small/time/dt/dd… 也是一段文字：带自己的字号颜色转成文本编辑器。
  // ⚠ 原来这些标签不在任何分支里，落到末尾兜底 → 只把里面的文字节点空手转出去，样式全丢。
  //   价格「$29」「/mo」、进度条标签、表单说明、标签 chips 都是这么丢样式的（深度审计 D 抓出）。
  if (tag !== "A" && !INLINE_TEXT_TAGS.has(tag) && isInlineTextLeaf(node)) {
    options.convertedNodes.add(node);
    return emit(buildTextEditor(node, style, options, `<p>${outerHtmlWithoutRootStyle(node)}</p>`));
  }
  // A 已在上面按三类分流完毕；结构性链接必须继续下落到卡片识别，不能在这里被吞掉。
  if (INLINE_TEXT_TAGS.has(tag) && tag !== "A") {
    options.convertedNodes.add(node);
    return emit(buildTextEditor(node, style, options, `<p>${outerHtmlWithoutRootStyle(node)}</p>`));
  }
  // 块级 div 里只有文字和行内标签（<div class="price">$49<small>/month</small></div>）= 一段文字。
  //   原来按容器拆：文字节点一个文本框、<small> 一个文本框，纵向排成两行，中间还隔着间距（2026-10-15 Northwind 测试页）。
  if (CONTAINER_TAGS.has(tag) && isInlineContentBlock(node, style, win)) {
    options.convertedNodes.add(node);
    return emit(buildTextEditor(node, style, options, `<p>${node.innerHTML.trim()}</p>`));
  }
  if (tag === "VIDEO") {
    options.convertedNodes.add(node);
    return emit(buildVideo(node));
  }
  // YouTube/Vimeo 在真实页面上几乎都是 iframe 嵌入。原来所有 iframe 一律转原始 HTML，
  // buildVideo 只处理 <video> 标签 —— 等于视频小组件这条路实际上从来走不到。
  if (tag === "IFRAME" && /youtube(?:-nocookie)?\.com|youtu\.be|vimeo\.com/.test(node.getAttribute("src") || "")) {
    options.convertedNodes.add(node);
    return emit(buildVideo(node));
  }
  if (tag === "IFRAME" || tag === "SVG" || tag === "CANVAS" || tag === "FORM" || tag === "AUDIO") return emit(htmlWidget(node.outerHTML));

  // 图片卡（图片 + 标题 + 一段文本）→ Elementor 图片框：卡片外框样式转到图片框小组件自身，直接进父级网格/容器，不再多包一层。图片模式与图标模式无关，恒生效。
  // 图片卡：先认语义标签（h/p），再按视觉认（div 写的标题/描述）。build 时按内层节点重新取 parts。
  if (CARD_ROOT_TAGS.has(tag) && imageCardParts(node, win)) {
    return emit(buildCardWidget(node, style, win, options,
      n => imageCardParts(n, win),
      (n, s, w, o) => buildImageBox(n, s, w, o, imageCardParts(n, w))));
  }

  // 「图标 + 文本」重复行的容器 → Elementor 图标列表（icon-list）：整块换成一个可编辑的图标列表组件，
  // 每行图标匹配进图标库（清单勾号统一为 fa-check），彻底避免内联 SVG 丢样式后放大变黑。
  // 仅在「图标 = 匹配 Elementor 图标库」时介入。
  if (CONTAINER_TAGS.has(tag) && options.iconMode === "elementor" && looksLikeIconList(node)) {
    options.convertedNodes.add(node);
    const list = buildIconList(node, style, win, options);
    return emit(list);
  }

  // 卡片（图标 + 标题 + 一段文本）→ Elementor 图标框：卡片外框样式转到图标框小组件自身，直接进父级，不再多包一层容器。
  // 仅在「图标 = 匹配 Elementor 图标库」时介入；「保留原始 HTML 图标」「内嵌 SVG」都表示用户要保住原图标，不动。
  // ⚠ 图标对不上图标库（自定义 SVG）时不转图标框：图标框的图标只能来自图标库，匹配不到就是空的 ——
  //   6 张特性卡丢了 4 个图标（2026-10-15 Northwind 测试页）。走下面的容器分支，SVG 按渲染尺寸内联保留。
  if (CARD_ROOT_TAGS.has(tag) && options.iconMode === "elementor" && looksLikeIconBox(node) && iconBoxIconMatches(node)) {
    return emit(buildCardWidget(node, style, win, options, looksLikeIconBox, buildIconBox));
  }

  const childElements = [];
  [...node.childNodes].forEach(child => childElements.push(...convertNode(child, win, options, depth + 1)));
  const asLayout = layoutList || (tag === "LI" && node.parentElement && isLayoutList(node.parentElement, win));
  if (CARD_ROOT_TAGS.has(tag) || asLayout) {
    // 冗余透传 div 折叠：仅一个元素子节点、自身无任何样式作用时，压平以减少嵌套层级。
    if (tag === "DIV" && depth > 0 && childElements.length === 1 && node.children.length === 1 && isTransparentWrapper(node, style)) {
      options.convertedNodes.add(node);
      options.collapsedCount = (options.collapsedCount || 0) + 1;
      return childElements;
    }
    options.convertedNodes.add(node);
    const result = container(node, style, childElements, options);
    Object.assign(result.settings, elementWidthSettings(node, node.parentElement));
    // 整块可点的卡片：容器自己就是 <a>。
    // ⚠ 官方 container.php 里 link 控件带 condition html_tag=a —— 只写 link 不写 html_tag，
    //   控件不显示、渲染也不取值，链接会静默消失。两个键必须成对写。
    if (tag === "A") {
      const href = node.getAttribute("href");
      if (href) {
        result.settings.html_tag = "a";
        result.settings.link = linkValue(node);
      }
    }
    return emit(result);
  }
  if (!VOID_TAGS.has(tag) && childElements.length) return childElements;
  // 没内容、只有外观的小色块（logo 方块、装饰圆点）：转成空容器，尺寸 / 底色 / 圆角进设置。
  //   原来进 HTML 小组件：<span> 在小组件里是行内元素，宽高失效，色块直接消失。
  //   只管非块级标签（span、i…）：空 div 在 HTML 小组件里本来就按 CSS 正常显示（遮罩层、装饰圆斑），不必改动（自审收窄）。
  if (!VOID_TAGS.has(tag) && !CONTAINER_TAGS.has(tag) && !node.children.length && !cleanText(node.textContent) && hasVisualFrame(style)) {
    const r = node.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      options.convertedNodes.add(node);
      const result = container(node, style, [], options);
      Object.assign(result.settings, elementWidthSettings(node, node.parentElement));
      if (!result.settings.min_height) result.settings.min_height = { unit: "px", size: Math.round(r.height), sizes: [] };
      return emit(result);
    }
  }
  return emit(htmlWidget(node.outerHTML));
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

// 块级文字进文本编辑器时的 HTML。表格自带一层横向滚动外壳：原页面通常用 .table-responsive / .scroll
// 包一层 overflow-x:auto，那层没有视觉样式会被当空包裹折叠掉，表格的 min-width 就会把手机上整页撑出横向滚动。
function blockEditorHtml(node) {
  const html = outerHtmlWithoutRootStyle(node);
  return node.tagName === "TABLE" ? `<div style="overflow-x:auto">${html}</div>` : html;
}

function outerHtmlWithoutRootStyle(node) {
  const clone = node.cloneNode(true);
  clone.removeAttribute("style");
  // 段落里的链接：转成文本编辑器后颜色由目标站主题接管。对「没写样式」的链接这是对的（浏览器默认蓝 rgb(0,0,238)），
  // 但品牌色链接会丢（深度审计 D 抓出）。颜色和所在文字块不同、又不是浏览器默认值的，内联到 <a> 上带过去。
  // 分析用的 DOMParser 文档没有 defaultView，自动跳过。
  // ⚠ 和文字块同色的链接也要内联：主题直接给 a 设颜色（Hello 是 #c36），继承传不下来 ——
  //   原来按「同色就靠继承」跳过，Bootstrap 示例页的黑色导航链接导入后全变粉红（真实渲染比对抓出）。
  //   根元素本身是 <a>（导航链接单独成一个文本框）同样处理。下划线状态一并内联，主题对 a 的下划线各不相同。
  const win = node.ownerDocument?.defaultView;
  if (win?.getComputedStyle) {
    // 根元素是行内元素（<small>9 mins</small>、<strong>、<em> 单独成一个文本框）：它的字号字重已经写进小组件排版，
    // 根元素上再吃一遍主题对标签的样式就错了 —— Hello 的 small{font-size:80%} 让 14px 变 11.2px（真实渲染比对抓出）。
    // ⚠ 按标签判断，不看 computed display：flex / grid 的子元素会被「块级化」，<small> 的 display 读出来是 block
    if (/^(A|SMALL|BIG|SPAN|STRONG|B|EM|I|U|S|SUB|SUP|CODE|KBD|SAMP|MARK|LABEL|TIME|ABBR|CITE|Q|DFN|VAR|DATA|INS|DEL)$/.test(node.tagName)) {
      clone.style.fontSize = "inherit";
      clone.style.fontWeight = "inherit";
      clone.style.fontStyle = "inherit";
      clone.style.lineHeight = "inherit";
    }
    const pairs = [...node.querySelectorAll("a")].map((a, i) => [a, clone.querySelectorAll("a")[i]]);
    if (node.tagName === "A") pairs.unshift([node, clone]);
    for (const [src, dst] of pairs) {
      if (!dst) continue;
      const cs = win.getComputedStyle(src);
      if (!cs.color || cs.color === "rgb(0, 0, 238)") continue;   // 浏览器默认蓝 = 作者没管，交给主题
      dst.style.color = cs.color;
      dst.style.textDecorationLine = cs.textDecorationLine || "none";
    }
  }
  return clone.outerHTML;
}

function sanitizeDocument(doc, options, warnings) {
  const scripts = doc.querySelectorAll("script,noscript,template");
  if (scripts.length) warning(warnings, "scripts-removed", "Scripts, noscript and template content were removed.", scripts.length);
  scripts.forEach(node => node.remove());
  const blockedEmbeds = doc.querySelectorAll("object,embed,applet");
  if (blockedEmbeds.length) warning(warnings, "unsafe-embed-removed", "object, embed and applet content was removed.", blockedEmbeds.length);
  blockedEmbeds.forEach(node => node.remove());
  doc.querySelectorAll("form").forEach(form => {
    const mappingTarget = options.elementMappings?.[form.getAttribute(INTERNAL_MAPPING_ATTRIBUTE)];
    if (
      mappingTarget === "widget:form"
      || mappingTarget === "atomic:e-form"
      || (options.mode === "native" && ["full", "framework"].includes(options.nativeStrategy))
    ) {
      form.removeAttribute("action");
      form.removeAttribute("method");
      warning(warnings, "form-action-removed", "The form was converted to a native widget; its original action and method were removed.");
      return;
    }
    warning(warnings, "form-neutralized", "The form can no longer submit; only its visible content was kept.");
    form.replaceWith(...form.childNodes);
  });
  doc.querySelectorAll("iframe").forEach(frame => {
    // 懒加载 iframe：src 是 about:blank / 空，真地址在 data-src。原来按 src 判定为「不安全 iframe」直接删，
    // 懒加载的 YouTube 整块消失（这是视频嵌入最常见的性能写法）。
    const lazySrc = frame.getAttribute("data-src") || frame.getAttribute("data-lazy-src");
    if (lazySrc && /^(|about:blank)$/i.test((frame.getAttribute("src") || "").trim())) frame.setAttribute("src", lazySrc);
    const src = frame.getAttribute("src") || "";
    let allowed = false;
    try {
      const url = new URL(src, "https://html-to-elementor.local/");
      allowed = url.protocol === "https:" && SAFE_IFRAME_HOSTS.has(url.hostname);
    } catch {
      allowed = false;
    }
    // 谷歌地图嵌入：换成带地址的标记节点，转换时生成原生地图小组件（地图由 Elementor 自己加载，不保留原 iframe）。
    // 原来被当成普通 iframe 直接删掉 —— 页面上的地图整块消失。
    const map = googleMapFromUrl(src);
    if (map) {
      const marker = doc.createElement("div");
      marker.setAttribute("data-hte-gmap-address", map.address);
      if (map.zoom) marker.setAttribute("data-hte-gmap-zoom", String(map.zoom));
      const h = parseFloat(frame.getAttribute("height")) || parseFloat(frame.style?.height) || 0;
      if (h) marker.setAttribute("data-hte-gmap-height", String(h));
      marker.style.height = (h || 300) + "px";
      frame.replaceWith(marker);
      return;
    }
    if (!allowed) {
      warning(warnings, "iframe-removed", "iframes other than YouTube and Vimeo were removed.");
      frame.remove();
      return;
    }
    frame.removeAttribute("srcdoc");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation");
    frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    frame.setAttribute("loading", "lazy");
  });
  const externalStyles = doc.querySelectorAll("link[rel~='stylesheet'],link[rel~='preload'][as='style']");
  if (externalStyles.length) warning(warnings, "external-css-removed", "External stylesheet links were removed so they cannot affect the target site or make tracking requests.", externalStyles.length);
  externalStyles.forEach(node => node.remove());
  doc.querySelectorAll("base,meta[http-equiv]").forEach(node => node.remove());
  // SVG 雪碧图：<svg><use href="#collection"/></svg>，图形在页面别处的 <symbol id="collection"> 里。
  // 单独转换时引用断了，引擎只好画一个通用菱形占位 —— Bootstrap Icons 这类站点的每个图标都会变成菱形。
  // 同一文档里能找到 symbol 就就地展开（网站粘贴整页的情况）；扩展抓取时由选择器在页面上先展开。
  doc.querySelectorAll("svg use").forEach(use => {
    const ref = (use.getAttribute("href") || use.getAttribute("xlink:href") || "").trim();
    // 外链 <use href="https://…#x">：通用的 URL 清洗放行了 https 链接（对 <a> 是对的），但 <use> 的 href 是资源加载，
    // 和「不带外部资源」的立场冲突（深度审计 B 抓出）。非同文档引用一律摘掉。
    if (!ref.startsWith("#")) { use.removeAttribute("href"); use.removeAttribute("xlink:href"); warning(warnings, "svg-use-external-removed", "External references in SVG <use> were removed."); return; }
    const symbol = doc.getElementById(ref.slice(1));
    if (!symbol) return;
    const svg = use.closest("svg");
    if (svg && !svg.getAttribute("viewBox") && symbol.getAttribute("viewBox")) svg.setAttribute("viewBox", symbol.getAttribute("viewBox"));
    use.replaceWith(...[...symbol.childNodes].map(n => n.cloneNode(true)));
  });
  doc.querySelectorAll("*").forEach(node => {
    [...node.attributes].filter(attr => attr.name.toLowerCase().startsWith("on")).forEach(attr => node.removeAttribute(attr.name));
    node.removeAttribute("srcdoc");
    URL_ATTRIBUTES.forEach(attribute => {
      if (!node.hasAttribute(attribute)) return;
      const value = node.getAttribute(attribute);
      if (!isSafeUrl(value, attribute, node)) {
        node.removeAttribute(attribute);
        warning(warnings, "unsafe-url-removed", "Unsafe URLs (javascript:, data:, blob:) were removed.");
      } else if (/^(?:https?:)?\/\//i.test(value)) {
        warning(warnings, "external-resource", "The page links to external resources; after import they may still load from third-party domains.");
      }
    });
    if (node.hasAttribute("srcset")) {
      const candidates = node.getAttribute("srcset").split(",").map(item => item.trim().split(/\s+/)[0]);
      if (candidates.some(url => !isSafeUrl(url, "src", node))) {
        node.removeAttribute("srcset");
        warning(warnings, "unsafe-srcset-removed", "srcset entries with unsafe URLs were removed.");
      }
    }
    const inlineStyle = node.getAttribute("style") || "";
    if (/(?:expression\s*\(|url\s*\(\s*['\"]?\s*javascript:|behavior\s*:|-moz-binding)/i.test(inlineStyle)) {
      node.removeAttribute("style");
      warning(warnings, "unsafe-inline-style-removed", "Inline styles with unsafe expressions were removed.");
    }
    if (node.hasAttribute("style")) {
      sanitizeStyleDeclaration(node.style, warnings);
      if (!node.style.length) node.removeAttribute("style");
    }
    if (node.getAttribute("target") === "_blank") {
      const rel = new Set((node.getAttribute("rel") || "").split(/\s+/).filter(Boolean));
      rel.add("noopener");
      rel.add("noreferrer");
      node.setAttribute("rel", [...rel].join(" "));
    }
  });
  if (!options.keepStyles) doc.querySelectorAll("style,link[rel='stylesheet']").forEach(node => node.remove());
  return doc;
}

async function optimizeDataImages(doc) {
  const images = [...doc.querySelectorAll("img[src^='data:image/']")].filter(node => {
    const src = node.getAttribute("src") || "";
    return /^data:image\/(?:png|jpe?g|webp);base64,/i.test(src) && src.length > 180000;
  });
  let originalBytes = 0;
  let optimizedBytes = 0;
  let count = 0;
  for (const node of images) {
    const src = node.getAttribute("src");
    const before = Math.round(src.length * .75);
    try {
      const image = new Image();
      image.src = src;
      await image.decode();
      const maxDimension = 2560;
      const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext("2d", { alpha: true }).drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/webp", .88));
      if (!blob || blob.size >= before) continue;
      const optimized = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      node.setAttribute("src", optimized);
      originalBytes += before;
      optimizedBytes += blob.size;
      count++;
      canvas.width = 1;
      canvas.height = 1;
    } catch {
      // Keep the original source when the browser cannot decode a format.
    }
  }
  return { count, originalBytes, optimizedBytes, savedBytes: Math.max(0, originalBytes - optimizedBytes) };
}

function documentHtml(doc) {
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function frameDocumentHtml(doc) {
  const html = documentHtml(doc);
  const policy = "default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:; frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com";
  return html.replace(/<head([^>]*)>/i, `<head$1><meta http-equiv="Content-Security-Policy" content="${policy}">`);
}

function bodyPayload(doc, keepStyles) {
  const styles = keepStyles ? [...doc.querySelectorAll("head style")].filter(node => !node.hasAttribute("data-hte-internal")).map(node => node.outerHTML).join("\n") : "";
  const links = keepStyles ? [...doc.querySelectorAll("head link[rel='stylesheet']")].map(node => node.outerHTML).join("\n") : "";
  return `${links}\n${styles}\n${doc.body.innerHTML}`.trim();
}

// 简写里带 var() 时，浏览器把它展开出的每个长写属性记成「待替换」，getPropertyValue(长写) 返回空串。
//   逐个长写拼回去就成了 `background-image:;` —— 无效声明，整条背景静默消失。AI 生成的页面几乎都用 CSS 变量
//   （真实渲染比对：渐变 CTA、logo 色块全丢，2026-10-15 Northwind 测试页）。空值时回到它所属的简写取原文，同一简写只写一次。
function shorthandCandidates(property) {
  const out = [];
  if (/^border-(top|bottom)-(left|right)-radius$/.test(property)) out.push("border-radius");
  if (/^(top|right|bottom|left)$/.test(property)) out.push("inset");
  if (/^(row|column)-gap$/.test(property)) out.push("gap");
  if (/^overflow-[xy]$/.test(property)) out.push("overflow");
  if (/^(white-space-collapse|text-wrap-mode)$/.test(property)) out.push("white-space");
  let p = property;
  while (p.includes("-")) {
    p = p.slice(0, p.lastIndexOf("-"));
    out.push(p);
  }
  return out;
}

function declarationEntries(style) {
  const entries = [];
  const done = new Set();
  for (const property of style) {
    const value = style.getPropertyValue(property);
    if (value !== "") {
      entries.push([property, value, style.getPropertyPriority(property)]);
      continue;
    }
    const shorthand = shorthandCandidates(property).find(name => style.getPropertyValue(name) !== "");
    if (!shorthand || done.has(shorthand)) continue;   // 取不回原文就不写，至少不留无效声明
    done.add(shorthand);
    entries.push([shorthand, style.getPropertyValue(shorthand), style.getPropertyPriority(shorthand)]);
  }
  return entries;
}

// 内容被 Elementor 自己的标记重画的小组件：源里它们的子节点在产物里不存在，样式已经量进设置。
//   打到这些子节点上的规则留着只会误伤 Elementor 的内部标记 —— `.stat span{font-size:15px}` 命中计数器的
//   数字 <span>，把 44px 的数字压成 15px 灰字（2026-10-15 Northwind 测试页）。
//   文本编辑器 / 标题 / HTML / 折叠面板的内容带着源 HTML，不在此列。
const ABSORBING_WIDGETS = new Set(["counter", "testimonial", "star-rating", "progress", "social-icons", "icon-box", "image-box", "image", "video", "google_maps", "image-gallery", "image-carousel"]);
const POSITION_OFFSET_PROPERTIES = new Set(["position", "top", "right", "bottom", "left", "inset", "inset-block", "inset-inline", "inset-block-start", "inset-block-end", "inset-inline-start", "inset-inline-end"]);

function filterCssText(css, options) {
  const colorProperties = new Set([
    "color", "background", "background-color", "background-image", "border-color",
    "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
    "outline-color", "text-decoration-color", "column-rule-color", "fill", "stroke",
    "caret-color", "text-shadow", "box-shadow"
  ]);
  const fontProperties = new Set([
    "font", "font-family", "font-size", "font-weight", "font-style", "font-stretch",
    "font-variant", "line-height", "letter-spacing", "text-transform", "text-decoration"
  ]);
  const TABLE_KEEP_PROPERTIES = new Set(["width", "min-width", "max-width", "table-layout"]);
  const mappedProperties = new Set([
    "display", "visibility", "width", "min-width", "max-width", "height", "min-height", "max-height",
    "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
    "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "gap", "row-gap", "column-gap", "flex", "flex-basis", "flex-direction", "flex-grow",
    "flex-shrink", "flex-wrap", "justify-content", "align-items", "align-self",
    "grid-template-columns", "grid-template-rows", "grid-column", "grid-row",
    "text-align", "z-index",
    "color", "background-color", "border-color", "border-top-color", "border-right-color",
    "border-bottom-color", "border-left-color", "outline-color", "text-decoration-color",
    "column-rule-color", "fill", "stroke", "caret-color", "text-shadow",
    "background-color",
    "border", "border-top", "border-right", "border-bottom", "border-left",
    "border-width", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
    "border-style", "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
    "border-radius", "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius",
    "font", "font-family", "font-size", "font-weight", "font-style", "font-stretch",
    "font-variant", "line-height", "letter-spacing", "text-transform", "text-decoration"
  ]);
  const convertedSet = options.convertedNodes || new Set();
  const convertedDoc = convertedSet.size ? convertedSet.values().next().value.ownerDocument : null;
  // 节点是否被「自己重画内容」的小组件吸收：往上找最近的已转换祖先，看它变成了什么。按节点缓存（规则多、命中重复）。
  const absorbedCache = new Map();
  const absorbedIntoWidget = node => {
    if (absorbedCache.has(node)) return absorbedCache.get(node);
    let result = false;
    for (let up = node.parentElement; up; up = up.parentElement) {
      if (!convertedSet.has(up)) continue;
      const element = options.nodeElementMap?.get(up);
      result = !!element && element.elType === "widget" && ABSORBING_WIDGETS.has(element.widgetType);
      break;
    }
    absorbedCache.set(node, result);
    return result;
  };
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    const serializeRules = rules => [...rules].map(rule => {
      if (rule.constructor.name === "CSSStyleRule") {
        const isStateRule = /:(?!root\b)/.test(rule.selectorText);
        // 用浏览器原生 querySelectorAll 查一次再和已转换节点取交集 —— 原来对每条规则拿上千个节点逐个 matches，
        //   Bootstrap 整页（几千条规则）这一步就要近半秒（自审插桩实测）
        let matched = [];
        if (!isStateRule && convertedDoc) {
          try {
            matched = [...convertedDoc.querySelectorAll(rule.selectorText)];
          } catch { /* 选择器浏览器不认 */ }
        }
        const matchedRoots = matched.filter(node => convertedSet.has(node));
        // 只命中「被吸收的子节点」（和已转换根）的规则：映射过的属性剥掉。还命中别的源节点（文本编辑器里的原样 HTML）就照旧保留。
        const absorbedOnly = matched.length > matchedRoots.length
          && matched.every(node => convertedSet.has(node) || absorbedIntoWidget(node));
        // 绝对定位已写进小组件的 _position / _offset_*：规则里的 position/top/left 若留着，会再作用到文本编辑器里
        //   同类名的内层元素上，把文字推出自己的底色块（定价卡「Most popular」角标，2026-10-15 Northwind 测试页）。
        const positionMapped = matchedRoots.some(node => !!options.nodeElementMap?.get(node)?.settings?._position);
        // 从 var() 简写取回的整条 `background`：只有真的画了渐变 / 图片才可能要留；只是底色的话颜色已经进了设置，
        //   留着会在小组件外层再铺一块直角色块（圆角按钮背后多出方形底色）。
        const rootsPaintImage = matchedRoots.some(node => convertedDoc.defaultView.getComputedStyle(node).backgroundImage !== "none");
        // 变成 HTML 小组件的根元素不算：它的样式没有任何设置承接，剥掉就是纯丢失
        const appliesToConvertedRoot = matchedRoots.some(node => options.nodeElementMap?.get(node)?.widgetType !== "html");
        // 表格整块进文本编辑器，宽度类属性没有任何设置项承接 —— 剥掉就是纯丢失
        // （min-width:620px 的比较表格在手机上被挤扁，不再在外壳里横向滚动；真实渲染比对抓出）
        const tableOnly = appliesToConvertedRoot && matchedRoots.every(node => node.tagName === "TABLE");
        const bgMapped = matchedRoots.some(node => {
          const st = options.nodeElementMap?.get(node)?.settings;
          return !!st && (st.background_background === "gradient" || !!st.background_image || st._background_background === "gradient" || !!st._background_image);
        });
        const declarations = declarationEntries(rule.style)
          .filter(([property]) => {
            const normalized = property.toLowerCase();
            if (options.colorMode === "site" && colorProperties.has(normalized)) return false;
            if (options.fontMode === "site" && fontProperties.has(normalized)) return false;
            if (tableOnly && TABLE_KEEP_PROPERTIES.has(normalized)) return true;
            if (positionMapped && POSITION_OFFSET_PROPERTIES.has(normalized)) return false;
            // 背景图 / 渐变：只有设置里真的接住了（两色渐变或 url 图）才剥 —— 否则 CSS 是唯一载体。
            //   剥：Bootstrap 的 .bg-gradient{background-image:…!important} 会盖掉设置里的渐变（蓝色徽章消失）；
            //   留：三色以上的渐变设置只能退成首色，完整渐变靠 CSS（剥掉后渐变 hero 变纯色，真实渲染比对抓出）。
            if (appliesToConvertedRoot && normalized === "background" && !rootsPaintImage) return false;
            if (appliesToConvertedRoot && /^background(-image)?$/.test(normalized)) return !bgMapped;
            if (appliesToConvertedRoot || absorbedOnly) return !mappedProperties.has(normalized);
            return true;
          })
          .map(([property, value, priority]) => `${property}:${value}${priority ? " !important" : ""};`)
          .join("");
        return declarations ? `${rule.selectorText}{${declarations}}` : "";
      }
      if (rule.constructor.name === "CSSMediaRule") return `@media ${rule.conditionText}{${serializeRules(rule.cssRules)}}`;
      if (rule.constructor.name === "CSSSupportsRule") return `@supports ${rule.conditionText}{${serializeRules(rule.cssRules)}}`;
      return rule.cssText;
    }).join("");
    return serializeRules(sheet.cssRules);
  } catch {
    warning(options.warnings || [], "css-filter-failed", "Some CSS could not be parsed safely in native mode and was removed.");
    return "";
  }
}

function filterInlineStyles(doc, options) {
  const colorProperties = [
    "color", "background-color", "border-color", "border-top-color", "border-right-color",
    "border-bottom-color", "border-left-color", "outline-color", "text-decoration-color",
    "column-rule-color", "fill", "stroke", "caret-color", "text-shadow", "box-shadow"
  ];
  const fontProperties = [
    "font", "font-family", "font-size", "font-weight", "font-style", "font-stretch",
    "font-variant", "line-height", "letter-spacing", "text-transform", "text-decoration"
  ];
  doc.querySelectorAll("[style]").forEach(node => {
    if (options.colorMode === "site") {
      colorProperties.forEach(property => node.style.removeProperty(property));
      if (!/url\(/i.test(node.style.getPropertyValue("background"))) node.style.removeProperty("background");
      if (/gradient\(/i.test(node.style.getPropertyValue("background-image"))) node.style.removeProperty("background-image");
    }
    if (options.fontMode === "site") fontProperties.forEach(property => node.style.removeProperty(property));
    if (!node.getAttribute("style")?.trim()) node.removeAttribute("style");
  });
}

function sameSetting(first, second) {
  return JSON.stringify(first ?? null) === JSON.stringify(second ?? null);
}

// ⚠ 断点值要和「它实际会继承的值」比：Elementor 里手机继承平板、平板继承桌面（从大到小逐级）。
//   原来只和桌面比 —— 桌面 378、平板 450、手机等于桌面 378 就不写，手机于是继承平板的 450（真实渲染比对：album 卡片）。
const BREAKPOINT_ORDER = ["laptop", "tablet_extra", "tablet", "mobile_extra", "mobile"];
function responsiveSetting(settings, key, suffix, value) {
  if (value == null || value === "") return;
  let inherited = settings[key];
  for (const larger of BREAKPOINT_ORDER.slice(0, BREAKPOINT_ORDER.indexOf(suffix))) {
    if (settings[`${key}_${larger}`] !== undefined) inherited = settings[`${key}_${larger}`];
  }
  // 和桌面值、继承值都相同才跳过：有些控件带设备专属默认值（grid 列数 mobile_default=1、图标框位置等），
  //   并不继承上一档 —— 只和继承值比会漏写（真实渲染比对：数据带手机端 2 列变 1 列）
  if (sameSetting(inherited, value) && sameSetting(settings[key], value)) return;
  settings[`${key}_${suffix}`] = value;
}

async function applyResponsiveSettings(frame, options) {
  // Slugs verified against core/breakpoints/manager.php; widescreen is min-width based and intentionally omitted.
  // ⚠ 采样宽度取各断点区间里有代表性的真实设备宽度，不是区间上限（767 / 1024）：
  //   手写 CSS 常用 760 / 720 / 640 / 560 这类断点，在 767 下全都不生效 → 手机端字号、内边距、换列整批丢失
  //   （真实 Elementor 渲染比对抓出）。手机 390 = 主流手机宽度；平板 820 = iPad 竖屏。
  const breakpoints = options.responsiveBreakpoints === "extended"
    ? [
        { suffix: "laptop", width: 1280 },
        { suffix: "tablet_extra", width: 1100 },
        { suffix: "tablet", width: 960 },
        { suffix: "mobile_extra", width: 820 },
        { suffix: "mobile", width: 390 }
      ]
    : [
        { suffix: "tablet", width: 820 },
        { suffix: "mobile", width: 390 }
      ];
  const originalWidth = frame.style.width;
  for (const breakpoint of breakpoints) {
    frame.style.width = `${breakpoint.width}px`;
    await new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 80);
    });
    options.nodeElementMap.forEach((element, node) => {
      if (!node.isConnected) return;
      const componentType = element.widgetType || element.elType;
      if (COMPONENT_REGISTRY.has(`atomic:${componentType}`)) return;
      const style = frame.contentWindow.getComputedStyle(node);
      const settings = element.settings;
      const isContainer = element.elType === "container";
      // ⚠ 祖先 display:none 时，子元素自己的 computed display 照样是 block —— 只看自身会漏掉
      //   「手机端整栏隐藏」里的所有子元素（深度审计 E 抓出）。getClientRects 为空才是真的没渲染。
      const isHidden = style.display === "none" || style.visibility === "hidden"
        || (typeof node.getClientRects === "function" && node.getClientRects().length === 0 && style.position !== "fixed");
      if (isHidden) settings[`hide_${breakpoint.suffix}`] = `hidden-${breakpoint.suffix}`;
      else delete settings[`hide_${breakpoint.suffix}`];
      const marginKey = isContainer ? "margin" : "_margin";
      const paddingKey = isContainer ? "padding" : element.widgetType === "button" ? "text_padding" : "_padding";
      const bpMargin = applyCollapsedTop(dimensions(style, "margin", true), node, style);
      // 断点同样清零 margin:0 auto 居中块的左右外边距（computed 会解析成视口相关像素，如 tablet 的 65.25px），交给 boxed 居中。
      if (bpMargin && isAutoCentered(node, style)) { bpMargin.left = "0"; bpMargin.right = "0"; bpMargin.isLinked = false; }
      responsiveSetting(settings, marginKey, breakpoint.suffix, bpMargin);
      responsiveSetting(settings, paddingKey, breakpoint.suffix, dimensions(style, "padding", true));
      if (isContainer && settings.container_type === "grid") {
        const rowGap = parseFloat(style.rowGap) || 0;
        const columnGap = parseFloat(style.columnGap) || 0;
        // grid 列数每档都显式写：控件自带 mobile_default = 1 列（grid-container.php:59），
        //   不写的话「手机上仍是 2 列」的网格在 Elementor 里会变成 1 列
        const bpColumns = gridColumnsFor(node, style);
        if (bpColumns) settings[`grid_columns_grid_${breakpoint.suffix}`] = bpColumns;
        // 断点上 gap 变成 0 也要写，否则继承桌面值
        responsiveSetting(settings, "grid_gaps", breakpoint.suffix, {
          unit: "px",
          column: String(columnGap),
          row: String(rowGap),
          isLinked: rowGap === columnGap
        });
        responsiveSetting(settings, "min_height", breakpoint.suffix, containerMinHeight(node, style));
        responsiveContainerWidths(settings, node, style, breakpoint.suffix);
      } else if (isContainer) {
        const direction = style.display.includes("flex") ? style.flexDirection : "column";
        responsiveSetting(settings, "flex_direction", breakpoint.suffix, direction);
        responsiveSetting(settings, "flex_wrap", breakpoint.suffix, style.flexWrap === "nowrap" ? "" : "wrap");
        const justifyMap = { start: "flex-start", "flex-start": "flex-start", center: "center", end: "flex-end", "flex-end": "flex-end", "space-between": "space-between", "space-around": "space-around", "space-evenly": "space-evenly" };
        const alignMap = { start: "flex-start", "flex-start": "flex-start", center: "center", end: "flex-end", "flex-end": "flex-end", stretch: "stretch" };
        // ⚠ 断点上变成 display:block 时，computed 里的 align-items / justify-content / gap 还是桌面 flex 的值，
        //   但对 block 布局不起作用。照抄会让 Elementor 在手机上把按钮居中、再多出一截 gap（CTA 条渲染比对抓出）。
        //   block 的等价写法：从顶部排、横向铺满、没有 gap。
        const isFlex = style.display.includes("flex");
        //   （桌面没写过对齐值的容器，窄屏也不写，免得每个 block 容器都多出一堆等于默认值的键）
        responsiveSetting(settings, "flex_justify_content", breakpoint.suffix, isFlex ? justifyMap[style.justifyContent] : (settings.flex_justify_content ? "flex-start" : undefined));
        responsiveSetting(settings, "flex_align_items", breakpoint.suffix, isFlex ? alignMap[style.alignItems] : (settings.flex_align_items ? "stretch" : undefined));
        const rowGap = isFlex ? parseFloat(style.rowGap) || 0 : 0;
        const columnGap = isFlex ? parseFloat(style.columnGap) || 0 : 0;
        responsiveSetting(settings, "flex_gap", breakpoint.suffix, {
          unit: "px",
          size: columnGap || rowGap,
          column: String(columnGap),
          row: String(rowGap),
          isLinked: rowGap === columnGap
        });
        responsiveSetting(settings, "min_height", breakpoint.suffix, containerMinHeight(node, style));
        responsiveContainerWidths(settings, node, style, breakpoint.suffix);
      } else {
        // 复合小组件内部的排版（Counter 的数字 / 标题，图标框、图片框的标题 / 描述）同样要按断点重读：
        //   原来只有标题 / 文本 / 按钮有响应式字号，数据带的数字在手机上还是桌面的 44px（真实渲染比对抓出）
        if (options.fontMode !== "site") {
          const inner = [];
          if (element.widgetType === "counter") {
            const parts = counterParts(node, frame.contentWindow);
            if (parts) inner.push(["typography_number", parts.numberEl], ["typography_title", parts.labelEl]);
          } else if (element.widgetType === "icon-box" || element.widgetType === "image-box") {
            inner.push(["title_typography", node.querySelector("h1,h2,h3,h4,h5,h6")], ["description_typography", node.querySelector("p")]);
          }
          for (const [prefix, el] of inner) {
            if (!el) continue;
            const cs = frame.contentWindow.getComputedStyle(el);
            responsiveSetting(settings, `${prefix}_font_size`, breakpoint.suffix, unit(cs.fontSize));
            responsiveSetting(settings, `${prefix}_line_height`, breakpoint.suffix, unit(cs.lineHeight));
            responsiveSetting(settings, `${prefix}_letter_spacing`, breakpoint.suffix, unit(cs.letterSpacing));
          }
        }
        // 桌面限宽的小组件：每个断点重算，窄屏下铺满了就改回满宽（像素宽在手机上会顶出屏幕）
        if (element.elType === "widget" && settings._element_width === "initial" && settings._position !== "absolute") {
          const w = widgetWidthSettings(node, node.parentElement, element.widgetType);
          settings[`_element_width_${breakpoint.suffix}`] = w._element_width ? "initial" : "inherit";
          if (w._element_width) {
            responsiveSetting(settings, "_element_custom_width", breakpoint.suffix, w._element_custom_width);
            responsiveSetting(settings, "_flex_align_self", breakpoint.suffix, w._flex_align_self);
          }
        }
        if (["heading", "text-editor", "button"].includes(element.widgetType) && options.fontMode !== "site") {
          responsiveSetting(settings, "typography_font_size", breakpoint.suffix, unit(style.fontSize));
          responsiveSetting(settings, "typography_line_height", breakpoint.suffix, unit(style.lineHeight));
          responsiveSetting(settings, "typography_letter_spacing", breakpoint.suffix, unit(style.letterSpacing));
        }
        if (["heading", "button", "image", "icon"].includes(element.widgetType)) {
          const alignment = element.widgetType === "image"
            ? resolveAlign(node, style) // computed 已解析 margin:auto 成像素，用 resolveAlign 判居中
            : element.widgetType === "button" ? buttonAlign(node, style)
            : normalizeAlign(style.textAlign, style.direction);
          responsiveSetting(settings, "align", breakpoint.suffix, alignment);
        }
        if (element.widgetType === "image") {
          // 按断点用「占父百分比」表达图宽（视口无关），满宽不写；拿不到父尺寸才回退像素。
          const nr = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
          const pr = node.parentElement && node.parentElement.getBoundingClientRect ? node.parentElement.getBoundingClientRect() : null;
          let imgWidth = null;
          const areaW = node.parentElement ? gridAreaWidth(node, node.parentElement) : 0;   // 同 buildImage：grid 里按单元格算
          if (nr && pr && pr.width > 0) {
            const pct = nr.width / (areaW || pr.width) * 100;
            if (pct < 97) imgWidth = { unit: "%", size: Math.round(pct * 100) / 100, sizes: [] };
          } else {
            imgWidth = unit(style.width);
          }
          responsiveSetting(settings, "width", breakpoint.suffix, imgWidth);
        }
      }
    });
  }
  frame.style.width = originalWidth || "1440px";
}

function rootContainer(elements) {
  return {
    id: id(),
    elType: "container",
    settings: {
      content_width: "full",
      flex_direction: "column",
      flex_gap: { unit: "px", size: 0, column: "0", row: "0", isLinked: true },
      padding: { unit: "px", top: "0", right: "0", bottom: "0", left: "0", isLinked: true }
    },
    elements,
    isInner: false
  };
}

function sourceRestUrl(conversionId) {
  return `https://html-to-elementor.local/${conversionId}/wp-json/`;
}

function countTree(elements) {
  const stats = { elements: 0, widgets: 0, containers: 0, maxDepth: 0 };
  const visit = (list, depth) => list.forEach(element => {
    stats.elements++;
    if (depth > stats.maxDepth) stats.maxDepth = depth;
    if (element.elType === "container") stats.containers++;
    if (element.elType === "widget") stats.widgets++;
    visit(element.elements || [], depth + 1);
  });
  visit(elements, 1);
  return stats;
}

export async function convertHtml(source, options, frame) {
  const report = typeof options.onProgress === "function" ? options.onProgress : () => {};
  report(0.04, "Parsing HTML…");
  options.headingState = { seen: false, levelMap: new Map() };
  options.convertedNodes = new Set();
  options.nodeElementMap = new Map();
  const warnings = [];
  options.warnings = warnings;
  const conversionId = `hte-${id()}`;
  const parser = new DOMParser();
  const sourceDocument = parser.parseFromString(source, "text/html");
  if (options.mode === "native" && options.nativeStrategy === "advanced") markMappingNodes(sourceDocument);
  const parsed = sanitizeDocument(sourceDocument, options, warnings);
  const errors = parsed.querySelector("parsererror");
  if (errors) throw new Error("HTML 无法解析，请检查源码是否完整。");
  const idMap = namespaceDocumentIds(parsed, conversionId);
  const wrapper = parsed.createElement("div");
  wrapper.id = conversionId;
  wrapper.className = "hte-converted-root";
  while (parsed.body.firstChild) wrapper.appendChild(parsed.body.firstChild);
  wrapper.style.position = "relative";
  wrapper.style.isolation = "isolate";
  parsed.body.appendChild(wrapper);
  if (options.keepStyles) {
    parsed.querySelectorAll("style").forEach(style => {
      style.textContent = scopeCssText(style.textContent, `#${conversionId}`, idMap, warnings);
      if (!style.textContent.trim()) style.remove();
    });
    const containmentStyle = parsed.createElement("style");
    containmentStyle.textContent = `#${conversionId}{position:relative;isolation:isolate;}`;
    containmentStyle.setAttribute("data-hte-internal", "1"); // 内部隔离样式，不得进入输出的 CSS 小部件
    parsed.head.appendChild(containmentStyle);
  }
  report(0.12, "Cleaning and scoping…");
  const preservesDataImages = options.mode === "fidelity"
    || (options.mode === "native" && options.imageMode !== "placeholder" && (options.assetUrlMode || "safe") === "preserve");
  if (options.optimizeImages && preservesDataImages) report(0.18, "Optimizing embedded images…");
  const imageOptimization = options.optimizeImages && preservesDataImages
    ? await optimizeDataImages(parsed)
    : { count: 0, originalBytes: 0, optimizedBytes: 0, savedBytes: 0 };
  if (options.mode === "native" && (options.colorMode === "site" || options.fontMode === "site")) {
    filterInlineStyles(parsed, options);
  }
  const safeHtml = frameDocumentHtml(parsed);
  const previewHtml = safeHtml.replace(/\sdata-hte-map-id="n\d+"/g, "");
  let elements;

  if (options.mode === "fidelity") {
    report(0.85, "Building Elementor data…");
    elements = [rootContainer([htmlWidget(bodyPayload(parsed, options.keepStyles))])];
  } else {
    if (options.nativeStrategy === "framework") {
      warning(warnings, "framework-only", "Layout-only mode left out headings, text, images and buttons; only the editable container layout was kept.");
    }
    report(0.22, "Loading the preview layout…");
    frame.style.width = "1440px";
    await loadFrame(frame, safeHtml);
    const liveDoc = frame.contentDocument;
    options.mappingByNode = new WeakMap();
    liveDoc.querySelectorAll(`[${INTERNAL_MAPPING_ATTRIBUTE}]`).forEach(node => {
      const mappingId = node.getAttribute(INTERNAL_MAPPING_ATTRIBUTE);
      const target = options.elementMappings?.[mappingId];
      if (target) options.mappingByNode.set(node, target);
      node.removeAttribute(INTERNAL_MAPPING_ATTRIBUTE);
    });
    const bodyNodes = [...liveDoc.body.childNodes].filter(node => !(node.nodeType === Node.TEXT_NODE && !cleanText(node.textContent)));
    const converted = [];
    // Chunk the top-level pass so a large page yields to the event loop and the progress bar paints.
    for (let index = 0; index < bodyNodes.length; index++) {
      converted.push(...convertNode(bodyNodes[index], frame.contentWindow, options));
      if ((index & 7) === 7) {
        report(0.3 + 0.4 * (index + 1) / bodyNodes.length, "转换组件…");
        await new Promise(resolve => setTimeout(resolve));
      }
    }
    report(0.74, "Measuring responsive layouts…");
    await applyResponsiveSettings(frame, options);
    const css = options.keepStyles && options.nativeStrategy !== "framework"
      ? [...liveDoc.querySelectorAll("style")]
        .filter(node => !node.hasAttribute("data-hte-internal")) // 排除内部注入的隔离样式
        .map(node => filterCssText(node.textContent, options))
        .filter(Boolean)
        .map(value => `<style>${value}</style>`)
        .join("\n")
      : "";
    // 图标框 / 图片框的标题由 Elementor 渲染成 <h3> 等，主题的全局重置会给它加上边距（Hello：margin-block-start:.5rem），
    // 而这两个小组件只有「标题下间距」控件、没有上边距控件 → 只能在本块 CSS 里同作用域归零（真实渲染比对抓出多 8px）。
    const boxTitleReset = css && treeHasWidget(converted, ["icon-box", "image-box"])
      ? `\n<style>#${conversionId} .elementor-icon-box-title,#${conversionId} .elementor-image-box-title{margin-block-start:0;}</style>`
      : "";
    // 只有底线的 FAQ（accordionStyle 打的标记类）：经典手风琴每项是整圈边框 + 内容区上边线，改成每项只留底线。
    //   宽度和颜色仍由 border_width / border_color 控件给，这里只把其余三边归零。
    const accordionLines = css && treeHasCssClass(converted, ACCORDION_LINES_CLASS)
      ? `\n<style>#${conversionId} .${ACCORDION_LINES_CLASS} .elementor-accordion-item{border-top-width:0;border-left-width:0;border-right-width:0;}`
        + `#${conversionId} .${ACCORDION_LINES_CLASS} .elementor-tab-content,#${conversionId} .${ACCORDION_LINES_CLASS} .elementor-tab-title.elementor-active{border-width:0;}</style>`
      : "";
    // 本块 CSS 放进转换根容器（带作用域 id 的那个）里当第一个子元素，而不是和它并列 ——
    // 并列时外面还得再包一层 rootContainer，每个区块在导航器里凭空多一层容器。
    // ⚠ 例外：源 CSS 里有位置类选择器（:first-child / :nth-child …）命中根容器的直接子元素时，样式小组件插在
    //   第一个位置会让这些规则失效 —— 那就退回原来的结构（样式小组件放在根容器外面，多一层容器）。
    if (css) {
      const styleWidget = htmlWidget(css + boxTitleReset + accordionLines);
      const rootNode = liveDoc.getElementById(conversionId);
      if (converted.length === 1 && converted[0].elType === "container" && !positionalRulesHitChildren(liveDoc, rootNode)) converted[0].elements.unshift(styleWidget);
      else converted.unshift(styleWidget);
    }
    elements = converted.length === 1 && converted[0].elType === "container" ? converted : [rootContainer(converted)];
  }

  report(0.96, "Packaging the template…");
  const clipboard = { type: "elementor", siteurl: sourceRestUrl(conversionId), elements };
  const template = { content: elements, page_settings: [], version: "0.4", title: options.title || "HTML Converted Page", type: "page" };
  const stats = countTree(elements);
  stats.collapsed = options.collapsedCount || 0;
  const json = JSON.stringify(template);
  stats.bytes = new Blob([json]).size;
  // 结构映射视图用：给每个「有源 DOM 节点」的元素打一个共享 uid，同时写到源节点上，
  // 让联动视图能按 uid 在预览 iframe ↔ 结构树之间互查。纯前端，uid 不进导出 JSON。
  const elementUid = new Map();
  let structureHtml = previewHtml;
  if (options.nodeElementMap && options.nodeElementMap.size) {
    let uid = 0;
    const liveDoc = frame?.contentDocument;
    options.nodeElementMap.forEach((element, node) => {
      const key = String(uid++);
      elementUid.set(element, key);
      if (node && node.setAttribute) node.setAttribute("data-hte-uid", key);
    });
    if (liveDoc?.documentElement) structureHtml = liveDoc.documentElement.outerHTML;
  }
  report(1, "Done");
  return { clipboard, template, stats, safeHtml: previewHtml, structureHtml, elementUid, imageOptimization, warnings, conversionId };
}

function loadFrame(frame, html) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("预览文档加载超时。")), 15000);
    frame.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    frame.srcdoc = html;
  });
}

export function flattenTree(elements, depth = 0, output = []) {
  elements.forEach(element => {
    const label = element.elType === "widget"
      ? element.widgetType
      : element.settings?._element_id || element.settings?.css_classes?.split(/\s+/)[0] || element.settings?._css_classes?.split(/\s+/)[0] || "container";
    output.push({ depth, type: element.elType, label, id: element.id });
    flattenTree(element.elements || [], depth + 1, output);
  });
  return output;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
