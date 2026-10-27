// Read-only renderers for the non-markdown formats the viewer can open: a standalone .html doc in a
// sandboxed iframe, a .pdf in the browser's native viewer, a .docx converted client-side via a
// lazy-loaded mammoth, an image fitted to the pane, and a .json pretty-printed. DocRenderer.show
// (doc-renderer.ts) dispatches here by extension through the
// exported frameRenderer. Plain innerHTML rendering — no
// markdown pipeline, no editing chrome (TOC/backlinks/notes/todos are hidden, restored by the next
// .md doc via DocRenderer.show).

import { IS_OFFLINE_BUILD, EMBED_CONTENT } from '../core/data-csrf';
import { escapeHtml } from '../core/utils';
import { t } from '../core/i18n';
import { contentEl, btnEdit, btnSave, btnCancel, tocList, tocLinks, tocNotes, tocPanel } from '../core/dom-refs';
import { currentFile } from '../core/state';
import { tocShow } from '../home/layout-chrome';
import { renderSkeleton } from './skeleton';
import { attachCopyButtons } from './content-decorators';

export class Frames {
  // Shared iframe geometry: full-bleed minus the breadcrumb, dark backdrop.
  private static readonly FRAME_STYLE = 'width:100%;height:calc(100vh - 150px);border:0;display:block;background:#0b0d13';
  // mammoth.js (DOCX → HTML) is ~640 KB: loaded on demand, never in the <head>, since most sessions
  // never open a .docx.
  private static readonly MAMMOTH_URL = '/vendor/mammoth.min.js';
  // Past this many characters a .json is shown unhighlighted: hljs would freeze the tab.
  private static readonly JSON_HIGHLIGHT_MAX = 512 * 1024;

  // In-flight loads of lazy vendor scripts, cached by URL so a second .docx reuses the first load.
  private scriptCache = new Map<string, Promise<void>>();

  // .html doc (slide deck, dashboard…) rendered as-is in a sandboxed iframe: allow-scripts runs its
  // JS in an opaque origin (no access to the viewer's DOM/cookies), allow=fullscreen enables
  // fullscreen. Offline (file://) the absolute URL won't resolve → inject the embedded content via
  // srcdoc instead.
  renderHtml(file: FileNode): void {
    this.enterFrameMode(true);

    const u = escapeHtml(this.frameUrl(file));
    const offlineSrc = IS_OFFLINE_BUILD ? (file.content ?? EMBED_CONTENT?.[file.path] ?? null) : null;
    const frameAttr = offlineSrc != null ? 'srcdoc="' + escapeHtml(offlineSrc) + '"' : 'src="' + u + '"';

    contentEl.innerHTML =
      this.banner('htmlDocBanner', u) +
      '<iframe ' + frameAttr + ' sandbox="allow-scripts" allow="fullscreen" title="' + escapeHtml(file.name) + '" style="' + Frames.FRAME_STYLE + '"></iframe>';
  }

  // .pdf in the browser's native viewer via a same-origin iframe (X-Frame-Options SAMEORIGIN allows
  // our own framing). Offline a binary can't be inlined → offer a direct-open link instead.
  renderPdf(file: FileNode): void {
    this.enterFrameMode(true);

    const u = escapeHtml(this.frameUrl(file));
    const body = IS_OFFLINE_BUILD
      ? this.offlineHint('pdfOfflineHint', u, file)
      : '<iframe src="' + u + '" title="' + escapeHtml(file.name) + '" style="' + Frames.FRAME_STYLE + '"></iframe>';

    contentEl.innerHTML = this.banner('pdfDocBanner', u) + body;
  }

  // .docx → HTML via mammoth, sanitized and injected into .prose. Read-only, client-side. Each
  // currentFile guard drops a result whose page changed during the fetch/parse.
  async renderDocx(file: FileNode): Promise<void> {
    this.enterFrameMode(false);
    contentEl.innerHTML = renderSkeleton(file);

    try {
      await this.loadScript(Frames.MAMMOTH_URL, () => !!window.mammoth);

      const buf = await (await fetch(this.frameUrl(file), { cache: 'no-cache' })).arrayBuffer();

      if (currentFile !== file) return;

      const result = await window.mammoth!.convertToHtml({ arrayBuffer: buf });

      if (currentFile !== file) return;
      contentEl.innerHTML = '<div class="docx-doc">' + DOMPurify.sanitize(result.value) + '</div>';
    } catch (e) {
      if (currentFile !== file) return;
      contentEl.innerHTML =
        '<div class="text-rose-400 text-sm">' +
        escapeHtml(t('docxError', (e as Error).message)) +
        ' <a href="' + escapeHtml(this.encodePath(file)) + '" class="text-sky-400 hover:underline">' +
        escapeHtml(file.name) + '</a></div>';
    }
  }

  // An image fitted to the pane over a checkerboard (so transparency shows); a click toggles its
  // natural size. Shown through <img>, so an .svg never runs a script.
  renderImage(file: FileNode): void {
    this.enterFrameMode(true);

    const u = escapeHtml(this.frameUrl(file));

    if (IS_OFFLINE_BUILD) {
      contentEl.innerHTML = this.banner('imageDocBanner', u) + this.offlineHint('previewOfflineHint', u, file);

      return;
    }
    contentEl.innerHTML =
      this.banner('imageDocBanner', u) +
      '<div class="image-doc"><img src="' + u + '" alt="' + escapeHtml(file.name) + '"></div>';

    const box = contentEl.querySelector('.image-doc') as HTMLElement;
    const img = box.querySelector('img') as HTMLImageElement;

    img.addEventListener('load', () => {
      if (currentFile !== file) return;
      const label = contentEl.querySelector('[data-banner-label]');

      if (label) label.textContent = t('imageDocBanner') + ' · ' + t('imageSize', img.naturalWidth, img.naturalHeight);
      // Only an image the pane shrinks can be zoomed.
      box.classList.toggle('image-doc--zoomable', img.naturalWidth > img.clientWidth || img.naturalHeight > img.clientHeight);
    });
    img.addEventListener('error', () => {
      if (currentFile !== file) return;
      box.innerHTML = '<p class="text-rose-400 text-sm">' + escapeHtml(t('imageError')) + ' <a href="' + u + '" class="text-sky-400 hover:underline">' + escapeHtml(file.name) + '</a></p>';
    });
    img.addEventListener('click', () => {
      if (box.classList.contains('image-doc--zoomable')) box.classList.toggle('image-doc--actual');
    });
  }

  // A .json pretty-printed and highlighted, under a one-line summary (an array's length, an
  // object's keys, the size). Invalid JSON is shown as is, under the parse error.
  async renderJson(file: FileNode): Promise<void> {
    this.enterFrameMode(false);

    const u = escapeHtml(this.frameUrl(file));

    if (IS_OFFLINE_BUILD) {
      contentEl.innerHTML = this.offlineHint('previewOfflineHint', u, file);

      return;
    }
    contentEl.innerHTML = renderSkeleton(file);

    let text: string;

    try {
      const res = await fetch(this.frameUrl(file));

      if (!res.ok) throw new Error('HTTP ' + res.status);
      text = await res.text();
    } catch (e) {
      if (currentFile !== file) return;
      contentEl.innerHTML = '<div class="text-rose-400 text-sm">' + escapeHtml(t('loadError', (e as Error).message)) + '</div>';

      return;
    }
    if (currentFile !== file) return;

    let shown = text;
    let summary: string;
    let invalid = false;

    try {
      const value = JSON.parse(text);

      shown = JSON.stringify(value, null, 2);
      summary = Array.isArray(value) ? t('jsonArray', value.length)
        : value !== null && typeof value === 'object' ? t('jsonObject', Object.keys(value).length)
          : 'JSON';
    } catch (e) {
      summary = t('jsonInvalid', (e as Error).message);
      invalid = true;
    }

    const code = !invalid && shown.length <= Frames.JSON_HIGHLIGHT_MAX
      ? hljs.highlight(shown, { language: 'json' }).value
      : escapeHtml(shown);

    contentEl.innerHTML =
      '<div class="json-doc">' +
      '<p class="json-doc-summary' + (invalid ? ' json-doc-summary--invalid' : '') + '">' +
      escapeHtml(summary + ' · ' + t('fileSize', new Blob([text]).size)) + '</p>' +
      '<pre><code class="hljs language-json">' + code + '</code></pre></div>';
    attachCopyButtons();
  }

  // Offline a binary or a fetched file isn't embedded: a direct link instead.
  private offlineHint(hintKey: string, u: string, file: FileNode): string {
    return '<div class="p-6 text-sm text-ink-400">' + t(hintKey) + ' <a href="' + u + '" class="text-sky-400 hover:underline">' + escapeHtml(file.name) + '</a></div>';
  }

  // Banner above a framed doc: a label + an "open fullscreen" link to the raw URL.
  private banner(bannerKey: string, u: string): string {
    return (
      '<div class="flex items-center justify-between px-4 py-2 border-b border-navy-500 bg-navy-800 text-xs">' +
      '<span class="text-ink-400 font-mono" data-banner-label>' + t(bannerKey) + '</span>' +
      '<a href="' + u + '" target="_blank" rel="noopener" class="text-sky-400 hover:underline whitespace-nowrap ml-3">' + t('openFullscreen') + '</a>' +
      '</div>'
    );
  }

  // A framed doc takes over the content pane: no editing (none of these is editable via the viewer),
  // no TOC/backlinks/notes/todos (meaningless over a standalone doc). fullWidth drops the prose width
  // cap + padding for the HTML/PDF decks; DOCX keeps prose width (restores it). All restored by the
  // next .md doc via DocRenderer.show.
  private enterFrameMode(fullWidth: boolean): void {
    btnEdit.classList.add('hidden');
    btnSave.classList.add('hidden');
    btnCancel.classList.add('hidden');
    contentEl.style.maxWidth = fullWidth ? 'none' : '';
    contentEl.style.padding = fullWidth ? '0' : '';
    tocList.innerHTML = '';
    tocLinks.innerHTML = '';
    tocNotes.innerHTML = '';
    tocPanel.classList.add('hidden');
    tocPanel.classList.remove('flex');
    if (tocShow) tocShow.classList.add('hidden');
    document.getElementById('todo-widget')?.classList.add('hidden');
  }

  // Content-relative path → an absolute, percent-encoded URL (no cache-buster).
  private encodePath(file: FileNode): string {
    return '/' + file.path.split('/').map(encodeURIComponent).join('/');
  }

  // Same, plus the mtime cache-buster used for the live fetch / iframe src.
  private frameUrl(file: FileNode): string {
    return this.encodePath(file) + (file.mtime ? '?v=' + file.mtime : '');
  }

  // Load a vendor <script> once, cached by URL; resolve when onload fires AND ready() confirms the
  // global it defines is present (a 200 that isn't the expected script still rejects). A failed load
  // is evicted so a later open can retry.
  private loadScript(url: string, ready: () => boolean): Promise<void> {
    if (ready()) return Promise.resolve();

    const cached = this.scriptCache.get(url);

    if (cached) return cached;

    const p = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');

      s.src = url;
      s.onload = () => (ready() ? resolve() : reject(new Error(url)));
      s.onerror = () => {
        this.scriptCache.delete(url);
        reject(new Error(url + ' load failed'));
      };
      document.head.appendChild(s);
    });

    this.scriptCache.set(url, p);

    return p;
  }
}

// Not `frames` — that name collides with the DOM global `window.frames` (lib.dom `var frames`).
export const frameRenderer = new Frames();
