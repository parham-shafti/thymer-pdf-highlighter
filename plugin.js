// PDF Highlighter → Thymer
// Global app plugin that augments Thymer's NATIVE pdf.js preview (iframe.id--pdf-viewer,
// same-origin, exposes contentWindow.PDFViewerApplication). It does NOT render its own
// viewer. Select text in an open PDF -> pick a colour -> the passage is extracted into the
// note open beside it, with a clickable backlink arrow that jumps back to the page + passage.
// A coloured overlay is drawn over the passage and redrawn whenever the PDF is reopened.
//
// Verified APIs (live, June 2026):
//   this.ui.getPanels() -> [PluginPanel]; panel.getType() in {"blob_preview","edit_panel"};
//     panel.getElement(); panel.getActiveRecord() -> PluginRecord (null on blob_preview).
//   record.createLineItem(parent, after, type) -> Promise<PluginLineItem>
//   lineItem.setSegments([{type,text}]) accepts PLAIN objects; linkobj uses text:{link,title}
//   lineItem.setMetaProperties({...}); lineItem.delete(); lineItem.getRecord()
//   PDFViewerApplication: .page (get/set), .pagesCount, .pdfViewer.scrollPageIntoView,
//     .eventBus, .findController, .pdfDocument.fingerprints

class Plugin extends AppPlugin {
  onLoad() {
    // ---- config ----------------------------------------------------------
    // 5 highlight colours. Colour -> meaning labels are intentionally generic for now
    // (the meaning system is deferred); `dot` is the in-note coloured indicator.
    this.COLORS = [
      { key: "yellow", label: "Yellow", dot: "\u{1F7E1}", rgb: "255,214,10" },
      { key: "green",  label: "Green",  dot: "\u{1F7E2}", rgb: "52,199,89" },
      { key: "blue",   label: "Blue",   dot: "\u{1F535}", rgb: "10,132,255" },
      { key: "pink",   label: "Pink",   dot: "\u{1F7E3}", rgb: "255,55,151" },
      { key: "orange", label: "Orange", dot: "\u{1F7E0}", rgb: "255,149,0" },
    ];
    this.BACKLINK_HOST = "pdfhl.thymer.local"; // sentinel host we intercept on click

    // OCR fallback for scanned (image-only) pages. tesseract.js is lazy-loaded from
    // a CDN on first use (the renderer has no CSP; CDN fetch + WASM work — verified).
    this.TESSERACT_CDN = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
    this.OCR_TARGET_W = 2550;  // target rendered page width (px) ≈ 300 DPI for a letter page
    this.OCR_MAX_SCALE = 6;    // cap re-render scale (tiny pages)
    this.OCR_MAX_DIM = 5000;   // cap region-canvas longest side (memory)
    this._ocrWorkerPromise = null; // shared tesseract worker (lazy)
    // OCR languages (Tesseract codes). The active one is loaded on demand the first
    // time it's used; switch it via the "OCR language" command in the palette.
    this.OCR_LANGUAGES = [
      { code: "eng", label: "English" },
      { code: "swe", label: "Swedish" },
      { code: "deu", label: "German" },
      { code: "fra", label: "French" },
      { code: "spa", label: "Spanish" },
      { code: "ell", label: "Greek" },
      { code: "heb", label: "Hebrew" },
    ];
    this._ocrLang = "eng";
    try { const conf = this.getConfiguration(); if (conf && conf.custom && conf.custom.ocrLang) this._ocrLang = conf.custom.ocrLang; } catch (e) {}
    this._cmds = []; // registered command-palette commands (removed on teardown)

    this._hooked = new WeakSet();     // iframes already wired
    this._cleanups = [];              // teardown fns
    this._pendingRange = null;        // last good selection range (per active iframe)
    this._activeHook = null;          // the hook ctx whose selection is live

    // Hot code-reload can leave a PREVIOUS instance's listeners attached (Thymer
    // does not reliably call onUnload), which keeps handling user input with stale
    // code. Tear the previous instance down completely before wiring this one up.
    try { if (typeof window.__pdfhlDestroy === "function") window.__pdfhlDestroy(); } catch (e) {}

    this._injectMainCSS();
    this._installBacklinkClickHandler();
    this._installViewerObserver();

    // Hook any PDF viewer already open.
    this._scanForViewers();

    // One command-palette command per OCR language (sets it for scanned-page OCR).
    try {
      for (const L of this.OCR_LANGUAGES) {
        this._cmds.push(this.ui.addCommandPaletteCommand({
          label: "PDF Highlighter: " + L.label,
          icon: "ti-language",
          onSelected: () => this._setOcrLang(L.code),
        }));
      }
    } catch (e) {}

    // Functional (not debug): the next instance calls this on hot-reload to fully
    // tear down this one, so stale listeners never accumulate. See onLoad top.
    window.__pdfhlDestroy = () => this._destroy();
  }

  onUnload() { this._destroy(); }

  _destroy() {
    (this._cleanups || []).forEach((fn) => { try { fn(); } catch (e) {} });
    this._cleanups = [];
    (this._cmds || []).forEach((c) => { try { c.remove(); } catch (e) {} });
    this._cmds = [];
    try { this._mainObserver && this._mainObserver.disconnect(); } catch (e) {}
    document.querySelectorAll("#pdfhl-main-style").forEach((n) => n.remove());
    document.querySelectorAll("iframe.id--pdf-viewer").forEach((fr) => {
      try {
        const d = fr.contentDocument;
        if (!d) return;
        if (d.__pdfhlTeardown) { try { d.__pdfhlTeardown(); } catch (e) {} }
        d.querySelectorAll(".pdfhl-toolbar, .pdfhl-overlay, .pdfhl-marquee, .pdfhl-menu, #pdfhl-style").forEach((n) => n.remove());
        d.__pdfhlTeardown = null;
      } catch (e) {}
    });
    // Terminate the OCR worker so hot-reload doesn't leak workers.
    try {
      if (this._ocrWorkerPromise) {
        this._ocrWorkerPromise.then((w) => { try { w && w.terminate && w.terminate(); } catch (e) {} }, () => {});
        this._ocrWorkerPromise = null;
      }
    } catch (e) {}
  }

  // =======================================================================
  // Viewer discovery
  // =======================================================================
  _installViewerObserver() {
    const obs = new MutationObserver(() => this._scanForViewers());
    obs.observe(document.body, { childList: true, subtree: true });
    this._mainObserver = obs;
  }

  _scanForViewers() {
    document.querySelectorAll("iframe.id--pdf-viewer").forEach((iframe) => {
      if (this._hooked.has(iframe)) return;
      this._hooked.add(iframe);
      const hookNow = () => this._whenViewerReady(iframe)
        .then((app) => this._hookViewer(iframe, app))
        .catch(() => {});
      // The pdf.js iframe replaces its document when a (different) PDF loads —
      // re-hook on each load so listeners + styles land on the live document.
      const onLoad = () => hookNow();
      iframe.addEventListener("load", onLoad);
      this._cleanups.push(() => { try { iframe.removeEventListener("load", onLoad); } catch (e) {} });
      hookNow();
    });
  }

  _whenViewerReady(iframe) {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const tick = () => {
        if (!iframe.isConnected) return reject(new Error("iframe gone"));
        const win = iframe.contentWindow;
        const app = win && win.PDFViewerApplication;
        if (app && app.pdfDocument && app.pdfViewer) return resolve(app);
        if (++tries > 200) return reject(new Error("viewer not ready"));
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  // =======================================================================
  // Per-viewer wiring
  // =======================================================================
  _hookViewer(iframe, app) {
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    if (!doc) return;
    if (doc.__pdfhlTeardown) { try { doc.__pdfhlTeardown(); } catch (e) {} } // drop any stale wiring on this doc first
    const fingerprint = (app.pdfDocument.fingerprints || [])[0] || "unknown";
    const hook = { iframe, win, doc, app, fingerprint, toolbar: null, overlays: new Map(), marquee: null, _pendingRegion: null };

    this._injectViewerCSS(doc);

    // Selection -> toolbar (positioned above the selection). On an image-only
    // (scanned) page there's nothing to select, so a drag instead draws an OCR
    // marquee that finalizes into the same colour toolbar.
    const onMouseUp = (e) => {
      if (hook.marquee && hook.marquee.active) { this._finishMarquee(hook, e); return; }
      setTimeout(() => this._onSelectionSettled(hook), 0);
    };
    const onSelDown = (e) => {
      if (e.target.closest && (e.target.closest(".pdfhl-toolbar") || e.target.closest(".pdfhl-menu"))) return;
      this._hideToolbar(hook);
      this._closeHighlightMenu(hook); // any click outside the menu dismisses it
      if (e.button !== 0) return;
      const pageEl = e.target.closest && e.target.closest(".page");
      if (pageEl && this._isScannedPage(pageEl)) this._startMarquee(hook, pageEl, e);
    };
    const onScroll = () => { this._hideToolbar(hook); this._closeHighlightMenu(hook); };
    // Right-click a highlight -> context menu (change colour / delete). Replaces the
    // old hover ✕, which sat outside the highlight and vanished as you reached for it.
    const onCtx = (e) => {
      const box = this._boxAtPoint(hook, e.clientX, e.clientY);
      if (!box) return; // not on a highlight — let the native context menu through
      e.preventDefault(); e.stopPropagation();
      this._showHighlightMenu(hook, box.dataset.hid, e.clientX, e.clientY);
    };
    const onMove = (e) => {
      if (hook.marquee && hook.marquee.active) this._updateMarquee(hook, e);
    };
    doc.addEventListener("mouseup", onMouseUp, true);
    doc.addEventListener("mousedown", onSelDown, true);
    doc.addEventListener("scroll", onScroll, true);
    doc.addEventListener("mousemove", onMove, true);
    doc.addEventListener("contextmenu", onCtx, true);

    // Redraw stored overlays as pages (re)render. textlayerrendered fires after
    // pagerendered, once the text layer (our positioning reference) exists.
    const onRendered = () => this._rebuildFromNote(hook);
    try { app.eventBus.on("textlayerrendered", onRendered); } catch (e) {}
    try { app.eventBus.on("pagerendered", onRendered); } catch (e) {}
    try { app.eventBus.on("pagesloaded", onRendered); } catch (e) {}

    // BULLETPROOF redraw: watch the viewer DOM and redraw whenever a text layer
    // appears. This is timing-independent — it catches a cold reload (where the
    // eventBus may fire before we hook, or the env renders slowly), scroll and zoom.
    let redrawScheduled = false;
    const scheduleRedraw = () => { if (redrawScheduled) return; redrawScheduled = true; setTimeout(() => { redrawScheduled = false; this._rebuildFromNote(hook); }, 60); };
    const tlObserver = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType === 1 && ((n.classList && n.classList.contains("textLayer")) || (n.querySelector && n.querySelector(".textLayer")))) { scheduleRedraw(); return; }
      }
    });
    try { tlObserver.observe(doc.querySelector("#viewer") || doc.body, { childList: true, subtree: true }); } catch (e) {}

    const teardown = () => {
      try { doc.removeEventListener("mouseup", onMouseUp, true); } catch (e) {}
      try { doc.removeEventListener("mousedown", onSelDown, true); } catch (e) {}
      try { doc.removeEventListener("scroll", onScroll, true); } catch (e) {}
      try { doc.removeEventListener("mousemove", onMove, true); } catch (e) {}
      try { doc.removeEventListener("contextmenu", onCtx, true); } catch (e) {}
      try { this._closeHighlightMenu(hook); } catch (e) {}
      try { app.eventBus.off("textlayerrendered", onRendered); } catch (e) {}
      try { app.eventBus.off("pagerendered", onRendered); } catch (e) {}
      try { app.eventBus.off("pagesloaded", onRendered); } catch (e) {}
      try { tlObserver.disconnect(); } catch (e) {}
      try { this._cancelMarquee(hook); } catch (e) {}
      try { if (hook.toolbar) hook.toolbar.remove(); } catch (e) {}
      try { doc.querySelectorAll(".pdfhl-overlay").forEach((n) => n.remove()); } catch (e) {}
      hook.toolbar = null;
      doc.__pdfhlTeardown = null;
    };
    doc.__pdfhlTeardown = teardown;
    this._cleanups.push(teardown);

    // If the iframe is removed, tear down.
    const gone = new MutationObserver(() => { if (!iframe.isConnected) { teardown(); gone.disconnect(); } });
    gone.observe(document.body, { childList: true, subtree: true });

    // Initial overlay draw + a few delayed retries to catch pages that finished
    // rendering right around the moment we hooked (cold reload / restored page).
    // NOTE: do NOT prune the store on load — it races the note's line-items loading
    // (and can run when the PDF is open without its note beside it), which would
    // wrongly wipe persisted highlights. Deletion is handled by the in-PDF ✕ instead.
    this._redrawOverlays(hook);
    this._rebuildFromNote(hook); // re-derive overlays from the durable note text
    setTimeout(() => this._rebuildFromNote(hook), 700);
    setTimeout(() => this._rebuildFromNote(hook), 2000);
  }

  // =======================================================================
  // Selection -> floating colour toolbar
  // =======================================================================
  _onSelectionSettled(hook) {
    const sel = hook.win.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { this._hideToolbar(hook); return; }
    const range = sel.getRangeAt(0);
    // Selection must be inside a text layer.
    const anchorEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    if (!anchorEl || !anchorEl.closest(".textLayer")) { this._hideToolbar(hook); return; }
    const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
    if (!rects.length) { this._hideToolbar(hook); return; }

    this._pendingRange = range.cloneRange();
    this._activeHook = hook;
    hook._pendingRegion = null; // this toolbar is for a text selection, not OCR
    // Bounding box of the selection → toolbar sits centred just above its top.
    let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
    for (const r of rects) { if (r.top < top) top = r.top; if (r.bottom > bottom) bottom = r.bottom; if (r.left < left) left = r.left; if (r.right > right) right = r.right; }
    this._showToolbar(hook, (left + right) / 2, top, bottom);
  }

  _showToolbar(hook, centerX, selTop, selBottom) {
    let tb = hook.toolbar;
    if (!tb) {
      tb = hook.doc.createElement("div");
      tb.className = "pdfhl-toolbar";
      for (const c of this.COLORS) {
        const sw = hook.doc.createElement("button");
        sw.className = "pdfhl-swatch";
        sw.title = "Highlight → extract (" + c.label + ")";
        sw.style.background = "rgb(" + c.rgb + ")";
        sw.addEventListener("mousedown", (e) => e.preventDefault()); // keep selection
        sw.addEventListener("click", (e) => {
          e.preventDefault(); e.stopPropagation();
          if (hook._pendingRegion) this._extractOCR(hook, c);
          else this._extract(hook, c);
        });
        tb.appendChild(sw);
      }
      hook.doc.body.appendChild(tb);
      hook.toolbar = tb;
    }
    // Centre above the selection; drop below it only if there's no room above.
    const pad = 8, H = 34, W = 5 * 26 + 22;
    let left = centerX - W / 2;
    left = Math.max(pad, Math.min(left, hook.win.innerWidth - W - pad));
    let top = selTop - H - 8;
    if (top < pad) top = selBottom + 8;
    top = Math.max(pad, Math.min(top, hook.win.innerHeight - H - pad));
    tb.style.top = top + "px";
    tb.style.left = left + "px";
    tb.style.display = "flex";
  }

  _hideToolbar(hook) {
    if (hook && hook.toolbar) hook.toolbar.style.display = "none";
  }

  // =======================================================================
  // Extraction
  // =======================================================================
  async _extract(hook, color) {
    const range = this._pendingRange;
    if (!range) return;
    const data = this._extractStructured(hook, range);
    if (!data || !data.paragraphs.length) {
      this.ui.addToaster({ title: "Nothing to extract", message: "Select some text in the PDF first.", dismissible: true, autoDestroyTime: 2500 });
      return;
    }
    const note = this._findAssociatedNote(hook.iframe);
    if (!note) {
      this.ui.addToaster({ title: "No note found", message: "Open the PDF beside its note, then highlight.", dismissible: true });
      return;
    }
    await this._commitExtract(hook, note, { paragraphs: data.paragraphs, page: data.page, color, rectsByPage: data.rectsByPage });
    // Clear selection + toolbar.
    try { hook.win.getSelection().removeAllRanges(); } catch (e) {}
    this._hideToolbar(hook);
    this._pendingRange = null;
  }

  // Write an extract into the note as a Thymer QUOTE BLOCK: a "block" line
  // (blockStyle "quote") whose paragraphs are "text" children, with the backlink
  // arrow ("p.N" link + ti-arrow-up-right icon) at the end of the last paragraph.
  // Shared by the text-selection and OCR paths. For OCR, `ocrRect` is the marquee
  // rectangle (normalised) — it's encoded in the backlink so the overlay is fully
  // reconstructable from the note alone (a scanned page has no text layer to match).
  async _commitExtract(hook, note, { paragraphs, page, color, rectsByPage, ocrRect }) {
    const quote = paragraphs.join("\n\n");
    const hid = "h" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    const fileGuid = this._currentFileGuid(hook);
    let backlink = "https://" + this.BACKLINK_HOST + "/open?pdf=" + encodeURIComponent(hook.fingerprint) +
      "&page=" + page + "&color=" + color.key + "&file=" + encodeURIComponent(fileGuid || "") + "&hid=" + hid;
    if (ocrRect) backlink += "&ocr=1&rect=" + [ocrRect.x, ocrRect.y, ocrRect.w, ocrRect.h].map((n) => Number(n).toFixed(4)).join(",");

    let loc;
    try { loc = await this._highlightsParent(note); }
    catch (e) { loc = { parentItem: null, after: null }; }

    let block = null;
    try {
      block = await note.createLineItem(loc.parentItem, loc.after, "block");
      if (!block) throw new Error("createLineItem returned null");
      try { block.setBlockStyle("quote"); } catch (e) {}
      let prev = null;
      for (let i = 0; i < paragraphs.length; i++) {
        const p = await note.createLineItem(block, prev, "text");
        if (!p) continue;
        const isLast = i === paragraphs.length - 1;
        const segs = [{ type: "text", text: paragraphs[i] + (isLast ? "  " : "") }];
        if (isLast) {
          segs.push({ type: "linkobj", text: { link: backlink, title: "p." + page } });
          segs.push({ type: "icon", text: "ti-arrow-up-right" });
        }
        p.setSegments(segs);
        prev = p;
      }
    } catch (e) {
      this.ui.addToaster({ title: "Couldn't write extract", message: String(e.message || e), dismissible: true });
      return false;
    }

    const firstGuid = (block && (block.guid || (block._getRow && block._getRow().guid))) || null;
    this._saveHighlight(hook.fingerprint, { hid, page, color: color.key, rectsByPage, quote, lineGuid: firstGuid });
    this._redrawOverlays(hook);
    this.ui.addToaster({
      title: "Extracted to note", message: "p." + page + " → " + note.getName(),
      dismissible: true, autoDestroyTime: 2200,
    });
    return true;
  }

  // =======================================================================
  // OCR fallback (scanned pages): drag a marquee -> crop -> Tesseract -> extract
  // =======================================================================
  // A page is "scanned" (needs OCR) if its text layer rendered with ~no text.
  _isScannedPage(pageEl) {
    try {
      if (!pageEl.querySelector("canvas")) return false;
      const tl = pageEl.querySelector(".textLayer");
      if (!tl) return false; // text layer not built yet — don't hijack the drag
      const txt = (tl.textContent || "").replace(/\s+/g, "");
      return txt.length < 8;
    } catch (e) { return false; }
  }

  _startMarquee(hook, pageEl, e) {
    e.preventDefault();
    const el = hook.doc.createElement("div");
    el.className = "pdfhl-marquee";
    hook.doc.body.appendChild(el);
    hook.marquee = { active: true, pageEl, startX: e.clientX, startY: e.clientY, el };
    this._updateMarquee(hook, e);
  }

  _updateMarquee(hook, e) {
    const m = hook.marquee; if (!m) return;
    const x = Math.min(m.startX, e.clientX), y = Math.min(m.startY, e.clientY);
    m.el.style.left = x + "px"; m.el.style.top = y + "px";
    m.el.style.width = Math.abs(e.clientX - m.startX) + "px";
    m.el.style.height = Math.abs(e.clientY - m.startY) + "px";
  }

  _cancelMarquee(hook) {
    if (hook && hook.marquee) { try { hook.marquee.el && hook.marquee.el.remove(); } catch (e) {} hook.marquee = null; }
  }

  _finishMarquee(hook, e) {
    const m = hook.marquee; if (!m) return;
    const pageEl = m.pageEl;
    const left = Math.min(m.startX, e.clientX), top = Math.min(m.startY, e.clientY);
    const right = Math.max(m.startX, e.clientX), bottom = Math.max(m.startY, e.clientY);
    this._cancelMarquee(hook);
    if (right - left < 8 || bottom - top < 8) { this._hideToolbar(hook); return; } // a click, not a drag
    // Normalise against the text layer box (== canvas == page content box).
    const ref = (pageEl.querySelector(".textLayer") || pageEl.querySelector("canvas")).getBoundingClientRect();
    if (!ref.width || !ref.height) { this._hideToolbar(hook); return; }
    const clamp = (v) => Math.max(0, Math.min(1, v));
    const x = clamp((left - ref.left) / ref.width), y = clamp((top - ref.top) / ref.height);
    const x2 = clamp((right - ref.left) / ref.width), y2 = clamp((bottom - ref.top) / ref.height);
    const rect = { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
    if (rect.w < 0.01 || rect.h < 0.01) { this._hideToolbar(hook); return; }
    const page = parseInt(pageEl.getAttribute("data-page-number"), 10) || this._currentPage(hook);
    hook._pendingRegion = { page, rect };
    this._pendingRange = null;
    this._showToolbar(hook, (left + right) / 2, top, bottom);
  }

  async _extractOCR(hook, color) {
    const region = hook._pendingRegion;
    if (!region) return;
    const note = this._findAssociatedNote(hook.iframe);
    if (!note) {
      this.ui.addToaster({ title: "No note found", message: "Open the PDF beside its note, then highlight.", dismissible: true });
      return;
    }
    this._hideToolbar(hook);
    const lang = this.OCR_LANGUAGES.find((x) => x.code === this._ocrLang);
    const prog = this.ui.addToaster({ title: "Running OCR…", message: "Reading " + (lang ? lang.label : "text") + " from the highlighted region.", dismissible: false });
    let text = "";
    try {
      text = await this._ocrRegion(hook, region.page, region.rect);
    } catch (e) {
      try { prog && prog.destroy(); } catch (_) {}
      this.ui.addToaster({ title: "OCR failed", message: String((e && e.message) || e), dismissible: true });
      hook._pendingRegion = null;
      return;
    }
    try { prog && prog.destroy(); } catch (_) {}
    const paragraphs = this._ocrTextToParagraphs(text);
    if (!paragraphs.length) {
      this.ui.addToaster({ title: "No text found", message: "OCR didn't find readable text in that region.", dismissible: true, autoDestroyTime: 2800 });
      hook._pendingRegion = null;
      return;
    }
    const rectsByPage = {}; rectsByPage[region.page] = [region.rect];
    await this._commitExtract(hook, note, { paragraphs, page: region.page, color, rectsByPage, ocrRect: region.rect });
    hook._pendingRegion = null;
  }

  async _ocrRegion(hook, page, rect) {
    const canvas = await this._renderRegionCanvas(hook, page, rect);
    if (!canvas) throw new Error("Couldn't capture that region.");
    const worker = await this._ensureOcrWorker();
    const res = await worker.recognize(canvas);
    return (res && res.data && res.data.text) || "";
  }

  // Build an OCR-quality bitmap of the region. Preferred: re-render the page region
  // at ~300 DPI via pdf.js (cheap for a visible page — its image is already decoded —
  // and independent of the user's zoom). Fallback: crop the already-rendered page
  // canvas at full backing-store resolution.
  async _renderRegionCanvas(hook, pageNum, nr) {
    const pageEl = [...hook.doc.querySelectorAll(".page")].find((p) => parseInt(p.getAttribute("data-page-number"), 10) === pageNum);
    const src = pageEl && pageEl.querySelector("canvas");
    try {
      const page = await hook.app.pdfDocument.getPage(pageNum);
      const unit = page.getViewport({ scale: 1 });
      const curScale = src ? src.width / unit.width : 1;
      let scale = Math.min(this.OCR_MAX_SCALE, Math.max(curScale, this.OCR_TARGET_W / unit.width));
      let vp = page.getViewport({ scale });
      const longest = Math.max(nr.w * vp.width, nr.h * vp.height);
      if (longest > this.OCR_MAX_DIM) { scale *= this.OCR_MAX_DIM / longest; vp = page.getViewport({ scale }); }
      const rx = nr.x * vp.width, ry = nr.y * vp.height;
      const rw = Math.round(nr.w * vp.width), rh = Math.round(nr.h * vp.height);
      if (rw >= 1 && rh >= 1) {
        const out = document.createElement("canvas");
        out.width = rw; out.height = rh;
        const task = page.render({ canvasContext: out.getContext("2d"), viewport: vp, transform: [1, 0, 0, 1, -rx, -ry] });
        await this._withTimeout(task.promise, 20000);
        return out;
      }
    } catch (e) { /* fall back to existing-canvas crop */ }
    if (src) {
      const sx = Math.round(nr.x * src.width), sy = Math.round(nr.y * src.height);
      const sw = Math.max(1, Math.round(nr.w * src.width)), sh = Math.max(1, Math.round(nr.h * src.height));
      const out = document.createElement("canvas");
      out.width = sw; out.height = sh;
      out.getContext("2d").drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
      return out;
    }
    return null;
  }

  _withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out.")), ms))]);
  }

  // Lazy-load tesseract.js from the CDN (script load works; the renderer has no CSP)
  // and create one reusable worker. Re-armable: a failed init clears the promise.
  _ensureOcrWorker() {
    if (this._ocrWorkerPromise) return this._ocrWorkerPromise;
    this._ocrWorkerPromise = (async () => {
      if (!window.Tesseract) {
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = this.TESSERACT_CDN;
          s.onload = resolve;
          s.onerror = () => reject(new Error("Couldn't load the OCR engine (check your connection)."));
          document.head.appendChild(s);
        });
      }
      if (!window.Tesseract) throw new Error("OCR engine unavailable.");
      return await window.Tesseract.createWorker(this._ocrLang || "eng", 1);
    })();
    this._ocrWorkerPromise.catch(() => { this._ocrWorkerPromise = null; });
    return this._ocrWorkerPromise;
  }

  // OCR text -> paragraphs: split on blank lines, collapse intra-paragraph line
  // breaks to spaces, de-hyphenate wrapped words.
  _ocrTextToParagraphs(text) {
    if (!text) return [];
    return text.replace(/\r/g, "")
      .split(/\n[ \t]*\n+/)
      .map((para) => para.split("\n").map((l) => l.trim()).filter(Boolean).reduce((acc, line) => {
        if (!acc) return line;
        if (/[‐-―-]$/.test(acc) && /^[a-zà-ÿ]/.test(line)) return acc.replace(/[‐-―-]$/, "") + line;
        return acc + " " + line;
      }, ""))
      .map((p) => p.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  // Set the active OCR language (from a per-language command-palette command).
  _setOcrLang(code) {
    const L = this.OCR_LANGUAGES.find((x) => x.code === code);
    if (code !== this._ocrLang) {
      this._ocrLang = code;
      // Persist alongside the highlight store (don't clobber it).
      try {
        const conf = this.getConfiguration();
        conf.custom = conf.custom || {};
        conf.custom.ocrLang = code;
        const mine = (this.data.getAllGlobalPlugins() || []).find((g) => g.guid === this.getGuid());
        if (mine && typeof mine.saveConfiguration === "function") mine.saveConfiguration(conf);
      } catch (e) {}
      // Drop the worker so the next OCR initialises with the new language (loaded on demand).
      try {
        if (this._ocrWorkerPromise) {
          this._ocrWorkerPromise.then((w) => { try { w && w.terminate && w.terminate(); } catch (e) {} }, () => {});
          this._ocrWorkerPromise = null;
        }
      } catch (e) {}
    }
    this.ui.addToaster({ title: "OCR language", message: (L ? L.label : code) + " — used when you OCR a scanned page.", dismissible: true, autoDestroyTime: 2600 });
  }

  // Reconstruct multi-line / multi-paragraph text from text-layer geometry,
  // and collect normalised highlight rects per page.
  _extractStructured(hook, range) {
    const doc = hook.doc;
    // Collect text-layer spans GEOMETRICALLY (those whose centre falls inside the
    // selection's client rects) rather than by DOM order — pdf.js text spans aren't
    // always in reading order, which otherwise drops words (e.g. on bulleted lines).
    const selRects = (range.getClientRects ? [...range.getClientRects()] : []).filter((r) => r.width > 0.5);
    const inSel = (r) => { const h = r.height || 8; const cx = r.left + r.width / 2, cy = r.top + h / 2; return selRects.some((s) => cx >= s.left - 1 && cx <= s.right + 1 && cy >= s.top - 3 && cy <= s.bottom + 3); };
    const spans = [];
    doc.querySelectorAll(".page").forEach((pageEl) => {
      const pageNum = parseInt(pageEl.getAttribute("data-page-number"), 10);
      pageEl.querySelectorAll(".textLayer span").forEach((span) => {
        if (!span.firstChild) return;
        const r = span.getBoundingClientRect();
        if (!r.width) return;
        // Union of geometric-in-selection AND DOM-range intersection: geometric
        // catches out-of-DOM-order spans (bullets); intersectsNode catches the
        // height-0 heading spans the geometry misses. Neither alone is enough.
        if (!inSel(r) && !range.intersectsNode(span)) return;
        spans.push({ pageNum, text: span.textContent, top: r.top, bottom: r.bottom || (r.top + 8), left: r.left, right: r.right, height: r.height || 8 });
      });
    });
    if (!spans.length) {
      const t = range.toString().replace(/\s+/g, " ").trim();
      return t ? { page: this._currentPage(hook), paragraphs: [t], rectsByPage: {} } : null;
    }

    // The dominant page = the one with the most selected spans.
    const pageCounts = {};
    spans.forEach((s) => { pageCounts[s.pageNum] = (pageCounts[s.pageNum] || 0) + 1; });
    const page = parseInt(Object.keys(pageCounts).sort((a, b) => pageCounts[b] - pageCounts[a])[0], 10);

    // Sort reading order.
    spans.sort((a, b) => (a.pageNum - b.pageNum) || (a.top - b.top) || (a.left - b.left));

    // Group into lines by vertical proximity.
    const lines = [];
    let cur = null;
    const medianH = spans.map((s) => s.height).sort((a, b) => a - b)[Math.floor(spans.length / 2)] || 10;
    for (const s of spans) {
      if (cur && s.pageNum === cur.pageNum && Math.abs(s.top - cur.top) < medianH * 0.6) {
        cur.text += s.text;
        cur.bottom = Math.max(cur.bottom, s.bottom);
        cur.left = Math.min(cur.left, s.left);
        cur.right = Math.max(cur.right, s.right);
      } else {
        cur = { pageNum: s.pageNum, top: s.top, bottom: s.bottom, left: s.left, right: s.right, text: s.text };
        lines.push(cur);
      }
    }

    // Join lines into paragraphs using vertical gaps; de-hyphenate line breaks.
    const gaps = [];
    for (let i = 1; i < lines.length; i++) gaps.push(lines[i].top - lines[i - 1].bottom);
    const sortedGaps = gaps.slice().sort((a, b) => a - b);
    const medianGap = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length / 2)] : 0;
    // Right margin of the selected text block. A line that ENDS well short of it is
    // a paragraph/heading end → the next line starts a new line (so a short heading
    // like "Progressive Disclosure" doesn't merge with the body line beneath it),
    // while genuinely wrapped lines (which reach the margin) keep flowing together.
    const maxRight = Math.max.apply(null, lines.map((l) => l.right));
    const minLeft = Math.min.apply(null, lines.map((l) => l.left));
    const shortThresh = (maxRight - minLeft) * 0.12;

    // A line starting with a bullet/number marker always begins a new line.
    const BULLET = /^\s*([•·●▪‣◦∙*]|[-–—]\s|\d+[.)])\s*/;
    let paragraphs = [];
    let buf = (lines[0] ? lines[0].text : "").trim();
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1], cur2 = lines[i];
      const gap = cur2.top - prev.bottom;
      const line = cur2.text.trim();
      const isBullet = BULLET.test(line);
      const prevEndedShort = (maxRight - prev.right) > shortThresh;
      const newPara = cur2.pageNum !== prev.pageNum || isBullet || prevEndedShort || gap > medianGap * 1.8 + 2;
      if (newPara) { paragraphs.push(buf); buf = line; }
      else if (/[‐-―-]$/.test(buf) && /^[a-zÀ-ɏ]/.test(line)) buf = buf.replace(/[‐-―-]$/, "") + line;
      else buf = buf + " " + line;
    }
    if (buf.trim()) paragraphs.push(buf);
    paragraphs = paragraphs.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);

    // Highlight rects come from the SELECTION's own client rectangles (exact,
    // line-by-line) rather than per-span boxes — far better alignment + coverage.
    const rectsByPage = this._selectionRects(doc, range);

    return { page, paragraphs, rectsByPage };
  }

  // Normalised highlight rects from the selection's client rects, measured against
  // the TEXT LAYER (not the .page — pdf.js pages have a border that offsets the text).
  _selectionRects(doc, range) {
    const pages = [...doc.querySelectorAll(".page")].map((pe) => {
      const tl = pe.querySelector(".textLayer");
      return { num: parseInt(pe.getAttribute("data-page-number"), 10), ref: (tl || pe).getBoundingClientRect() };
    });
    const byPage = {};
    const rects = range.getClientRects ? range.getClientRects() : [];
    for (const cr of rects) {
      if (cr.width < 0.5 || cr.height < 0.5) continue;
      const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
      const pg = pages.find((p) => p.ref.width && cx >= p.ref.left && cx <= p.ref.right && cy >= p.ref.top && cy <= p.ref.bottom);
      if (!pg) continue;
      const x = (cr.left - pg.ref.left) / pg.ref.width;
      const y = (cr.top - pg.ref.top) / pg.ref.height;
      const w = cr.width / pg.ref.width;
      const h = cr.height / pg.ref.height;
      if (w <= 0 || h <= 0 || w > 0.99 || h > 0.2) continue; // skip bogus oversized rects (page tint)
      (byPage[pg.num] = byPage[pg.num] || []).push({ x, y, w, h });
    }
    return byPage;
  }

  _currentPage(hook) { try { return hook.app.page || 1; } catch (e) { return 1; } }

  // Append target: the last TOP-LEVEL content line, by sibling order index (oind).
  // Top-level items are those whose parent (pguid) is the record root, i.e. not another
  // line item in the list. createLineItem(null, anchor) only honours `anchor` when it is a
  // genuine top-level sibling. Trailing structural "document" nodes are skipped.
  async _lastContentItem(note) {
    try {
      const items = (await note.getLineItems()) || [];
      const rows = items.map((li) => ({ li, row: (li._getItem && li._getItem()) || {} }));
      const guids = new Set(rows.map((x) => x.row.guid).filter(Boolean));
      const tops = rows
        .filter((x) => x.row.pguid && !guids.has(x.row.pguid) && x.row.type !== "document")
        .sort((a, b) => (a.row.oind || 0) - (b.row.oind || 0));
      return tops.length ? tops[tops.length - 1].li : null;
    } catch (e) { return null; }
  }

  // The fileguid (blob root id) of the PDF open in the panel that holds this iframe.
  _currentFileGuid(hook) {
    try {
      const bp = this.ui.getPanels().find((p) => { try { return p.getElement() && p.getElement().contains(hook.iframe); } catch (e) { return false; } });
      const nav = bp && bp.getNavigation();
      if (nav && nav.rootId) return nav.rootId;
    } catch (e) {}
    return null;
  }

  _isHighlightsHeading(li) {
    try { const it = li._getItem && li._getItem(); if (it && it.kv && it.kv.pdfhl_heading) return true; } catch (e) {}
    try { return (li.segments || []).map((s) => (typeof s.text === "string" ? s.text : "")).join("").trim().toLowerCase() === "highlights"; } catch (e) { return false; }
  }

  // Find-or-create the "Highlights" heading; return where to insert the next extract
  // (as the last child of that heading).
  async _highlightsParent(note) {
    try {
      const items = (await note.getLineItems()) || [];
      const rows = items.map((li) => ({ li, row: (li._getItem && li._getItem()) || {} }));
      let heading = rows.find((x) => x.row.type === "heading" && this._isHighlightsHeading(x.li));
      if (!heading) {
        const after = await this._lastContentItem(note);
        const h = await note.createLineItem(null, after, "heading");
        if (h) {
          h.setSegments([{ type: "text", text: "Highlights" }]);
          try { h.setMetaProperties({ pdfhl_heading: 1 }); } catch (e) {}
          return { parentItem: h, after: null };
        }
        return { parentItem: null, after: after };
      }
      const hg = heading.row.guid;
      const kids = rows.filter((x) => x.row.pguid === hg).sort((a, b) => (a.row.oind || 0) - (b.row.oind || 0));
      return { parentItem: heading.li, after: kids.length ? kids[kids.length - 1].li : null };
    } catch (e) {
      return { parentItem: null, after: null };
    }
  }

  _findAssociatedNote(iframe) {
    const panels = this.ui.getPanels();
    const info = panels.map((p, i) => {
      let type = null, el = null, rec = null;
      try { type = p.getType(); } catch (e) {}
      try { el = p.getElement(); } catch (e) {}
      try { rec = p.getActiveRecord(); } catch (e) {}
      return { i, type, el, rec };
    });
    let blobIdx = info.findIndex((x) => x.el && x.el.contains(iframe));
    const notes = info.filter((x) => x.type === "edit_panel" && x.rec);
    if (!notes.length) return null;
    if (blobIdx < 0) return notes[0].rec;
    notes.sort((a, b) => Math.abs(a.i - blobIdx) - Math.abs(b.i - blobIdx));
    return notes[0].rec;
  }

  // =======================================================================
  // Backlink: arrow click -> jump to page + find passage
  // =======================================================================
  _installBacklinkClickHandler() {
    const matchHref = (t) => {
      if (!t || !t.closest) return null;
      // the pdfhl link itself
      const a = t.closest("a[href]");
      if (a) { const href = a.href || a.getAttribute("href") || ""; if (href.indexOf(this.BACKLINK_HOST) !== -1) return href; }
      // the arrow icon rendered immediately after the pdfhl link — treat as part of it
      const ic = t.closest(".lineitem-icon");
      if (ic) {
        const prev = ic.previousElementSibling;
        if (prev && prev.matches && prev.matches("a.lineitem-linkobj")) {
          const href = prev.href || prev.getAttribute("href") || "";
          if (href.indexOf(this.BACKLINK_HOST) !== -1) return href;
        }
      }
      return null;
    };
    const onClick = (e) => {
      const href = matchHref(e.target);
      if (!href) return;
      e.preventDefault(); e.stopImmediatePropagation();
      let page = 1, file = "", pdf = "", hid = "";
      try {
        const u = new URL(href);
        page = parseInt(u.searchParams.get("page"), 10) || 1;
        file = u.searchParams.get("file") || "";
        pdf = u.searchParams.get("pdf") || "";
        hid = u.searchParams.get("hid") || "";
      } catch (err) {}
      this._openAndJump({ page, file, pdf, hid });
    };
    // Block Thymer's own pointer/mouse handling for our sentinel links so it
    // never tries to open the URL externally; `click` still fires and does the jump.
    const block = (e) => { if (matchHref(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); } };
    window.addEventListener("click", onClick, true);
    window.addEventListener("auxclick", onClick, true);
    window.addEventListener("mousedown", block, true);
    window.addEventListener("pointerdown", block, true);
    this._cleanups.push(() => {
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("auxclick", onClick, true);
      window.removeEventListener("mousedown", block, true);
      window.removeEventListener("pointerdown", block, true);
    });
  }

  _findOpenViewerApp(fingerprint) {
    const frames = [...document.querySelectorAll("iframe.id--pdf-viewer")];
    for (const fr of frames) {
      const a = fr.contentWindow && fr.contentWindow.PDFViewerApplication;
      if (a && a.pdfDocument && fingerprint && (a.pdfDocument.fingerprints || [])[0] === fingerprint) return a;
    }
    for (const fr of frames) {
      const a = fr.contentWindow && fr.contentWindow.PDFViewerApplication;
      if (a && a.pdfDocument) return a;
    }
    return null;
  }

  async _openPdfPanel(fileGuid, fingerprint) {
    try {
      const ws = this.getWorkspaceGuid();
      let panel = this.ui.getPanels().find((p) => { try { return p.getType() === "blob_preview"; } catch (e) { return false; } });
      if (!panel) panel = await this.ui.createPanel();
      if (!panel) return null;
      panel.navigateTo({ type: "blob_preview", rootId: fileGuid, subId: null, workspaceGuid: ws, state: { contentType: "application/pdf" } });
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const a = this._findOpenViewerApp(fingerprint);
        if (a) return a;
      }
    } catch (e) {}
    return null;
  }

  async _openAndJump({ page, file, pdf, hid }) {
    let app = this._findOpenViewerApp(pdf);
    if ((!app || (pdf && (app.pdfDocument.fingerprints || [])[0] !== pdf)) && file) {
      app = await this._openPdfPanel(file, pdf);
    }
    if (!app) {
      this.ui.addToaster({ title: "Couldn't open the PDF", message: "The attached PDF couldn't be located.", dismissible: true });
      return;
    }
    try { app.page = page; } catch (e) {}
    // Scroll to + briefly pulse the existing coloured overlay. No pdf.js find,
    // so there's no clashing highlight, and it re-runs reliably on every click.
    this._revealHighlight(app, hid);
  }

  _revealHighlight(app, hid) {
    if (!hid) return;
    const fr = [...document.querySelectorAll("iframe.id--pdf-viewer")].find((f) => f.contentWindow && f.contentWindow.PDFViewerApplication === app);
    const d = fr && fr.contentDocument;
    if (!d) return;
    let n = 0;
    const tick = () => {
      const boxes = [...d.querySelectorAll('.pdfhl-box[data-hid="' + (window.CSS && CSS.escape ? CSS.escape(hid) : hid) + '"]')];
      if (boxes.length) {
        boxes[0].scrollIntoView({ block: "center", behavior: "smooth" });
        boxes.forEach((b) => { b.classList.remove("pdfhl-pulse"); void b.offsetWidth; b.classList.add("pdfhl-pulse"); });
        return;
      }
      if (++n <= 40) setTimeout(tick, 100);
    };
    tick();
  }

  // The highlight box (if any) under a point in the viewer's client coords.
  _boxAtPoint(hook, x, y) {
    for (const b of hook.doc.querySelectorAll(".pdfhl-box")) {
      const r = b.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return b;
    }
    return null;
  }

  // Right-click menu for a highlight: a row of colour swatches (change colour) + Delete.
  _showHighlightMenu(hook, hid, x, y) {
    this._closeHighlightMenu(hook);
    const doc = hook.doc;
    const hl = (this._getStore()[hook.fingerprint] || []).find((h) => h.hid === hid);
    const curColor = hl ? hl.color : null;
    const menu = doc.createElement("div");
    menu.className = "pdfhl-menu";
    const row = doc.createElement("div");
    row.className = "pdfhl-menu-swatches";
    for (const c of this.COLORS) {
      const sw = doc.createElement("button");
      sw.className = "pdfhl-swatch" + (c.key === curColor ? " pdfhl-swatch-current" : "");
      sw.style.background = "rgb(" + c.rgb + ")";
      sw.title = c.label;
      sw.addEventListener("mousedown", (e) => e.preventDefault());
      sw.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); this._closeHighlightMenu(hook); this._changeHighlightColor(hook, hid, c.key); });
      row.appendChild(sw);
    }
    menu.appendChild(row);
    const del = doc.createElement("div");
    del.className = "pdfhl-menu-item pdfhl-menu-delete";
    del.textContent = "Delete highlight";
    del.addEventListener("mousedown", (e) => e.preventDefault());
    del.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); this._closeHighlightMenu(hook); this._deleteHighlight(hook, hid); });
    menu.appendChild(del);
    doc.body.appendChild(menu);
    // Position at the cursor, clamped to the viewport.
    const pad = 8, W = menu.offsetWidth || 160, H = menu.offsetHeight || 84;
    menu.style.left = Math.max(pad, Math.min(x, hook.win.innerWidth - W - pad)) + "px";
    menu.style.top = Math.max(pad, Math.min(y, hook.win.innerHeight - H - pad)) + "px";
    hook._menu = menu;
  }

  _closeHighlightMenu(hook) {
    try { if (hook && hook._menu) { hook._menu.remove(); hook._menu = null; } } catch (e) {}
  }

  // Recolour an existing highlight: the in-memory store, the overlay, AND the colour
  // param in the note's backlink URL (so a later rebuild-from-note keeps the change).
  async _changeHighlightColor(hook, hid, colorKey) {
    const store = this._getStore();
    const hl = (store[hook.fingerprint] || []).find((h) => h.hid === hid);
    if (hl) { hl.color = colorKey; this._setStore(store); }
    this._redrawOverlays(hook);
    try {
      const note = this._findAssociatedNote(hook.iframe);
      if (!note) return;
      const items = (await note.getLineItems()) || [];
      for (const li of items) {
        const segs = li.segments || [];
        const hasLink = segs.some((s) => s && s.type === "linkobj" && s.text && typeof s.text.link === "string" && s.text.link.indexOf("hid=" + hid) !== -1);
        if (!hasLink) continue;
        const newSegs = segs.map((s) => {
          if (s.type === "linkobj" && s.text && typeof s.text.link === "string" && s.text.link.indexOf("hid=" + hid) !== -1) {
            return { type: "linkobj", text: { link: s.text.link.replace(/([?&]color=)[^&]+/, "$1" + colorKey), title: s.text.title } };
          }
          return { type: s.type, text: s.text };
        });
        try { li.setSegments(newSegs); } catch (e) {}
        break;
      }
    } catch (e) {}
  }

  async _deleteHighlight(hook, hid) {
    const store = this._getStore();
    if (store[hook.fingerprint]) {
      store[hook.fingerprint] = store[hook.fingerprint].filter((h) => h.hid !== hid);
      if (!store[hook.fingerprint].length) delete store[hook.fingerprint];
      this._setStore(store);
    }
    this._redrawOverlays(hook);
    try {
      const note = this._findAssociatedNote(hook.iframe);
      if (note) {
        const lines = await this._findHighlightLines(note, hid); // children first, block last
        for (const li of lines) { try { li.delete(); } catch (e) {} }
      }
    } catch (e) {}
    this.ui.addToaster({ title: "Highlight deleted", dismissible: true, autoDestroyTime: 1500 });
  }

  // Locate the quote block + its children for a highlight, via the `hid` carried in
  // the backlink URL on the last child (line metadata isn't readable). Children are
  // returned before the block so deletion never orphans a child.
  async _findHighlightLines(note, hid) {
    const items = (await note.getLineItems()) || [];
    const hasHidLink = (li) => {
      let segs = []; try { segs = li.segments || []; } catch (e) {}
      return segs.some((s) => s && s.type === "linkobj" && s.text && typeof s.text.link === "string" && s.text.link.indexOf("hid=" + hid) !== -1);
    };
    const anchor = items.find(hasHidLink);
    if (!anchor) return [];
    let blockGuid = null;
    try { blockGuid = (anchor._getItem && anchor._getItem().pguid) || null; } catch (e) {}
    if (!blockGuid) return [anchor];
    const children = [], blocks = [];
    for (const li of items) {
      const it = (li._getItem && li._getItem()) || {};
      if (it.pguid === blockGuid) children.push(li);
      else if (it.guid === blockGuid) blocks.push(li);
    }
    return children.concat(blocks);
  }

  // Drop store entries whose extract was deleted from the note (note → overlay sync).
  async _pruneStore(hook) {
    try {
      const note = this._findAssociatedNote(hook.iframe);
      if (!note) return;
      const items = (await note.getLineItems()) || [];
      const live = new Set();
      for (const li of items) {
        let segs = []; try { segs = li.segments || []; } catch (e) {}
        for (const s of segs) {
          if (s && s.type === "linkobj" && s.text && typeof s.text.link === "string") {
            const m = s.text.link.match(/hid=([^&]+)/);
            if (m) live.add(m[1]);
          }
        }
      }
      if (!live.size) return; // note not loaded / wrong note beside PDF — never wipe
      const store = this._getStore();
      const list = store[hook.fingerprint] || [];
      const kept = list.filter((h) => live.has(h.hid));
      if (kept.length !== list.length) {
        if (kept.length) store[hook.fingerprint] = kept; else delete store[hook.fingerprint];
        this._setStore(store);
        this._redrawOverlays(hook);
      }
    } catch (e) {}
  }

  // =======================================================================
  // Persistent coloured overlays
  // =======================================================================
  _saveHighlight(fingerprint, hl) {
    const store = this._getStore();
    (store[fingerprint] = store[fingerprint] || []).push(hl);
    this._setStore(store);
  }

  // DURABLE persistence: the note (which always survives reload) is the source of
  // truth. Re-derive each highlight's overlay rects by finding its extracted text
  // back in the PDF's text layer. The config store is only a fast in-session cache.
  async _rebuildFromNote(hook) {
    const now = Date.now();
    if (hook._rebuildAt && now - hook._rebuildAt < 350) return; // throttle
    hook._rebuildAt = now;
    const note = this._findAssociatedNote(hook.iframe);
    if (!note) return; // can't reach the note — keep whatever the store has
    let items;
    try { items = (await note.getLineItems()) || []; } catch (e) { return; }

    // children grouped by their parent block (for the paragraph texts)
    const kidsByBlock = {};
    for (const li of items) {
      const it = li._getItem && li._getItem();
      if (it && it.pguid) (kidsByBlock[it.pguid] = kidsByBlock[it.pguid] || []).push({ li, oind: it.oind || 0 });
    }
    // parse the extracts (backlink-bearing lines) for THIS pdf
    const seen = new Set(), hls = [];
    for (const li of items) {
      const segs = li.segments || [];
      const link = segs.find((s) => s && s.type === "linkobj" && s.text && typeof s.text.link === "string" && s.text.link.indexOf(this.BACKLINK_HOST) !== -1);
      if (!link) continue;
      let u; try { u = new URL(link.text.link); } catch (e) { continue; }
      if (u.searchParams.get("pdf") !== hook.fingerprint) continue;
      const hid = u.searchParams.get("hid"); if (!hid || seen.has(hid)) continue; seen.add(hid);
      const page = parseInt(u.searchParams.get("page"), 10) || 1;
      const color = u.searchParams.get("color") || "yellow";
      const it = li._getItem && li._getItem();
      const kids = (kidsByBlock[(it && it.pguid)] || [{ li }]).slice().sort((a, b) => (a.oind || 0) - (b.oind || 0));
      const paragraphs = kids
        .map((k) => (k.li.segments || []).filter((s) => s.type !== "linkobj").map((s) => (typeof s.text === "string" ? s.text : "")).join(""))
        .map((t) => t.trim()).filter(Boolean);
      const ocr = u.searchParams.get("ocr") === "1";
      let rect = null;
      const rstr = u.searchParams.get("rect");
      if (rstr) { const a = rstr.split(",").map(Number); if (a.length === 4 && a.every((n) => !isNaN(n))) rect = { x: a[0], y: a[1], w: a[2], h: a[3] }; }
      hls.push({ hid, page, color, paragraphs, ocr, rect });
    }

    // locate rects for each, on whatever page is currently rendered; keep prior rects otherwise
    const prior = this._getStore()[hook.fingerprint] || [];
    const result = hls.map((h) => {
      let rectsByPage = {};
      // OCR highlights carry their (single) overlay rect in the backlink URL — a
      // scanned page has no text layer to locate text in, so use it directly.
      if (h.ocr && h.rect) { rectsByPage[h.page] = [h.rect]; return { hid: h.hid, page: h.page, color: h.color, rectsByPage }; }
      const pageEl = [...hook.doc.querySelectorAll(".page")].find((p) => parseInt(p.getAttribute("data-page-number"), 10) === h.page);
      if (pageEl && pageEl.querySelector(".textLayer")) {
        const rects = [];
        for (const para of h.paragraphs) {
          const range = this._locateText(hook.doc, pageEl, para);
          if (range) (this._selectionRects(hook.doc, range)[h.page] || []).forEach((r) => rects.push(r));
        }
        if (rects.length) rectsByPage[h.page] = rects;
      }
      if (!rectsByPage[h.page]) {
        const p = prior.find((x) => x.hid === h.hid);
        if (p && p.rectsByPage) rectsByPage = p.rectsByPage; // keep already-located rects until the page renders
      }
      return { hid: h.hid, page: h.page, color: h.color, rectsByPage };
    });

    const store = this._getStore();
    store[hook.fingerprint] = result;
    this._setStore(store);
    this._redrawOverlays(hook);
  }

  // Find a passage's text back in a page's text layer (robust alnum match, ignoring
  // whitespace/hyphenation/punctuation differences) and return a DOM Range over it.
  _locateText(doc, pageEl, text) {
    const tl = pageEl.querySelector(".textLayer");
    if (!tl) return null;
    const walker = doc.createTreeWalker(tl, 4, null); // 4 = SHOW_TEXT
    let alnum = ""; const map = []; let node;
    while ((node = walker.nextNode())) {
      const t = node.nodeValue;
      for (let i = 0; i < t.length; i++) {
        const c = t[i].toLowerCase();
        if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) { alnum += c; map.push({ node, off: i }); }
      }
    }
    const needle = text.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!needle) return null;
    const idx = alnum.indexOf(needle);
    if (idx < 0) return null;
    const start = map[idx], end = map[idx + needle.length - 1];
    if (!start || !end) return null;
    try {
      const range = doc.createRange();
      range.setStart(start.node, start.off);
      range.setEnd(end.node, end.off + 1);
      return range;
    } catch (e) { return null; }
  }

  _redrawOverlays(hook) {
    const doc = hook.doc;
    const list = (this._getStore()[hook.fingerprint]) || [];
    if (!list.length) { doc.querySelectorAll(".pdfhl-overlay").forEach((n) => n.remove()); return; }
    doc.querySelectorAll(".page").forEach((pageEl) => {
      const pageNum = parseInt(pageEl.getAttribute("data-page-number"), 10);
      const tl = pageEl.querySelector(".textLayer");
      let layer = pageEl.querySelector(".pdfhl-overlay");
      const wanted = list.filter((h) => h.rectsByPage && h.rectsByPage[pageNum]);
      if (!wanted.length || !tl) { if (layer) layer.remove(); return; }
      if (!layer) {
        layer = doc.createElement("div");
        layer.className = "pdfhl-overlay";
        pageEl.appendChild(layer);
      }
      // Match the text layer's exact box (offset by the page border, scales with zoom).
      layer.style.cssText = "position:absolute;pointer-events:none;z-index:3;left:" + tl.offsetLeft + "px;top:" + tl.offsetTop + "px;width:" + tl.offsetWidth + "px;height:" + tl.offsetHeight + "px;";
      layer.innerHTML = "";
      for (const h of wanted) {
        const rgb = (this.COLORS.find((c) => c.key === h.color) || this.COLORS[0]).rgb;
        const rects = h.rectsByPage[pageNum];
        for (const r of rects) {
          const box = doc.createElement("div");
          box.className = "pdfhl-box";
          box.dataset.hid = h.hid || "";
          box.style.cssText =
            "left:" + (r.x * 100) + "%;top:" + (r.y * 100) + "%;width:" + (r.w * 100) + "%;height:" + (r.h * 100) + "%;" +
            "background:rgba(" + rgb + ",0.40);";
          layer.appendChild(box);
        }
      }
    });
  }

  // Highlight store lives in the plugin configuration custom blob.
  _getStore() {
    try {
      const conf = this.getConfiguration();
      conf.custom = conf.custom || {};
      return conf.custom.pdfhl_highlights || {};
    } catch (e) { return {}; }
  }
  _setStore(store) {
    try {
      const conf = this.getConfiguration();
      conf.custom = conf.custom || {};
      conf.custom.pdfhl_highlights = store;
      const mine = (this.data.getAllGlobalPlugins() || []).find((g) => g.guid === this.getGuid());
      if (mine && typeof mine.saveConfiguration === "function") mine.saveConfiguration(conf);
    } catch (e) {}
  }

  // =======================================================================
  // Styles
  // =======================================================================
  _injectMainCSS() {
    if (document.getElementById("pdfhl-main-style")) return;
    const s = document.createElement("style");
    s.id = "pdfhl-main-style";
    // Match a normal Thymer link (page then arrow, not bold, not italic, underlined),
    // overriding the quote-block's italic. The arrow icon (next sibling) takes the
    // link colour so it reads as a backlink, with a little space from the page.
    const host = this.BACKLINK_HOST;
    s.textContent =
      "a.lineitem-linkobj[href*='" + host + "']{cursor:pointer;font-style:normal !important;font-weight:400 !important;text-decoration:underline;}" +
      "a.lineitem-linkobj[href*='" + host + "'] + .lineitem-icon{margin-left:4px;color:var(--link-color);cursor:pointer;}" +
      "a.lineitem-linkobj[href*='" + host + "'] + .lineitem-icon .ti{color:var(--link-color);}";
    document.head.appendChild(s);
  }

  _injectViewerCSS(doc) {
    if (doc.getElementById("pdfhl-style")) return;
    const s = doc.createElement("style");
    s.id = "pdfhl-style";
    s.textContent = [
      ".pdfhl-toolbar{position:fixed;z-index:2147483647;display:none;gap:6px;padding:6px 8px;border-radius:10px;",
      "background:#1f1f1f;box-shadow:0 4px 16px rgba(0,0,0,.4);align-items:center;}",
      ".pdfhl-swatch{width:20px;height:20px;border-radius:50%;border:2px solid rgba(255,255,255,.85);cursor:pointer;padding:0;}",
      ".pdfhl-swatch:hover{transform:scale(1.15);}",
      ".pdfhl-overlay{position:absolute;inset:0;pointer-events:none;z-index:3;}",
      ".pdfhl-box{position:absolute;border-radius:2px;mix-blend-mode:multiply;}",
      ".pdfhl-box.pdfhl-pulse{animation:pdfhl-pulse .9s ease-out 2;}",
      "@keyframes pdfhl-pulse{0%{outline:0 solid rgba(0,0,0,0);}40%{outline:3px solid rgba(0,0,0,.55);}100%{outline:0 solid rgba(0,0,0,0);}}",
      ".pdfhl-marquee{position:fixed;z-index:2147483646;border:1.5px dashed rgba(31,31,31,.9);",
      "background:rgba(31,31,31,.10);pointer-events:none;border-radius:2px;}",
      ".pdfhl-menu{position:fixed;z-index:2147483647;background:#1f1f1f;border-radius:10px;padding:8px;",
      "box-shadow:0 6px 24px rgba(0,0,0,.45);min-width:150px;}",
      ".pdfhl-menu .pdfhl-menu-swatches{display:flex;gap:6px;padding:2px 2px 8px;justify-content:space-between;}",
      ".pdfhl-menu .pdfhl-swatch-current{box-shadow:0 0 0 2px #1f1f1f,0 0 0 4px #fff;}",
      ".pdfhl-menu-item{color:#fff;font:13px/1.4 system-ui,sans-serif;padding:7px 8px;border-radius:6px;cursor:pointer;}",
      ".pdfhl-menu-item:hover{background:rgba(255,255,255,.12);}",
      ".pdfhl-menu-delete:hover{background:#d83a3a;}",
    ].join("");
    doc.head.appendChild(s);
  }
}
