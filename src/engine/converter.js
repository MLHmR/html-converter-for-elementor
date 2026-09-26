// 带版本号动态加载，URL 与 app.js 一致（?v=HTE_VERSION）→ 复用同一模块实例且随发版刷新缓存。
const { ELEMENTOR_COMPONENTS } = await import(`./elementor-components.js${(typeof window !== "undefined" && window.HTE_BOOT && HTE_BOOT.ver) ? `?v=${encodeURIComponent(HTE_BOOT.ver)}` : ""}`);

const VOID_TAGS = new Set(["AREA", "BASE", "BR", "COL", "EMBED", "HR", "IMG", "INPUT", "LINK", "META", "PARAM", "SOURCE", "TRACK", "WBR"]);
const CONTAINER_TAGS = new Set(["BODY", "MAIN", "SECTION", "ARTICLE", "HEADER", "FOOTER", "NAV", "ASIDE", "DIV", "FIGURE", "FIGCAPTION"]);
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
      warning(warnings, "data-media-preserved", "图片包含 Base64 data URL；Elementor 模板导入时可能无法写入媒体库。");
      return source;
    }
    warning(warnings, "data-media-placeholder", "Base64 data 图片已转为空占位，避免 Elementor 导入媒体库失败。");
    return "";
  }
  if (/^\/\//.test(source)) {
    warning(warnings, "protocol-relative-media-normalized", "协议相对图片地址已规范为 https 绝对地址，便于 Elementor 导入媒体库。");
    return `https:${source}`;
  }
  if (/^https?:\/\//i.test(source)) return source;
  if (isRelativeUrl(source)) {
    const base = normalizedAssetBaseUrl(options.assetBaseUrl);
    if (assetUrlMode === "resolve" && base) {
      try {
        const resolved = new URL(source, base).href;
        warning(warnings, "relative-media-resolved", "相对图片地址已使用原站点资源 Base URL 补全为绝对地址。");
        return resolved;
      } catch {
        warning(warnings, "relative-media-resolve-failed", "相对图片地址无法补全，已转为空占位。");
        return "";
      }
    }
    if (assetUrlMode === "preserve") {
      warning(warnings, "relative-media-preserved", "图片包含相对地址；导入目标站点后可能指向错误路径或无法导入媒体库。");
      return source;
    }
    warning(warnings, "relative-media-placeholder", "相对图片地址已转为空占位，避免导入后指向目标站点错误路径。");
    return "";
  }
  warning(warnings, "unsupported-media-url-placeholder", "不支持的图片地址已转为空占位。");
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
    if (urls.some(url => !cssUrlIsSelfContained(url))) {
      style.removeProperty(property);
      warning(warnings, "css-external-url-removed", "已移除 CSS 中的外部或相对 URL 资源，避免追踪请求和失效资源。");
    }
  });
  if (style.getPropertyValue("position").trim().toLowerCase() === "fixed") {
    const priority = style.getPropertyPriority("position");
    style.setProperty("position", "absolute", priority);
    warning(warnings, "fixed-position-contained", "已把 position:fixed 限制为 absolute，避免导入内容覆盖目标站点整个视口。");
  }
  const zIndex = Number(style.getPropertyValue("z-index"));
  if (Number.isFinite(zIndex) && zIndex > 1000) {
    style.setProperty("z-index", "1000", style.getPropertyPriority("z-index"));
    warning(warnings, "z-index-limited", "已限制过高的 z-index，降低覆盖目标站点编辑界面的风险。");
  }
}

function scopeCssText(css, scopeSelector, idMap, warnings) {
  try {
    const imports = css.match(/@import\s+(?:url\([^;]+\)|["'][^"']+["'])[^;]*;/gi) || [];
    if (imports.length) warning(warnings, "css-import-removed", "已移除 CSS @import 外部样式。", imports.length);
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
        warning(warnings, "css-import-removed", "已移除 CSS @import 外部样式。");
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
        warning(warnings, "font-face-removed", "已移除 @font-face 外部字体资源；可在目标站点字体设置中重新配置。");
        return "";
      }
      if (rule.cssRules) return serializeRules(rule.cssRules);
      return "";
    }).join("");
    return serializeRules(sheet.cssRules);
  } catch {
    warning(warnings, "css-parse-failed", "部分 CSS 无法安全解析，已移除而不是原样注入。");
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

function commonSettings(node, style) {
  const settings = {};
  if (node.id) settings._element_id = node.id;
  if (node.className && typeof node.className === "string") settings._css_classes = node.className.trim();
  const margin = dimensions(style, "margin", true);
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
  if (style.fontFamily) settings[`${prefix}_font_family`] = style.fontFamily.replaceAll('"', "");
  const size = unit(style.fontSize);
  if (size) settings[`${prefix}_font_size`] = size;
  if (style.fontWeight && style.fontWeight !== "400") settings[`${prefix}_font_weight`] = style.fontWeight;
  if (style.textTransform && style.textTransform !== "none") settings[`${prefix}_text_transform`] = style.textTransform;
  if (style.fontStyle && style.fontStyle !== "normal") settings[`${prefix}_font_style`] = style.fontStyle;
  if (style.textDecorationLine && style.textDecorationLine !== "none") settings[`${prefix}_text_decoration`] = style.textDecorationLine;
  const lineHeight = unit(style.lineHeight);
  if (lineHeight) settings[`${prefix}_line_height`] = lineHeight;
  const spacing = unit(style.letterSpacing);
  if (spacing) settings[`${prefix}_letter_spacing`] = spacing;
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
        warning( options.warnings || [], "data-background-placeholder", "Base64 背景图已移除，避免 Elementor 导入失败；请在编辑器里重新设置背景图。" );
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
        settings.background_background = "gradient";
        settings.background_gradient_type = "linear";
        settings.background_color = gradient.first.color;
        settings.background_color_b = gradient.second.color;
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
  if (style.borderTopStyle && style.borderTopStyle !== "none") {
    settings.border_border = style.borderTopStyle;
    if (options.colorMode !== "site") settings.border_color = style.borderTopColor;
    settings.border_width = dimensions(style, "border");
  }
  const radius = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map(value => parseFloat(value) || 0);
  if (radius.some(Boolean)) settings.border_radius = { unit: "px", top: String(radius[0]), right: String(radius[1]), bottom: String(radius[2]), left: String(radius[3]), isLinked: radius.every(value => value === radius[0]) };
  if (options.colorMode !== "site") {
    const shadow = parseBoxShadow(style.boxShadow);
    if (shadow) {
      if (splitCssSelectors(style.boxShadow).length > 1) {
        warning(options.warnings || [], "box-shadow-multi", "元素包含多重阴影，仅保留最前一层，其余需在 Elementor 中手动补充。");
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

function isIconNode(node) {
  const tag = String(node.tagName || "").toUpperCase();
  if (tag === "SVG" || tag === "I") return true;
  if (node.className && /\b(?:icon|eicon|fa[srb]?)\b/i.test(String(node.className))) return true;
  const text = cleanText(node.textContent);
  return tag === "SPAN" && text.length > 0 && text.length <= 3 && !/[\p{L}\p{N}]/u.test(text);
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
    warning(options.warnings || [], "svg-icon-inline-html", "图标已转为内嵌 SVG HTML，避免 data SVG 图片导入后变占位。");
    return htmlWidget(svgIconHtml(node, style, options));
  }
  const definition = iconDefinition(node);
  if (!definition) {
    // 匹配不到图标库时：无类内联 SVG 用尺寸化的内联 SVG 兜底，避免脱离页面 CSS 后按默认尺寸放大、fill 变黑。
    if (String(node.tagName || "").toUpperCase() === "SVG") {
      warning(options.warnings || [], "svg-icon-sized-fallback", "未匹配到图标库的内联 SVG 已按渲染尺寸内联，避免导入后放大变黑。");
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
  return widgetWithGlobals("icon", settings, options);
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
  if (!CONTAINER_TAGS.has(node.tagName)) return false;
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
    position: "top",
    title_text: headingText,
    description_text: para ? cleanText(para.textContent) : "",
    title_size: heading ? heading.tagName.toLowerCase() : "h3",
    text_align: normalizeAlign(style.textAlign, style.direction) || "center"
  };
  // 图标大小 + 图标到内容的间距（尽量贴近源，让图标框不至于偏小偏挤）。
  if (iconNode) {
    // 优先用计算宽度；内联 SVG 常是 auto → 回退到实际渲染尺寸（getBoundingClientRect）。
    let iconPx = parseFloat(iStyle && iStyle.width) || parseFloat(iStyle && iStyle.height) || 0;
    if ((!iconPx || iconPx < 4) && iconNode.getBoundingClientRect) {
      const rect = iconNode.getBoundingClientRect();
      iconPx = rect.width || rect.height || 0;
    }
    if (iconPx >= 4) settings.icon_size = { unit: "px", size: Math.round(iconPx), sizes: [] }; // Icon Box 图标尺寸键是 icon_size（不是 Icon 组件的 size），已对官方源码 icon-box.php:523 核对
    // 图标到标题的间距通常在图标外层包裹 div（如 .icon）上，不在 svg 上。
    const iconBlock = (iconNode.parentElement && iconNode.parentElement !== node) ? iconNode.parentElement : iconNode;
    const ibStyle = gcs(iconBlock);
    const iconSpace = ibStyle ? unit(ibStyle.marginBottom) : null;
    if (iconSpace) settings.icon_space = iconSpace;
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
    if (iStyle) settings.primary_color = color(iStyle.color);
  }
  // 参与构成图标框的子节点标记为已转换，避免被单独再处理或当作裸 HTML 保留。
  options.convertedNodes.add(node);
  [heading, para, iconNode].forEach(n => n && options.convertedNodes.add(n));
  return widgetWithGlobals("icon-box", settings, options);
}

// 图片卡识别：容器内恰好 1 张图片 + 1 个标题 + ≤1 段文本，且无其它内容元素、无多余文字（如步骤序号）→ Elementor 图片框。
function looksLikeImageBox(node) {
  if (!CONTAINER_TAGS.has(node.tagName)) return false;
  if (node.querySelectorAll("img").length !== 1) return false;
  const headings = node.querySelectorAll("h1,h2,h3,h4,h5,h6");
  const paras = node.querySelectorAll("p");
  if (headings.length !== 1 || paras.length > 1) return false;
  // 不能含其它内容元素（按钮/图标/列表/表格/表单/视频等），否则不是纯图片卡。
  if (node.querySelector("button, svg, i[class], [class*='fa-'], [class*='eicon'], ul, ol, table, form, input, select, textarea, video, iframe")) return false;
  // 非破坏性护栏：卡片文字必须≈标题+描述，出现多余文字（如步骤序号「1」「2」）就不当图片框，避免丢内容。
  const headingText = cleanText(headings[0].textContent);
  const paraText = paras.length ? cleanText(paras[0].textContent) : "";
  const bodyText = cleanText(headingText + " " + paraText);
  if (cleanText(node.textContent) !== bodyText) return false;
  return true;
}

// 从图片卡结构与已有值配好一个 Elementor 图片框（image-box）：图片/标题/描述/标签，图片位置按渲染布局判定。
function buildImageBox(node, style, win, options) {
  const img = node.querySelector("img");
  const heading = node.querySelector("h1,h2,h3,h4,h5,h6");
  const para = node.querySelector("p");
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
    const cardW = node.getBoundingClientRect().width;
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
  const cardRadius = parseFloat(style.borderTopLeftRadius) || 0;
  if (cardRadius > 0) settings.image_border_radius = { unit: "px", size: Math.round(cardRadius), sizes: [] }; // 单值滑块（已对 image-box.php:461 核对）
  settings.title_text = heading ? cleanText(heading.textContent) : "";
  settings.description_text = para ? cleanText(para.textContent) : "";
  settings.title_size = heading ? heading.tagName.toLowerCase() : "h3";
  settings.text_align = resolveAlign(node, style) || "center";
  // 图片位置：横排卡（图在文字左/右）判为 left/right，否则 top。
  let position = "top";
  if (img && heading && img.getBoundingClientRect && heading.getBoundingClientRect) {
    const ir = img.getBoundingClientRect();
    const hr = heading.getBoundingClientRect();
    if (ir.right <= hr.left + 4) position = "left";
    else if (ir.left >= hr.right - 4) position = "right";
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
  const all = [...el.querySelectorAll("svg, i[class], [class*='icon'], [class*='fa-'], [class*='eicon']")];
  return all.filter(n => !all.some(other => other !== n && other.contains(n)));
}

// 图标列表识别：容器的直接子元素是 ≥2 个「1 图标 + 文本」重复行，且不含标题/图片/按钮/嵌套列表 → Elementor 图标列表。
function looksLikeIconList(node) {
  if (!CONTAINER_TAGS.has(node.tagName)) return false;
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
    return { _id: id().slice(0, 7), text: iconListItemText(row), selected_icon: { value: selected.value, library: selected.library } };
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
    let iconPx = parseFloat(iStyle && iStyle.width) || parseFloat(iStyle && iStyle.height) || 0;
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
  const textEl = rows[0].querySelector("strong, b, span, p") || rows[0];
  const tStyle = gcs(textEl);
  if (tStyle) {
    if (options.colorMode !== "site") {
      const textColor = color(tStyle.color);
      if (textColor) settings.text_color = textColor;
    }
    typography(settings, "icon_typography", tStyle, options); // icon_typography 组控件实际作用于列表文字（已对 icon-list.php:638 核对）
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
  const rowGap = parseFloat(style.rowGap) || 0;
  const columnGap = parseFloat(style.columnGap) || 0;
  if (display.includes("grid")) {
    settings.container_type = "grid";
    // 让编辑器导航器/面板把它显示为「网格」而不是「容器」：Elementor 用 settings.presetTitle 覆盖标题（已对 editor.js:39581 + container.php:104 核对）。
    settings.presetTitle = "Grid";
    settings.presetIcon = "eicon-container-grid";
    const columns = gridColumnsSetting(style.gridTemplateColumns);
    if (columns) settings.grid_columns_grid = columns;
    // Let rows size to content instead of Elementor's default repeat(2, 1fr).
    settings.grid_rows_grid = { unit: "custom", size: "auto", sizes: [] };
    const gridItems = { start: "start", "flex-start": "start", center: "center", end: "end", "flex-end": "end", stretch: "stretch" };
    const gridContent = { ...gridItems, "space-between": "space-between", "space-around": "space-around", "space-evenly": "space-evenly" };
    if (gridItems[style.justifyItems]) settings.grid_justify_items = gridItems[style.justifyItems];
    if (gridItems[style.alignItems]) settings.grid_align_items = gridItems[style.alignItems];
    if (gridContent[style.justifyContent] && style.justifyContent !== "normal") settings.grid_justify_content = gridContent[style.justifyContent];
    if (rowGap || columnGap) settings.grid_gaps = { unit: "px", column: String(columnGap), row: String(rowGap), isLinked: rowGap === columnGap };
  } else {
    if (display.includes("flex")) {
      settings.flex_direction = style.flexDirection || "row";
      if (style.flexWrap !== "nowrap") settings.flex_wrap = "wrap";
    } else {
      settings.flex_direction = "column";
    }
    const justifyMap = { "flex-start": "flex-start", start: "flex-start", center: "center", "flex-end": "flex-end", end: "flex-end", "space-between": "space-between", "space-around": "space-around", "space-evenly": "space-evenly" };
    const alignMap = { "flex-start": "flex-start", start: "flex-start", center: "center", "flex-end": "flex-end", end: "flex-end", stretch: "stretch" };
    if (justifyMap[style.justifyContent]) settings.flex_justify_content = justifyMap[style.justifyContent];
    if (alignMap[style.alignItems]) settings.flex_align_items = alignMap[style.alignItems];
    if (rowGap || columnGap) settings.flex_gap = { unit: "px", size: columnGap || rowGap, column: String(columnGap), row: String(rowGap), isLinked: rowGap === columnGap };
  }
  const minHeight = unit(style.minHeight);
  if (minHeight) settings.min_height = minHeight;
  const maxWidth = unit(style.maxWidth);
  if (maxWidth && maxWidth.unit === "px" && Number.isFinite(maxWidth.size)) {
    settings.content_width = "boxed";
    settings.boxed_width = maxWidth;
  }
  // margin:0 auto 居中块（左右边距已在 commonSettings 清零）→ 用 boxed 居中：有 max-width 用之，否则用渲染宽度兜底。
  if (isAutoCentered(node, style) && settings.content_width !== "boxed") {
    const rectW = node.getBoundingClientRect ? Math.round(node.getBoundingClientRect().width) : 0;
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

// Shared widget builders — used by both the forced-mapping path (convertForcedNode)
// and the tag-based path (convertNode) so a fix lands in exactly one place.
function buildHeading(node, style, options) {
  const settings = commonSettings(node, style);
  const isHeadingTag = /^H[1-6]$/.test(node.tagName);
  settings.title = isHeadingTag ? node.innerHTML.trim() : escapeHtml(cleanText(node.textContent) || "Heading");
  settings.header_size = resolveHeadingTag(isHeadingTag ? node.tagName : "H2", options);
  if (options.colorMode !== "site") settings.title_color = color(style.color);
  settings.align = resolveAlign(node, style);
  typography(settings, "typography", style, options);
  return widgetWithGlobals("heading", settings, options);
}

function buildTextEditor(node, style, options, editorHtml) {
  const settings = commonSettings(node, style);
  settings.editor = editorHtml;
  if (options.colorMode !== "site") settings.text_color = color(style.color);
  const align = resolveAlign(node, style);
  if (align && align !== "left") settings.align = align; // 居中/靠右副标题等：显式设对齐，避免被容器默认左对齐；左对齐是默认值不用写
  typography(settings, "typography", style, options);
  return widgetWithGlobals("text-editor", settings, options);
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
  if (iRect && ipRect && ipRect.width > 0) {
    const pct = iRect.width / ipRect.width * 100;
    if (pct < 97) settings.width = { unit: "%", size: Math.round(pct * 100) / 100, sizes: [] };
  } else {
    const width = unit(style.width);
    if (width) settings.width = width;
  }
  // 对齐：computed 已把 margin:auto 解析成像素（原 === "auto" 永不成立），改用 resolveAlign 按渲染盒判居中（含单列护栏）。
  settings.align = resolveAlign(node, style);
  if (linkAndBorder) backgroundAndBorder(settings, style, options);
  return widget("image", settings);
}

function buildButton(node, style, options) {
  const settings = commonSettings(node, style);
  settings.text = cleanText(node.textContent) || "Button";
  settings.link = node.tagName === "A" ? linkValue(node) : { url: "", is_external: "", nofollow: "", custom_attributes: "" };
  if (options.colorMode !== "site") {
    settings.button_text_color = color(style.color);
    settings.background_color = color(style.backgroundColor);
  }
  settings.text_padding = settings._padding;
  delete settings._padding;
  settings.align = normalizeAlign(style.textAlign, style.direction);
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
  if (/youtube\.com|youtu\.be/.test(src)) return widget("video", { video_type: "youtube", youtube_url: src });
  if (/vimeo\.com/.test(src)) return widget("video", { video_type: "vimeo", vimeo_url: src });
  return htmlWidget(node.outerHTML);
}

function convertForcedNode(target, node, style, win, options, emit, depth = 0) {
  if (!target || target === "auto") return null;
  if (target === "skip") return [];
  if (target.startsWith("atomic:")) {
    const componentId = target.slice(7);
    const component = COMPONENT_REGISTRY.get(`atomic:${componentId}`);
    if (!componentAllowedForTarget(component, options)) {
      warning(options.warnings || [], `component-unavailable-${componentId}`, `${componentId} 不在所选目标站点组件范围内，已保留原内容。`);
      return null;
    }
    options.convertedNodes.add(node);
    const children = component?.kind === "element"
      ? [...node.childNodes].flatMap(child => convertNode(child, win, options, depth + 1))
      : [];
    const atomicMessage = VERIFIED_ATOMIC_COMPONENTS.has(componentId)
      ? `${componentId} 使用已验证的 Atomic Props Schema 生成；依赖目标站点启用 Atomic Widgets。`
      : `${componentId} 尚未实现可靠的 HTML Props 映射，仅创建空的 Atomic 组件；请在 Elementor 中补充内容。`;
    warning(options.warnings || [], `atomic-component-${componentId}`, atomicMessage);
    return emit(atomicComponent(componentId, node, children, component?.kind === "element", options));
  }
  if (target.startsWith("widget:")) {
    const componentId = target.slice(target.indexOf(":") + 1);
    const component = COMPONENT_REGISTRY.get(`classic:${componentId}`);
    if (!componentAllowedForTarget(component, options)) {
      warning(options.warnings || [], `component-unavailable-${componentId}`, `${componentId} 不在所选目标站点组件范围内，已保留原内容。`);
      return null;
    }
    if (["image-gallery", "image-carousel"].includes(componentId) && !allMediaCouldProduceUrls(node, options)) {
      warning(options.warnings || [], `${componentId}-media-incomplete`, `${componentId} 包含会转为空占位的相对/data 图片，已保留为独立图片组件，避免生成空或缺图组件。`);
      return null;
    }
    options.convertedNodes.add(node);
    const settings = genericComponentSettings(componentId, node, style, options);
    warning(options.warnings || [], `generic-component-${componentId}`, `${componentId} 已生成官方原生组件；无法从 HTML 推导的站点数据或专属设置需在 Elementor 中补充。`);
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
      ? outerHtmlWithoutRootStyle(node)
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

function formFields(node) {
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
  if (componentId === "progress") {
    settings.title = text || "Progress";
    settings.percent = { unit: "%", size: Number(node.getAttribute("value") || 0) / Number(node.getAttribute("max") || 100) * 100, sizes: [] };
  }
  if (componentId === "shortcode") settings.shortcode = text;
  if (componentId === "html") settings.html = node.outerHTML;
  if (componentId === "form") {
    settings.form_name = node.getAttribute("name") || node.getAttribute("id") || "Converted Form";
    settings.form_fields = formFields(node);
    const submit = node.querySelector("button[type='submit'],button:not([type]),input[type='submit']");
    settings.button_text = cleanText(submit?.textContent) || submit?.getAttribute("value") || "Submit";
    settings.submit_actions = [];
  }
  const images = [...node.querySelectorAll("img")]
    .map(item => ({ url: options.imageMode === "placeholder" ? "" : mediaSource(item, options), id: "" }))
    .filter(item => options.imageMode === "placeholder" || item.url);
  if (componentId === "image-gallery") {
    settings.wp_gallery = images;
    settings.gallery_columns = String(Math.min(6, Math.max(1, Math.round(Math.sqrt(images.length || 1)))));
    settings.thumbnail_size = "full";
  }
  if (componentId === "image-carousel") {
    settings.carousel_name = node.getAttribute("aria-label") || "Converted Carousel";
    settings.carousel = images;
    settings.slides_to_show = String(Math.min(4, Math.max(1, images.length))); // 该控件是字符串选项（image-carousel.php:525 默认 '1'），传数字会被忽略
    settings.thumbnail_size = "full";
  }
  if (componentId === "social-icons") {
    const brand = url => /facebook/.test(url) ? "facebook" : /instagram/.test(url) ? "instagram" : /linkedin/.test(url) ? "linkedin" : /youtube/.test(url) ? "youtube" : /twitter|x\.com/.test(url) ? "x-twitter" : "link";
    settings.social_icon_list = [...node.querySelectorAll("a[href]")].map(link => {
      const name = brand(link.href);
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
    settings.ending_number = Number(text.match(/-?[\d,.]+/)?.[0]?.replaceAll(",", "")) || 0;
    settings.title = text.replace(/-?[\d,.]+/, "").trim() || "Counter";
  }
  if (componentId === "alert") {
    settings.alert_type = "info";
    settings.alert_title = cleanText(node.querySelector("strong,h1,h2,h3,h4")?.textContent) || "Notice";
    settings.alert_description = text;
    settings.show_dismiss = "";
  }
  if (componentId === "accordion") {
    const details = node.tagName === "DETAILS" ? [node] : [...node.querySelectorAll("details")];
    settings.tabs = details.map(detail => ({
      _id: id(),
      tab_title: cleanText(detail.querySelector("summary")?.textContent) || "Item",
      tab_content: [...detail.childNodes].filter(child => child.nodeName !== "SUMMARY").map(child => child.outerHTML || escapeHtml(child.textContent || "")).join("")
    }));
  }
  if (componentId === "tabs") {
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
    return text ? [widgetWithGlobals("text-editor", { editor: `<p>${escapeHtml(text)}</p>` }, options)] : [];
  }
  if (node.nodeType !== Node.ELEMENT_NODE || ["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE"].includes(node.tagName)) return [];
  if (depth > MAX_CONVERT_DEPTH) {
    warning(options.warnings || [], "max-depth-html-fallback", "元素嵌套过深，超出安全层级的子树已整体保留为 HTML 小部件。");
    return [htmlWidget(node.outerHTML)];
  }
  const style = win.getComputedStyle(node);
  const emit = element => {
    options.nodeElementMap?.set(node, element);
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
  if (isIconNode(node)) {
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
  if (tag === "A" && !node.querySelector("img")) {
    options.convertedNodes.add(node);
    const hasBlockContent = [...node.children].some(child => CONTAINER_TAGS.has(child.tagName) || ["P", "UL", "OL", "TABLE"].includes(child.tagName));
    if (hasBlockContent) return emit(htmlWidget(node.outerHTML));
    return emit(buildTextEditor(node, style, options, `<p>${outerHtmlWithoutRootStyle(node)}</p>`));
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
  if (tag === "P" || tag === "BLOCKQUOTE" || tag === "UL" || tag === "OL" || tag === "TABLE" || tag === "DL" || tag === "PRE") {
    options.convertedNodes.add(node);
    return emit(buildTextEditor(node, style, options, outerHtmlWithoutRootStyle(node)));
  }
  if (INLINE_TEXT_TAGS.has(tag)) {
    options.convertedNodes.add(node);
    return emit(buildTextEditor(node, style, options, `<p>${outerHtmlWithoutRootStyle(node)}</p>`));
  }
  if (tag === "VIDEO") {
    options.convertedNodes.add(node);
    return emit(buildVideo(node));
  }
  if (tag === "IFRAME" || tag === "SVG" || tag === "CANVAS" || tag === "FORM" || tag === "AUDIO") return emit(htmlWidget(node.outerHTML));

  // 图片卡（图片 + 标题 + 一段文本）→ Elementor 图片框：卡片外框样式转到图片框小组件自身，直接进父级网格/容器，不再多包一层。图片模式与图标模式无关，恒生效。
  if (CONTAINER_TAGS.has(tag) && looksLikeImageBox(node)) {
    options.convertedNodes.add(node);
    const imageBox = buildImageBox(node, style, win, options);
    applyCardFrameToWidget(imageBox, node, style, options);
    return emit(imageBox);
  }

  // 「图标 + 文本」重复行的容器 → Elementor 图标列表（icon-list）：整块换成一个可编辑的图标列表组件，
  // 每行图标匹配进图标库（清单勾号统一为 fa-check），彻底避免内联 SVG 丢样式后放大变黑。
  // 仅在「图标 = 匹配 Elementor 图标库」时介入。
  if (CONTAINER_TAGS.has(tag) && options.iconMode === "elementor" && looksLikeIconList(node)) {
    options.convertedNodes.add(node);
    const list = buildIconList(node, style, win, options);
    Object.assign(list.settings, elementWidthSettings(node, node.parentElement));
    return emit(list);
  }

  // 卡片（图标 + 标题 + 一段文本）→ Elementor 图标框：卡片外框样式转到图标框小组件自身，直接进父级，不再多包一层容器。
  // 仅在「图标 = 匹配 Elementor 图标库」时介入；「保留原始 HTML 图标」「内嵌 SVG」都表示用户要保住原图标，不动。
  if (CONTAINER_TAGS.has(tag) && options.iconMode === "elementor" && looksLikeIconBox(node)) {
    options.convertedNodes.add(node);
    const iconBox = buildIconBox(node, style, win, options);
    applyCardFrameToWidget(iconBox, node, style, options); // 卡片外框转到图标框小组件自身，直接进父级，不再多包一层容器
    return emit(iconBox);
  }

  const childElements = [];
  [...node.childNodes].forEach(child => childElements.push(...convertNode(child, win, options, depth + 1)));
  if (CONTAINER_TAGS.has(tag)) {
    // 冗余透传 div 折叠：仅一个元素子节点、自身无任何样式作用时，压平以减少嵌套层级。
    if (tag === "DIV" && depth > 0 && childElements.length === 1 && node.children.length === 1 && isTransparentWrapper(node, style)) {
      options.convertedNodes.add(node);
      options.collapsedCount = (options.collapsedCount || 0) + 1;
      return childElements;
    }
    options.convertedNodes.add(node);
    const result = container(node, style, childElements, options);
    Object.assign(result.settings, elementWidthSettings(node, node.parentElement));
    return emit(result);
  }
  if (!VOID_TAGS.has(tag) && childElements.length) return childElements;
  return emit(htmlWidget(node.outerHTML));
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function outerHtmlWithoutRootStyle(node) {
  const clone = node.cloneNode(true);
  clone.removeAttribute("style");
  return clone.outerHTML;
}

function sanitizeDocument(doc, options, warnings) {
  const scripts = doc.querySelectorAll("script,noscript,template");
  if (scripts.length) warning(warnings, "scripts-removed", "已移除脚本、noscript 或 template 活动内容。", scripts.length);
  scripts.forEach(node => node.remove());
  const blockedEmbeds = doc.querySelectorAll("object,embed,applet");
  if (blockedEmbeds.length) warning(warnings, "unsafe-embed-removed", "已移除 object/embed/applet 活动内容。", blockedEmbeds.length);
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
      warning(warnings, "form-action-removed", "表单结构将转换为原生组件，原提交地址与提交方法已移除。");
      return;
    }
    warning(warnings, "form-neutralized", "表单已解除提交能力，仅保留内部可见内容。");
    form.replaceWith(...form.childNodes);
  });
  doc.querySelectorAll("iframe").forEach(frame => {
    const src = frame.getAttribute("src") || "";
    let allowed = false;
    try {
      const url = new URL(src, "https://html-to-elementor.local/");
      allowed = url.protocol === "https:" && SAFE_IFRAME_HOSTS.has(url.hostname);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      warning(warnings, "iframe-removed", "已移除非 YouTube/Vimeo 的 iframe。");
      frame.remove();
      return;
    }
    frame.removeAttribute("srcdoc");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation");
    frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    frame.setAttribute("loading", "lazy");
  });
  const externalStyles = doc.querySelectorAll("link[rel~='stylesheet'],link[rel~='preload'][as='style']");
  if (externalStyles.length) warning(warnings, "external-css-removed", "已移除外部 CSS 链接，防止污染目标站点或产生追踪请求。", externalStyles.length);
  externalStyles.forEach(node => node.remove());
  doc.querySelectorAll("base,meta[http-equiv]").forEach(node => node.remove());
  doc.querySelectorAll("*").forEach(node => {
    [...node.attributes].filter(attr => attr.name.toLowerCase().startsWith("on")).forEach(attr => node.removeAttribute(attr.name));
    node.removeAttribute("srcdoc");
    URL_ATTRIBUTES.forEach(attribute => {
      if (!node.hasAttribute(attribute)) return;
      const value = node.getAttribute(attribute);
      if (!isSafeUrl(value, attribute, node)) {
        node.removeAttribute(attribute);
        warning(warnings, "unsafe-url-removed", "已移除 javascript/data/blob 等不安全 URL。");
      } else if (/^(?:https?:)?\/\//i.test(value)) {
        warning(warnings, "external-resource", "页面包含外部链接或资源，导入后可能继续访问第三方域名。");
      }
    });
    if (node.hasAttribute("srcset")) {
      const candidates = node.getAttribute("srcset").split(",").map(item => item.trim().split(/\s+/)[0]);
      if (candidates.some(url => !isSafeUrl(url, "src", node))) {
        node.removeAttribute("srcset");
        warning(warnings, "unsafe-srcset-removed", "已移除包含不安全 URL 的 srcset。");
      }
    }
    const inlineStyle = node.getAttribute("style") || "";
    if (/(?:expression\s*\(|url\s*\(\s*['\"]?\s*javascript:|behavior\s*:|-moz-binding)/i.test(inlineStyle)) {
      node.removeAttribute("style");
      warning(warnings, "unsafe-inline-style-removed", "已移除包含危险表达式的内联样式。");
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
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    const serializeRules = rules => [...rules].map(rule => {
      if (rule.constructor.name === "CSSStyleRule") {
        const isStateRule = /:(?!root\b)/.test(rule.selectorText);
        const appliesToConvertedRoot = !isStateRule && [...(options.convertedNodes || [])].some(node => {
          try {
            return node.matches(rule.selectorText);
          } catch {
            return false;
          }
        });
        const declarations = [...rule.style]
          .filter(property => {
            const normalized = property.toLowerCase();
            if (options.colorMode === "site" && colorProperties.has(normalized)) return false;
            if (options.fontMode === "site" && fontProperties.has(normalized)) return false;
            if (appliesToConvertedRoot) return !mappedProperties.has(normalized);
            return true;
          })
          .map(property => `${property}:${rule.style.getPropertyValue(property)}${rule.style.getPropertyPriority(property) ? " !important" : ""};`)
          .join("");
        return declarations ? `${rule.selectorText}{${declarations}}` : "";
      }
      if (rule.constructor.name === "CSSMediaRule") return `@media ${rule.conditionText}{${serializeRules(rule.cssRules)}}`;
      if (rule.constructor.name === "CSSSupportsRule") return `@supports ${rule.conditionText}{${serializeRules(rule.cssRules)}}`;
      return rule.cssText;
    }).join("");
    return serializeRules(sheet.cssRules);
  } catch {
    warning(options.warnings || [], "css-filter-failed", "部分原生模式 CSS 无法安全解析，已移除该段样式。");
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

function responsiveSetting(settings, key, suffix, value) {
  if (value == null || value === "" || sameSetting(settings[key], value)) return;
  settings[`${key}_${suffix}`] = value;
}

async function applyResponsiveSettings(frame, options) {
  // Slugs and default max-width values verified against core/breakpoints/manager.php.
  // widescreen is min-width based and intentionally omitted.
  const breakpoints = options.responsiveBreakpoints === "extended"
    ? [
        { suffix: "laptop", width: 1366 },
        { suffix: "tablet_extra", width: 1200 },
        { suffix: "tablet", width: 1024 },
        { suffix: "mobile_extra", width: 880 },
        { suffix: "mobile", width: 767 }
      ]
    : [
        { suffix: "tablet", width: 1024 },
        { suffix: "mobile", width: 767 }
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
      const isHidden = style.display === "none" || style.visibility === "hidden";
      if (isHidden) settings[`hide_${breakpoint.suffix}`] = `hidden-${breakpoint.suffix}`;
      else delete settings[`hide_${breakpoint.suffix}`];
      const marginKey = isContainer ? "margin" : "_margin";
      const paddingKey = isContainer ? "padding" : element.widgetType === "button" ? "text_padding" : "_padding";
      const bpMargin = dimensions(style, "margin", true);
      // 断点同样清零 margin:0 auto 居中块的左右外边距（computed 会解析成视口相关像素，如 tablet 的 65.25px），交给 boxed 居中。
      if (bpMargin && isAutoCentered(node, style)) { bpMargin.left = "0"; bpMargin.right = "0"; bpMargin.isLinked = false; }
      responsiveSetting(settings, marginKey, breakpoint.suffix, bpMargin);
      responsiveSetting(settings, paddingKey, breakpoint.suffix, dimensions(style, "padding", true));
      if (isContainer && settings.container_type === "grid") {
        const rowGap = parseFloat(style.rowGap) || 0;
        const columnGap = parseFloat(style.columnGap) || 0;
        responsiveSetting(settings, "grid_columns_grid", breakpoint.suffix, gridColumnsSetting(style.gridTemplateColumns));
        responsiveSetting(settings, "grid_gaps", breakpoint.suffix, (rowGap || columnGap) ? {
          unit: "px",
          column: String(columnGap),
          row: String(rowGap),
          isLinked: rowGap === columnGap
        } : null);
        responsiveSetting(settings, "min_height", breakpoint.suffix, unit(style.minHeight));
        const width = elementWidthSettings(node, node.parentElement).width;
        responsiveSetting(settings, "width", breakpoint.suffix, width);
      } else if (isContainer) {
        const direction = style.display.includes("flex") ? style.flexDirection : "column";
        responsiveSetting(settings, "flex_direction", breakpoint.suffix, direction);
        responsiveSetting(settings, "flex_wrap", breakpoint.suffix, style.flexWrap === "nowrap" ? "" : "wrap");
        const justifyMap = { start: "flex-start", "flex-start": "flex-start", center: "center", end: "flex-end", "flex-end": "flex-end", "space-between": "space-between", "space-around": "space-around", "space-evenly": "space-evenly" };
        const alignMap = { start: "flex-start", "flex-start": "flex-start", center: "center", end: "flex-end", "flex-end": "flex-end", stretch: "stretch" };
        responsiveSetting(settings, "flex_justify_content", breakpoint.suffix, justifyMap[style.justifyContent]);
        responsiveSetting(settings, "flex_align_items", breakpoint.suffix, alignMap[style.alignItems]);
        const rowGap = parseFloat(style.rowGap) || 0;
        const columnGap = parseFloat(style.columnGap) || 0;
        responsiveSetting(settings, "flex_gap", breakpoint.suffix, {
          unit: "px",
          size: columnGap || rowGap,
          column: String(columnGap),
          row: String(rowGap),
          isLinked: rowGap === columnGap
        });
        responsiveSetting(settings, "min_height", breakpoint.suffix, unit(style.minHeight));
        const width = elementWidthSettings(node, node.parentElement).width;
        responsiveSetting(settings, "width", breakpoint.suffix, width);
      } else {
        if (["heading", "text-editor", "button"].includes(element.widgetType) && options.fontMode !== "site") {
          responsiveSetting(settings, "typography_font_size", breakpoint.suffix, unit(style.fontSize));
          responsiveSetting(settings, "typography_line_height", breakpoint.suffix, unit(style.lineHeight));
          responsiveSetting(settings, "typography_letter_spacing", breakpoint.suffix, unit(style.letterSpacing));
        }
        if (["heading", "button", "image", "icon"].includes(element.widgetType)) {
          const alignment = element.widgetType === "image"
            ? resolveAlign(node, style) // computed 已解析 margin:auto 成像素，用 resolveAlign 判居中
            : normalizeAlign(style.textAlign, style.direction);
          responsiveSetting(settings, "align", breakpoint.suffix, alignment);
        }
        if (element.widgetType === "image") {
          // 按断点用「占父百分比」表达图宽（视口无关），满宽不写；拿不到父尺寸才回退像素。
          const nr = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
          const pr = node.parentElement && node.parentElement.getBoundingClientRect ? node.parentElement.getBoundingClientRect() : null;
          let imgWidth = null;
          if (nr && pr && pr.width > 0) {
            const pct = nr.width / pr.width * 100;
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
  report(0.04, "解析 HTML…");
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
  report(0.12, "清理与作用域化…");
  const preservesDataImages = options.mode === "fidelity"
    || (options.mode === "native" && options.imageMode !== "placeholder" && (options.assetUrlMode || "safe") === "preserve");
  if (options.optimizeImages && preservesDataImages) report(0.18, "优化内嵌图片…");
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
    report(0.85, "生成 Elementor 数据…");
    elements = [rootContainer([htmlWidget(bodyPayload(parsed, options.keepStyles))])];
  } else {
    if (options.nativeStrategy === "framework") {
      warning(warnings, "framework-only", "仅框架模式已省略标题、文本、图片、按钮等内容，只保留可编辑容器布局。");
    }
    report(0.22, "加载预览布局…");
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
    report(0.74, "计算响应式布局…");
    await applyResponsiveSettings(frame, options);
    const css = options.keepStyles && options.nativeStrategy !== "framework"
      ? [...liveDoc.querySelectorAll("style")]
        .filter(node => !node.hasAttribute("data-hte-internal")) // 排除内部注入的隔离样式
        .map(node => filterCssText(node.textContent, options))
        .filter(Boolean)
        .map(value => `<style>${value}</style>`)
        .join("\n")
      : "";
    if (css) converted.unshift(htmlWidget(css));
    elements = converted.length === 1 && converted[0].elType === "container" ? converted : [rootContainer(converted)];
  }

  report(0.96, "打包模板…");
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
  report(1, "完成");
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
