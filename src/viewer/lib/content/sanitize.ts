// The one door for document HTML (a note's markdown, a .docx, a past version). Whoever wrote the doc
// (a member, an agent's drop, the mirror of another atlas), it must not pass itself off as Atlas: no
// form controls (a fake "sign in again" box), no <style> (CSS over the whole viewer), no style or
// class that lifts it out of the page or over a dialog, and ids that can't stand in for the app's own.

// The prefix DOMPurify gives the ids and names of a doc (SANITIZE_NAMED_PROPS); the TOC uses it too.
export const DOC_ID_PREFIX = 'user-content-';

const CONFIG = {
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'option', 'optgroup', 'datalist', 'dialog'],
  SANITIZE_NAMED_PROPS: true,
};

// Inline styles keep what dresses the text (colours, fonts, borders, sizes) and lose what moves it
// (position, inset, z-index, transform, margins) or loads something (url()).
const HARMLESS_STYLE =
  /^(color|background-color|opacity|font-(family|size|style|variant|weight)|text-(align|decoration(-\w+)?|transform|indent)|vertical-align|white-space|word-(break|spacing)|letter-spacing|line-height|list-style-(type|position)|border(-\w+)*|padding(-\w+)?|(min-|max-)?(width|height)|display|float|clear)$/;
// A doc's own classes are the ones its rendering gives it (code colouring, wikilinks): any other would
// borrow the app's (fixed, inset-0, z-50, overlay-backdrop…).
const RENDER_CLASS = /^(hljs|language-)|^(wikilink|broken)$/;

const probe = document.createElement('span');

function harmlessStyle(css: string): string {
  probe.style.cssText = css;
  const kept: string[] = [];

  for (let i = 0; i < probe.style.length; i++) {
    const prop = probe.style[i];
    const value = probe.style.getPropertyValue(prop);

    if (HARMLESS_STYLE.test(prop) && !/url\(/i.test(value)) kept.push(prop + ':' + value);
  }

  return kept.join(';');
}

// Absent only on a broken build, which Markdown.render reports instead of rendering.
if (typeof DOMPurify !== 'undefined') {
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName === 'style') data.attrValue = harmlessStyle(data.attrValue);
    else if (data.attrName === 'class') data.attrValue = data.attrValue.split(/\s+/).filter((c) => RENDER_CLASS.test(c)).join(' ');
    else return;
    if (!data.attrValue) data.keepAttr = false;
  });
  // The only <input> a doc keeps is a task's checkbox (task-checkboxes.ts enables it on an editable doc).
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName !== 'INPUT') return;
    node.setAttribute('type', 'checkbox');
    node.setAttribute('disabled', '');
  });
}

export function sanitizeHtml(html: string, forbidTags: string[] = []): string {
  return DOMPurify.sanitize(html, forbidTags.length ? { ...CONFIG, FORBID_TAGS: CONFIG.FORBID_TAGS.concat(forbidTags) } : CONFIG);
}
