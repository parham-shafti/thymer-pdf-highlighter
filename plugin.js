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
    // List markers, shared by every capture path. OCR rarely reads a bullet glyph as "•":
    // "+", "»" and "›" are the usual mis-reads, so they count as markers too.
    this.BULLET_RE = /^\s*([•·●▪‣◦∙*+»›▸■□○]|[-–—])\s+/;
    this.NUMBER_RE = /^\s*\d+[.)]\s+/;
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
    this._hlColor = "yellow"; // remembered highlight colour, auto-applied to new highlights

    // ---- shape markup ----------------------------------------------------
    // Drawn annotations (rectangle, ellipse, line, arrow, freehand). Each shape is a note
    // block — an empty line to write WHY it's there, plus a backlink carrying its geometry —
    // so shapes persist, sync and delete exactly like highlights do.
    // Their own palette: border colours want more range than the 5 highlighter colours.
    this.SHAPE_COLORS = [
      { key: "red",    label: "Red",    rgb: "227,52,47" },
      { key: "blue",   label: "Blue",   rgb: "10,132,255" },
      { key: "green",  label: "Green",  rgb: "52,199,89" },
      { key: "yellow", label: "Yellow", rgb: "255,214,10" },
      { key: "orange", label: "Orange", rgb: "255,149,0" },
      { key: "pink",   label: "Pink",   rgb: "255,55,151" },
      { key: "black",  label: "Black",  rgb: "20,20,20" },
      { key: "white",  label: "White",  rgb: "255,255,255" },
    ];
    // The rail is three buttons, each with a fly-out, so it stays short in a narrow panel:
    // Text (how a text selection is marked), Shapes (which shape a drag draws), Style.
    this.TEXT_MARKS = [
      { key: "fill",      label: "Highlight",     svg: '<path d="M4.2 15.4 L7 15.4 L7 13.2 L4.2 13.2 Z" fill="currentColor"/><path d="M6.2 12.4 L12.6 5.2 A1.6 1.6 0 0 1 15 5.2 L15.6 5.9 A1.6 1.6 0 0 1 15.6 8.1 L9 14.2 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' },
      { key: "underline", label: "Underline",     svg: '<path d="M6 4 L6 9.5 A4 4 0 0 0 14 9.5 L14 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4.5 16 L15.5 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' },
      { key: "area",      label: "Area",          svg: '<rect x="3.2" y="4.6" width="13.6" height="10.8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.6,2"/><path d="M6.2 8.4 H13.8 M6.2 11.4 H11.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' },
      { key: "strike",    label: "Strikethrough", svg: '<path d="M6.6 5.4 A3.6 3.6 0 0 1 13.4 6.4 M13.4 13.4 A3.8 3.8 0 0 1 6.4 12.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4 10 L16 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' },
    ];
    this.SHAPE_TOOLS = [
      { key: "rect",    label: "Rectangle", svg: '<rect x="3.5" y="5.5" width="13" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/>' },
      { key: "ellipse", label: "Ellipse",   svg: '<ellipse cx="10" cy="10" rx="6.6" ry="4.8" fill="none" stroke="currentColor" stroke-width="1.6"/>' },
      { key: "line",    label: "Line",      svg: '<path d="M4 15.5 L16 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' },
      { key: "arrow",   label: "Arrow",     svg: '<path d="M4 16 L14 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M16.5 3.5 L10.2 4.8 L15.2 9.8 Z" fill="currentColor"/>' },
      { key: "draw",    label: "Draw",      svg: '<path d="M3.5 12.5 C6 6.5, 8 16, 10.5 10 S14.5 4.5, 16.5 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' },
    ];
    this._tool = "text";        // "select" = plain selection, "text" = marks text, else a shape
    this._shapeTool = "rect";   // the shape the Shapes button re-arms
    this._textMark = "fill";    // how a text selection is marked: fill | underline | strike
    this._markWidth = 6;        // 1-12; underline/strike weight as a share of line height
    this._noteMode = "citation"; // what the note gets, combined with any text mark above
    // citation = the quoted passage, comment = an empty block to write in
    this.NOTE_MODES = [
      { key: "citation", label: "Citation", svg: '<path d="M8.4 5.2 C5.6 6.4 4 8.6 4 11.2 C4 13.3 5.3 14.8 7.1 14.8 C8.7 14.8 9.9 13.6 9.9 12.1 C9.9 10.6 8.8 9.5 7.3 9.5 C7 9.5 6.7 9.6 6.5 9.6 C6.9 8.2 7.9 7.1 9.3 6.4 Z M16.1 5.2 C13.3 6.4 11.7 8.6 11.7 11.2 C11.7 13.3 13 14.8 14.8 14.8 C16.4 14.8 17.6 13.6 17.6 12.1 C17.6 10.6 16.5 9.5 15 9.5 C14.7 9.5 14.4 9.6 14.2 9.6 C14.6 8.2 15.6 7.1 17 6.4 Z" fill="currentColor"/>' },
      { key: "comment",  label: "Comment",  svg: '<path d="M3.4 5.2 A1.8 1.8 0 0 1 5.2 3.4 H14.8 A1.8 1.8 0 0 1 16.6 5.2 V11.6 A1.8 1.8 0 0 1 14.8 13.4 H8.4 L5 16.4 V13.4 H5.2 A1.8 1.8 0 0 1 3.4 11.6 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' },
    ];
    this._shapeColor = "red";   // stroke colour for new shapes
    this._shapeWidth = 0.003;   // stroke width as a fraction of page width (scales with zoom)
    this._shapeFill = false;    // filled vs outline only
    this._shapeOpacity = 1;     // 0..1
    this._shapeDash = "solid";  // solid | dashed | dotted | dashdot
    this._useHeading = true;  // group extracts under a "Highlights" heading (toggleable)
    this._lastNoteLineGuid = null; // last note line clicked — insertion point when the heading is off
    try { const conf = this.getConfiguration(); if (conf && conf.custom) { if (conf.custom.ocrLang) this._ocrLang = conf.custom.ocrLang; if (conf.custom.hlColor) this._hlColor = conf.custom.hlColor; if (conf.custom.useHeading === false) this._useHeading = false; } } catch (e) {}
    // saveConfiguration writes don't round-trip back into getConfiguration in the web
    // client, so the heading toggle also persists in localStorage (reliable on desktop
    // and web, survives reload). Read after config so it wins.
    try {
      const v = window.localStorage.getItem("pdfhl_useHeading"); if (v === "0") this._useHeading = false; else if (v === "1") this._useHeading = true;
      const lc = window.localStorage.getItem("pdfhl_hlColor"); if (lc) this._hlColor = lc;
      const ll = window.localStorage.getItem("pdfhl_ocrLang"); if (ll) this._ocrLang = ll;
      const sc = window.localStorage.getItem("pdfhl_shapeColor"); if (sc) this._shapeColor = sc;
      const sw = parseFloat(window.localStorage.getItem("pdfhl_shapeWidth")); if (sw > 0) this._shapeWidth = sw;
      const sf = window.localStorage.getItem("pdfhl_shapeFill"); if (sf === "1") this._shapeFill = true;
      const so = parseFloat(window.localStorage.getItem("pdfhl_shapeOpacity")); if (so > 0 && so <= 1) this._shapeOpacity = so;
      const sd = window.localStorage.getItem("pdfhl_shapeDash"); if (sd) this._shapeDash = sd;
      const tm = window.localStorage.getItem("pdfhl_textMark"); if (tm) this._textMark = tm;
      const mwv = parseInt(window.localStorage.getItem("pdfhl_markWidth"), 10); if (mwv >= 1 && mwv <= 12) this._markWidth = mwv;
      const nm = window.localStorage.getItem("pdfhl_noteMode"); if (nm) this._noteMode = nm;
    } catch (e) {}
    // A remembered value can outlive the option it named (Comment briefly lived in the mark
    // list before moving to its own section). Fall back rather than leaving nothing selected:
    // one mark and one note mode must ALWAYS be active.
    try {
      const ok = (list, v) => list.some((x) => x.key === v);
      if (!ok(this.TEXT_MARKS, this._textMark)) this._textMark = "fill";
      if (!ok(this.NOTE_MODES, this._noteMode)) this._noteMode = "citation";
      if (!ok(this.SHAPE_TOOLS, this._shapeTool)) this._shapeTool = "rect";
      if (!ok(this.SHAPE_COLORS, this._shapeColor)) this._shapeColor = "red";
      if (!ok(this.COLORS, this._hlColor)) this._hlColor = "yellow";
      if (["solid", "dashed", "dotted", "dashdot"].indexOf(this._shapeDash) === -1) this._shapeDash = "solid";
      const st = window.localStorage.getItem("pdfhl_shapeTool"); if (st) this._shapeTool = st;
    } catch (e) {}
    this._cmds = []; // registered command-palette commands (removed on teardown)

    this._hooked = new WeakSet();     // iframes already wired
    this._storeCache = null;          // in-session source of truth for the highlight store; the config round-trip (getConfiguration/saveConfiguration) does NOT reflect writes in the web client, so reads must not depend on it
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

    try {
      // Toggle grouping extracts under a "Highlights" heading vs dropping them at the cursor.
      // Listed FIRST, before the OCR language commands.
      this._cmds.push(this.ui.addCommandPaletteCommand({
        label: "PDF Highlighter: Toggle Highlights heading",
        icon: "ti-heading",
        onSelected: () => this._setUseHeading(!this._useHeading),
      }));
      // Then one command-palette command per OCR language (sets it for scanned-page OCR).
      for (const L of this.OCR_LANGUAGES) {
        this._cmds.push(this.ui.addCommandPaletteCommand({
          label: "PDF Highlighter: " + L.label,
          icon: "ti-language",
          onSelected: () => this._setOcrLang(L.code),
        }));
      }
    } catch (e) {}

    // Track the last note line the user clicked, so "heading off" can insert there.
    // Thymer's custom caret/input layer often intercepts the click target, so fall
    // back to geometric hit-testing (which line's box contains the click point).
    const onNoteClick = (e) => {
      try {
        let li = e.target.closest && e.target.closest(".listitem-text[data-guid], .listitem-heading[data-guid]");
        if (!li) {
          // Geometric fallback: the SMALLEST line box containing the click point
          // (the leaf text/heading line, not an enclosing block/quote container).
          const x = e.clientX, y = e.clientY;
          let bestArea = Infinity;
          for (const it of document.querySelectorAll(".listview-items .listitem[data-guid]")) {
            const r = it.getBoundingClientRect();
            if (r.width && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && r.width * r.height < bestArea) { li = it; bestArea = r.width * r.height; }
          }
        }
        if (li) this._lastNoteLineGuid = li.getAttribute("data-guid");
      } catch (er) {}
    };
    // pointerdown is the one Thymer's editor actually uses for caret placement (and a
    // preventDefault there can suppress the compat mousedown) — listen for both.
    document.addEventListener("pointerdown", onNoteClick, true);
    document.addEventListener("mousedown", onNoteClick, true);
    this._cleanups.push(() => { try { document.removeEventListener("pointerdown", onNoteClick, true); document.removeEventListener("mousedown", onNoteClick, true); } catch (e) {} });

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
    try { this._closeStylePanel(); } catch (e) {}
    document.querySelectorAll("#pdfhl-main-style, .pdfhl-tools, .pdfhl-style-panel, .pdfhl-shortcuts").forEach((n) => n.remove());
    document.querySelectorAll("iframe.id--pdf-viewer").forEach((fr) => {
      try {
        const d = fr.contentDocument;
        if (!d) return;
        if (d.__pdfhlTeardown) { try { d.__pdfhlTeardown(); } catch (e) {} }
        d.querySelectorAll(".pdfhl-overlay, .pdfhl-marquee, .pdfhl-menu, .pdfhl-tools, .pdfhl-shapes, #pdfhl-style").forEach((n) => n.remove());
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
    this._injectToolRail(hook);

    // Selection -> toolbar (positioned above the selection). On an image-only
    // (scanned) page there's nothing to select, so a drag instead draws an OCR
    // marquee that finalizes into the same colour toolbar.
    const onMouseUp = (e) => {
      if (hook.shapeDrag) { this._finishShapeDrag(hook, e); return; }
      if (hook.drawing) { this._finishShape(hook, e); return; }
      if (hook.marquee && hook.marquee.active) { this._finishMarquee(hook, e); return; }
      // A plain click (not a drag) selects the shape under the cursor, or clears the
      // selection. A selected shape can then be removed with Delete/Backspace.
      const d = hook._downAt;
      if (d && Math.abs(e.clientX - d.x) < 4 && Math.abs(e.clientY - d.y) < 4) {
        const shapeHid = this._shapeAtPoint(hook, e.clientX, e.clientY);
        if (shapeHid !== hook.selectedShape) { hook.selectedShape = shapeHid || null; this._redrawShapes(hook); }
        if (shapeHid) return; // clicked a shape, not the text underneath
      }
      // Modifier held while selecting picks the extract style: ⌘ = merge into the previous
      // quote (one citation, one link), ⌥ = empty note block, none = a new quote.
      const mode = e.metaKey ? "append" : (e.altKey ? "link" : "normal");
      setTimeout(() => this._onSelectionSettled(hook, mode), 0);
    };
    const onSelDown = (e) => {
      if (e.target.closest && e.target.closest(".pdfhl-menu, .pdfhl-tools")) return;
      this._hideToolbar(hook);
      this._closeHighlightMenu(hook); // any click outside the menu dismisses it
      // A click inside the iframe never reaches Thymer's document, so the rail's pop-ups
      // have to be dismissed from here too.
      this._closeFlyout();
      this._closeStylePanel();
      this._closeShortcuts();
      if (e.button !== 0) return;
      hook._downAt = { x: e.clientX, y: e.clientY }; // to tell a click from a drag on mouseup
      const pageEl = e.target.closest && e.target.closest(".page");
      if (!pageEl) return;
      // A markup tool takes precedence: drag draws a shape instead of selecting text
      // (or drawing an OCR marquee).
      if (this._isShapeTool()) { this._startShape(hook, pageEl, e); return; }
      // Select mode: grab a handle to resize, or the shape itself to move it.
      if (this._tool === "select") {
        const grab = this._handleAtPoint(hook, e.clientX, e.clientY);
        if (grab) { this._startShapeDrag(hook, e, grab.hid, "resize", grab.key); return; }
        const onShape = this._shapeAtPoint(hook, e.clientX, e.clientY);
        if (onShape) {
          if (hook.selectedShape !== onShape) { hook.selectedShape = onShape; this._redrawShapes(hook); }
          this._startShapeDrag(hook, e, onShape, "move", null);
          return;
        }
      }
      // Area mode: box a region on ANY page. A scanned page still falls through to OCR;
      // a text page reads the text layer instead, so the capture is exact.
      if (this._tool === "text" && this._textMark === "area") { this._startMarquee(hook, pageEl, e, true); return; }
      if (this._isScannedPage(pageEl)) this._startMarquee(hook, pageEl, e);
    };
    const onScroll = () => { this._hideToolbar(hook); this._closeHighlightMenu(hook); };
    // Right-click a highlight -> context menu (change colour / delete). Replaces the
    // old hover ✕, which sat outside the highlight and vanished as you reached for it.
    const onCtx = (e) => {
      const box = this._boxAtPoint(hook, e.clientX, e.clientY);
      if (box) {
        e.preventDefault(); e.stopPropagation();
        const hp = this._toTopCoords(hook, e.clientX, e.clientY);
        this._toggleStylePanel(hook, null, { x: hp.x, y: hp.y, highlightHid: box.dataset.hid, deleteHid: box.dataset.hid });
        return;
      }
      const shapeHid = this._shapeAtPoint(hook, e.clientX, e.clientY);
      if (!shapeHid) return; // not on a highlight or shape — let the native menu through
      e.preventDefault(); e.stopPropagation();
      if (hook.selectedShape !== shapeHid) { hook.selectedShape = shapeHid; this._redrawShapes(hook); }
      const pt = this._toTopCoords(hook, e.clientX, e.clientY);
      this._toggleStylePanel(hook, null, { x: pt.x, y: pt.y, deleteHid: shapeHid });
    };
    const onMove = (e) => {
      if (hook.shapeDrag) { this._updateShapeDrag(hook, e); return; }
      if (hook.drawing) { this._updateShape(hook, e); return; }
      if (this._tool === "select" && hook.selectedShape) {
        const over = this._handleAtPoint(hook, e.clientX, e.clientY);
        const want = over ? this._cursorForHandle(over.key) : (this._shapeAtPoint(hook, e.clientX, e.clientY) ? "move" : "");
        if (hook._cursor !== want) { hook._cursor = want; try { doc.body.style.cursor = want; } catch (er) {} }
      } else if (hook._cursor) {
        hook._cursor = ""; try { doc.body.style.cursor = ""; } catch (er) {}
      }
      if (hook.marquee && hook.marquee.active) this._updateMarquee(hook, e);
    };
    // Shift+drag boxes accumulate; releasing Shift OCRs them all as one extract. Esc discards.
    const onKeyUp = (e) => { if (e.key === "Shift") this._commitOcrBoxes(hook); };
    const onKeyDown = (e) => {
      // While the style panel is open it owns Enter (commit) and Esc (revert).
      if (this._stylePanel && (e.key === "Enter" || e.key === "Escape")) {
        e.preventDefault(); e.stopPropagation();
        if (e.key === "Escape") this._revertStyleEdits(hook);
        this._closeStylePanel();
        return;
      }
      // Delete/Backspace removes the selected shape.
      if ((e.key === "Delete" || e.key === "Backspace") && hook.selectedShape) {
        e.preventDefault(); e.stopPropagation();
        const hid = hook.selectedShape;
        hook.selectedShape = null;
        this._deleteHighlight(hook, hid);
        return;
      }
      if (e.key !== "Escape") return;
      this._cancelOcrBoxes(hook);
      // Esc clears a selection, abandons a shape in progress, then drops back to select.
      if (hook.selectedShape) { hook.selectedShape = null; this._redrawShapes(hook); return; }
      if (hook.drawing) this._cancelShape(hook);
      else if (this._tool !== "select") this._setTool(hook, "select");
    };
    doc.addEventListener("mouseup", onMouseUp, true);
    doc.addEventListener("mousedown", onSelDown, true);
    doc.addEventListener("scroll", onScroll, true);
    doc.addEventListener("mousemove", onMove, true);
    doc.addEventListener("contextmenu", onCtx, true);
    doc.addEventListener("keyup", onKeyUp, true);
    doc.addEventListener("keydown", onKeyDown, true);
    // Shift keyup can land on the top window if focus left the iframe — catch it there too
    // (commit is idempotent, so a double-fire is harmless).
    window.addEventListener("keyup", onKeyUp, true);

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
      try { doc.removeEventListener("keyup", onKeyUp, true); } catch (e) {}
      try { doc.removeEventListener("keydown", onKeyDown, true); } catch (e) {}
      try { window.removeEventListener("keyup", onKeyUp, true); } catch (e) {}
      try { this._closeHighlightMenu(hook); } catch (e) {}
      try { app.eventBus.off("textlayerrendered", onRendered); } catch (e) {}
      try { app.eventBus.off("pagerendered", onRendered); } catch (e) {}
      try { app.eventBus.off("pagesloaded", onRendered); } catch (e) {}
      try { tlObserver.disconnect(); } catch (e) {}
      try { this._cancelMarquee(hook); } catch (e) {}
      try { this._cancelOcrBoxes(hook); } catch (e) {}
      try { this._cancelShape(hook); } catch (e) {}
      try { hook.shapeDrag = null; doc.body.style.cursor = ""; } catch (e) {}
      try { doc.querySelectorAll(".pdfhl-shapes").forEach((n) => n.remove()); } catch (e) {}
      try { if (hook.rail) { hook.rail.remove(); hook.rail = null; } } catch (e) {}
      try { this._closeStylePanel(); } catch (e) {}
      try { this._closeShortcuts(); } catch (e) {}
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
  _onSelectionSettled(hook, mode) {
    if (this._tool !== "text") return; // Select mode: plain text selection, nothing written
    const sel = hook.win.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    // Selection must be inside a text layer.
    const anchorEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    if (!anchorEl || !anchorEl.closest(".textLayer")) return;
    const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
    if (!rects.length) return;
    // Auto-apply the remembered colour straight away — no toolbar. Recolour later
    // via right-click, which also updates the remembered colour.
    this._pendingRange = range.cloneRange();
    this._activeHook = hook;
    hook._pendingRegion = null;
    this._extract(hook, this._currentColor(), mode || "normal");
  }

  // The remembered highlight colour, auto-applied to new highlights.
  _currentColor() { return this.COLORS.find((c) => c.key === this._hlColor) || this.COLORS[0]; }

  // Remember a colour as the default for new highlights (persisted in config).
  _setHlColor(key) {
    if (!this.COLORS.some((c) => c.key === key)) return;
    this._hlColor = key;
    try { this._paintStyleDot(); } catch (e) {}
    try { window.localStorage.setItem("pdfhl_hlColor", key); } catch (e) {} // config doesn't round-trip on reload here
    try {
      const conf = this.getConfiguration();
      conf.custom = conf.custom || {};
      conf.custom.hlColor = key;
      const mine = (this.data.getAllGlobalPlugins() || []).find((g) => g.guid === this.getGuid());
      if (mine && typeof mine.saveConfiguration === "function") mine.saveConfiguration(conf);
    } catch (e) {}
  }

  _hideToolbar(hook) {
    if (hook && hook.toolbar) hook.toolbar.style.display = "none";
  }

  // =======================================================================
  // Extraction
  // =======================================================================
  async _extract(hook, color, mode) {
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
    // The Comment mode is the ⌥ gesture promoted to a tool: link the passage, quote nothing.
    const effMode = this._noteMode === "comment" && (mode || "normal") === "normal" ? "link" : (mode || "normal");
    await this._commitExtract(hook, note, {
      paragraphs: data.paragraphs, page: data.page, color, rectsByPage: data.rectsByPage,
      mode: effMode, mark: this._textMark, markWidth: this._markWidth,
    });
    // Clear selection + toolbar.
    try { hook.win.getSelection().removeAllRanges(); } catch (e) {}
    this._hideToolbar(hook);
    this._pendingRange = null;
  }

  // Write an extract into the note as a Thymer QUOTE BLOCK: a "block" line
  // (blockStyle "quote") whose paragraphs are "text" children, with the backlink
  // arrow ("p.N" link + ti-arrow-up-right icon) at the end of the last paragraph.
  // Shared by the text-selection and OCR paths. For OCR, `ocrRects` are the marquee
  // rectangles (normalised, one per box) — encoded in the backlink so the overlay is
  // fully reconstructable from the note alone (a scanned page has no text layer to match).
  async _commitExtract(hook, note, { paragraphs, page, color, rectsByPage, ocrRects, mode, shape, mark, markWidth }) {
    mode = mode || "normal";
    mark = mark || "fill";
    const quote = paragraphs.join("\n\n");
    const hid = "h" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    const fileGuid = this._currentFileGuid(hook);
    const encRects = (rs) => rs.map((r) => [r.x, r.y, r.w, r.h].map((n) => Number(n).toFixed(4)).join(",")).join(";");
    let backlink = "https://" + this.BACKLINK_HOST + "/open?pdf=" + encodeURIComponent(hook.fingerprint) +
      "&page=" + page + "&color=" + color.key + "&file=" + encodeURIComponent(fileGuid || "") + "&hid=" + hid;
    if (mark !== "fill") backlink += "&mark=" + mark + "&mw=" + (markWidth || this._markWidth);
    if (ocrRects && ocrRects.length) backlink += "&ocr=1&rect=" + encRects(ocrRects);
    // A drawn shape carries its geometry and style in the backlink, so the markup is
    // reconstructable from the note alone (same trick as the OCR rectangles).
    else if (shape) backlink += "&shape=" + shape.type + "&geom=" + this._encShapeGeom(shape) +
      "&stroke=" + shape.stroke + "&sw=" + Number(shape.sw).toFixed(5) +
      "&fill=" + (shape.fill ? 1 : 0) + "&op=" + Number(shape.op != null ? shape.op : 1).toFixed(2) +
      (shape.dash && shape.dash !== "solid" ? "&ls=" + shape.dash : "");
    // A note-link has no quote text to locate back in the PDF, so it carries its overlay
    // rect(s) in the URL — recovered directly on rebuild, the same way OCR highlights are.
    else if (mode === "link") {
      const lr = (rectsByPage && rectsByPage[page]) || [];
      if (lr.length) backlink += "&link=1&rect=" + encRects(lr);
    }

    // APPEND (⌘): add these paragraphs into the previous quote block instead of a new one.
    if (mode === "append") {
      const tgt = await this._resolveAppendTarget(note, hook.fingerprint);
      // A citation that straddles a page break is really two citations: the merged quote can
      // only carry ONE link, so pieces from another page would jump to the wrong place and
      // lose their overlay on reload. Start a fresh quote instead.
      let tgtPage = null;
      if (tgt && tgt.linkUrl) { try { tgtPage = parseInt(new URL(tgt.linkUrl).searchParams.get("page"), 10) || null; } catch (e) {} }
      if (tgt && tgtPage && tgtPage !== page) {
        this.ui.addToaster({
          title: "Started a new quote", message: "That passage is on p." + page + ", the last one on p." + tgtPage + ".",
          dismissible: true, autoDestroyTime: 3200,
        });
      } else if (tgt && tgt.linkLi && tgt.linkUrl) {
        try {
          // Strip the link off the old last line — the quote keeps only ONE, at its end.
          const segs = tgt.linkLi.segments || [];
          const kept = segs.filter((sg) => sg.type === "text")
            .map((sg) => ({ type: "text", text: typeof sg.text === "string" ? sg.text : "" }));
          if (kept.length) kept[kept.length - 1].text = String(kept[kept.length - 1].text).replace(/\s+$/, "");
          tgt.linkLi.setSegments(kept.length ? kept : [{ type: "text", text: "" }]);
          // Continue the SAME citation: reuse its hid, page and link.
          await this._writeParagraphs(note, tgt.block, tgt.after, paragraphs, tgt.linkUrl, tgt.linkTitle || ("p." + page));
        } catch (e) {
          this.ui.addToaster({ title: "Couldn't append", message: String(e.message || e), dismissible: true });
          return false;
        }
        // Fold the new rects into the existing highlight rather than making a new one.
        let prevHid = null;
        try { prevHid = new URL(tgt.linkUrl).searchParams.get("hid"); } catch (e) {}
        const store = this._getStore();
        const list = store[hook.fingerprint] || (store[hook.fingerprint] = []);
        const prev = prevHid ? list.find((h) => h.hid === prevHid) : null;
        if (prev) {
          prev.rectsByPage = prev.rectsByPage || {};
          for (const pg in rectsByPage) prev.rectsByPage[pg] = (prev.rectsByPage[pg] || []).concat(rectsByPage[pg]);
          prev.quote = (prev.quote ? prev.quote + "\n\n" : "") + quote;
          this._setStore(store);
        }
        this._redrawOverlays(hook);
        this.ui.addToaster({ title: "Added to quote", message: "One citation, one link.", dismissible: true, autoDestroyTime: 2000 });
        return true;
      }
      // Nothing to append to (no earlier quote block for this PDF) — say so rather than
      // silently starting a new one, which reads as "⌘ stopped working".
      mode = "normal";
      this.ui.addToaster({ title: "Started a new block", message: "No earlier quote to append to.", dismissible: true, autoDestroyTime: 2600 });
    }

    let loc;
    try { loc = await this._insertLocation(note); }
    catch (e) { loc = { parentItem: null, after: null }; }

    // NOTE-LINK (⌥): an empty "note"-styled BLOCK to write your own note in, carrying just
    // the backlink (no extracted text). The overlay box is recovered from the URL rects.
    if (mode === "link") {
      let block = null;
      try {
        block = await note.createLineItem(loc.parentItem, loc.after, "block");
        if (!block) throw new Error("createLineItem returned null");
        try { block.setBlockStyle(mark === "strike" ? "warning" : "note"); } catch (e) {}
        // An empty line first to write the note in, then the backlink line below it.
        const noteLine = await note.createLineItem(block, null, "text");
        if (noteLine) noteLine.setSegments([{ type: "text", text: "" }]);
        const li = await note.createLineItem(block, noteLine, "text");
        if (!li) throw new Error("createLineItem returned null");
        li.setSegments([
          { type: "text", text: "  " },
          { type: "linkobj", text: { link: backlink, title: "p." + page } },
          { type: "icon", text: "ti-arrow-up-right" },
        ]);
        if (!loc.parentItem) await this._moveBlockAfter(block, loc.after); // records prepend top-level inserts → place after the caret line / end
      } catch (e) {
        this.ui.addToaster({ title: "Couldn't add note", message: String(e.message || e), dismissible: true });
        return false;
      }
      const blkGuid = (block && (block.guid || (block._getRow && block._getRow().guid))) || null;
      this._saveHighlight(hook.fingerprint, { hid, page, color: color.key, rectsByPage, quote: "", lineGuid: blkGuid, shape, mark });
      this._redrawOverlays(hook);
      if (shape) this._redrawShapes(hook);
      this.ui.addToaster({
        title: shape ? "Shape added" : "Note added",
        message: "p." + page + " → write why it's there", dismissible: true, autoDestroyTime: 2200,
      });
      return true;
    }

    // NORMAL: a new quote block.
    let block = null;
    try {
      block = await note.createLineItem(loc.parentItem, loc.after, "block");
      if (!block) throw new Error("createLineItem returned null");
      // Struck-through text reads as something to challenge, so it lands in a warning block.
      try { block.setBlockStyle(mark === "strike" ? "warning" : "quote"); } catch (e) {}
      await this._writeParagraphs(note, block, null, paragraphs, backlink, page);
      if (!loc.parentItem) await this._moveBlockAfter(block, loc.after); // records prepend top-level inserts → place after the caret line / end
    } catch (e) {
      this.ui.addToaster({ title: "Couldn't write extract", message: String(e.message || e), dismissible: true });
      return false;
    }

    const firstGuid = (block && (block.guid || (block._getRow && block._getRow().guid))) || null;
    this._lastBlockGuid = firstGuid; // the block ⌘-append adds into
    this._saveHighlight(hook.fingerprint, { hid, page, color: color.key, rectsByPage, quote, lineGuid: firstGuid, mark, mw: markWidth || this._markWidth });
    this._redrawOverlays(hook);
    this.ui.addToaster({
      title: "Extracted to note", message: "p." + page + " → " + note.getName(),
      dismissible: true, autoDestroyTime: 2200,
    });
    return true;
  }

  // Write paragraphs as "text" children under `parent` (after `afterLi`); the last one
  // carries the backlink arrow ("p.N" link + ti-arrow-up-right icon). Shared by the
  // new-block (normal) and append paths.
  async _writeParagraphs(note, parent, afterLi, paragraphs, backlink, pageOrTitle) {
    const title = typeof pageOrTitle === "string" ? pageOrTitle : "p." + pageOrTitle;
    // A captured list becomes a REAL Thymer list: the marker is consumed by the line type
    // instead of sitting in the text as a stray glyph.
    const BULLET = this.BULLET_RE, NUMBER = this.NUMBER_RE;
    let prev = afterLi || null;
    for (let i = 0; i < paragraphs.length; i++) {
      let body = paragraphs[i], type = "text";
      if (BULLET.test(body)) { type = "ulist"; body = body.replace(BULLET, ""); }
      else if (NUMBER.test(body)) { type = "olist"; body = body.replace(NUMBER, ""); }
      let p = await note.createLineItem(parent, prev, type);
      if (!p && type !== "text") p = await note.createLineItem(parent, prev, "text"); // fall back to plain
      if (!p) continue;
      const isLast = i === paragraphs.length - 1;
      const segs = [{ type: "text", text: body + (isLast ? "  " : "") }];
      if (isLast) {
        segs.push({ type: "linkobj", text: { link: backlink, title: title } });
        segs.push({ type: "icon", text: "ti-arrow-up-right" });
      }
      p.setSegments(segs);
      prev = p;
    }
  }

  // In record-type notes, createLineItem(null, after) ignores the anchor and prepends the
  // new top-level block at the top (all items share oind 0). move() DOES honour the anchor,
  // so reposition the block to sit right after its intended anchor — the caret line (heading
  // off) or the last body line (end). No-op if move() is unavailable or there's no anchor.
  async _moveBlockAfter(block, after) {
    try {
      if (!block || typeof block.move !== "function" || !after) return;
      await block.move(null, after);
    } catch (e) {}
  }

  // The block ⌘-append should add into: the last normal extract's quote block (tracked in
  // _lastBlockGuid), plus the line to insert after. Null if it's gone (note reloaded /
  // deleted) — the caller then starts a fresh block.
  async _resolveAppendTarget(note, fingerprint) {
    try {
      const items = (await note.getLineItems()) || [];
      const rows = items.map((li) => ({ li, row: (li._getItem && li._getItem()) || {} }));
      const linkOf = (li) => {
        let segs = []; try { segs = li.segments || []; } catch (e) { return null; }
        return segs.find((sg) => sg && sg.type === "linkobj" && sg.text && typeof sg.text.link === "string" && sg.text.link.indexOf(this.BACKLINK_HOST) !== -1) || null;
      };
      const targetBlock = (blockGuid) => {
        if (!blockGuid) return null;
        const block = rows.find((x) => x.row.guid === blockGuid);
        if (!block) return null;
        const kids = rows.filter((x) => x.row.pguid === blockGuid).sort((a, b) => (a.row.oind || 0) - (b.row.oind || 0));
        // The last child carrying a backlink IS the quote we extend: ⌘ merges into it,
        // so the block keeps ONE citation with one link at the end.
        let linkLi = null, linkSeg = null;
        for (const k of kids) { const sg = linkOf(k.li); if (sg) { linkLi = k.li; linkSeg = sg; } }
        return {
          block: block.li,
          after: kids.length ? kids[kids.length - 1].li : null,
          linkLi: linkLi, linkUrl: linkSeg ? linkSeg.text.link : null, linkTitle: linkSeg ? linkSeg.text.title : null,
        };
      };
      // Primary: the block tracked from the last normal extract this session.
      const tracked = targetBlock(this._lastBlockGuid);
      if (tracked) return tracked;
      // Fallback (block moved/indented so its guid changed, or lost after reload): the
      // quote-extract block carrying the most-recent highlight for this PDF. `hid` is
      // "h"+base36(Date.now())+… so a lexicographic max ≈ most recently created. Note-links
      // (link=1) are skipped — they're not append targets.
      let bestHid = "", bestPguid = null;
      for (const x of rows) {
        let segs = []; try { segs = x.li.segments || []; } catch (e) {}
        const link = segs.find((s) => s && s.type === "linkobj" && s.text && typeof s.text.link === "string" && s.text.link.indexOf(this.BACKLINK_HOST) !== -1);
        if (!link) continue;
        let u; try { u = new URL(link.text.link); } catch (e) { continue; }
        if (fingerprint && u.searchParams.get("pdf") !== fingerprint) continue;
        if (u.searchParams.get("link") === "1") continue;
        const hid = u.searchParams.get("hid") || "";
        if (hid && hid > bestHid) { bestHid = hid; bestPguid = x.row.pguid; }
      }
      return targetBlock(bestPguid);
    } catch (e) { return null; }
  }

  // =======================================================================
  // Shape markup: draw annotations over the page. Each shape is written to the note
  // as a "note" block — an empty line to write WHY it's there, plus a backlink whose
  // URL carries the geometry — so shapes persist, sync and delete like highlights.
  // =======================================================================
  // The rail lives in THYMER's document, not the viewer iframe: the iframe is laid out at
  // full document height (its "viewport" is ~11000px tall — the panel does the scrolling),
  // so position:fixed inside it anchors to the whole document and lands off-screen.
  // Here it's fixed to the real window and kept aligned over the PDF panel.
  _injectToolRail(hook) {
    const doc = document;
    try { (hook.rail || {}).remove && hook.rail.remove(); } catch (e) {}
    const rail = doc.createElement("div");
    rail.className = "pdfhl-tools";
    // Styled INLINE, not via the injected stylesheet: a stale/missing stylesheet would
    // otherwise render the rail as invisible unstyled markup.
    rail.style.cssText = "position:fixed;left:-9999px;top:0;transform:translateY(-50%);" +
      "z-index:2147483646;display:flex;flex-direction:column;gap:2px;padding:5px;border-radius:4px;" +
      "background:var(--side-bg-color,#1c1f22);border:1px solid var(--color-bg-600,#33383c);" +
      "box-shadow:0 8px 28px rgba(0,0,0,.42);";
    // Two fly-out buttons instead of one button per tool, so the rail stays short. Each
    // shows the CURRENTLY SELECTED item's icon, so the rail always says what a drag does.
    const mkBtn = (cls, onClick) => {
      const b = doc.createElement("button");
      b.className = "pdfhl-tool " + cls;
      this._styleToolButton(b, false);
      b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
      if (onClick) b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(b); });
      rail.appendChild(b);
      return b;
    };
    // A click ACTIVATES the button's current tool. The menu is for changing which tool
    // that is, so it opens from the bottom edge (where the corner marker sits) or a
    // right-click — you should never have to walk through a menu to use the same tool twice.
    const wireSplit = (b2, activate, openMenu) => {
      b2.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        const r = b2.getBoundingClientRect();
        if (e.clientY >= r.bottom - 9) openMenu(b2); else { this._closeFlyout(); activate(); }
      });
      b2.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); openMenu(b2); });
    };

    // Select: plain text selection (copy without marking) and picking shapes. No fly-out.
    const selBtn = mkBtn("pdfhl-select-btn", () => { this._closeFlyout(); this._setTool(hook, "select"); });
    selBtn.title = "Select";
    selBtn.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18"><path d="M5.5 3.2 L14.6 9.8 L10.4 10.5 L12.7 15 L10.9 15.9 L8.7 11.4 L5.5 14.1 Z" fill="currentColor"/></svg>';
    const textBtn = mkBtn("pdfhl-text-btn", null);
    wireSplit(textBtn,
      () => this._setTool(hook, "text"),
      (b) => this._openFlyout(hook, b, [
        { items: this.TEXT_MARKS, current: this._textMark },
        { items: this.NOTE_MODES, current: this._noteMode },
      ], (k) => this._setTextChoice(hook, k)));
    const shapeBtn = mkBtn("pdfhl-shape-btn", null);
    wireSplit(shapeBtn,
      () => this._setShapeTool(hook, this._shapeTool),
      (b) => this._openFlyout(hook, b, [
        { items: this.SHAPE_TOOLS, current: this._isShapeTool() ? this._tool : this._shapeTool },
      ], (k) => this._setShapeTool(hook, k)));
    // Style button: opens the colour / fill / thickness / opacity panel.
    const sep = doc.createElement("div");
    sep.style.cssText = "height:1px;background:rgba(128,128,128,.4);margin:5px 3px;";
    rail.appendChild(sep);
    const style = doc.createElement("button");
    style.className = "pdfhl-tool pdfhl-style-btn";
    style.title = "Style";
    this._styleToolButton(style, false);
    style.innerHTML = '<span class="pdfhl-style-dot" style="width:15px;height:15px;border-radius:4px;display:block;box-shadow:inset 0 0 0 1px rgba(128,128,128,.6),0 0 0 1.5px var(--side-bg-color,#1c1f22),0 0 0 3px rgba(128,128,128,.45);"></span>';
    style.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    style.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); this._toggleStylePanel(hook, style); });
    rail.appendChild(style);
    const help = mkBtn("pdfhl-help-btn", (b2) => this._toggleShortcuts(hook, b2));
    help.title = "Shortcuts";
    help.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18"><circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7.9 8.1 A2.2 2.2 0 1 1 10.3 10.6 V11.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="10.3" cy="14.3" r="0.9" fill="currentColor"/></svg>';
    doc.body.appendChild(rail);
    hook.rail = rail;
    this._positionToolRail(hook);
    this._syncToolRails();
    this._paintStyleDot();

    // Keep it over the panel as panels resize/move (drag a splitter, toggle the sidebar).
    const reposition = () => this._positionToolRail(hook);
    window.addEventListener("resize", reposition, true);
    const railTimer = setInterval(reposition, 400);
    this._cleanups.push(() => {
      try { window.removeEventListener("resize", reposition, true); } catch (e) {}
      try { clearInterval(railTimer); } catch (e) {}
      try { rail.remove(); } catch (e) {}
    });
  }

  // Style panel: colour, fill, thickness, opacity for NEW shapes (and it re-styles the
  // selected shape, so you can adjust one after the fact).
  _toggleStylePanel(hook, anchorEl, opts) {
    const atPoint = !!(opts && opts.x != null);
    if (this._stylePanel && this._stylePanel.isConnected) {
      this._closeStylePanel();
      if (!atPoint) return; // clicking the rail button again just closes it
    }
    const doc = document;
    const p = doc.createElement("div");
    p.className = "pdfhl-style-panel";
    p.style.cssText = "position:fixed;z-index:2147483647;border-radius:4px;padding:13px;width:176px;" +
      "background:var(--side-bg-color,#1c1f22);color:var(--color-text-100,#c5cac6);" +
      "border:1px solid var(--color-bg-600,#33383c);box-shadow:0 10px 32px rgba(0,0,0,.5);" +
      "font:12.5px/1.4 var(--font-sans,system-ui),system-ui,-apple-system,sans-serif;";

    const label = (t) => {
      const l = doc.createElement("div");
      l.textContent = t;
      l.style.cssText = "color:var(--color-text-700,#636965);font-size:10.5px;letter-spacing:.05em;" +
        "text-transform:uppercase;font-weight:600;margin:0 0 8px;";
      return l;
    };
    // The panel edits whatever you are actually working on: a selected shape, the armed
    // shape tool, or — with the Text tool — the colour new highlights get.
    const shapeCtx = !!(hook && hook.selectedShape) || this._isShapeTool();
    if (!this._styleSnapshot) { // Esc restores this
      const selHid = (hook && hook.selectedShape) || null;
      const selEntry = selHid ? (this._getStore()[hook.fingerprint] || []).find((h) => h.hid === selHid && h.shape) : null;
      this._styleSnapshot = {
        hlColor: this._hlColor, shapeColor: this._shapeColor, shapeWidth: this._shapeWidth,
        shapeFill: this._shapeFill, shapeOpacity: this._shapeOpacity, shapeDash: this._shapeDash,
        hid: selHid,
        shape: selEntry ? { stroke: selEntry.shape.stroke, sw: selEntry.shape.sw, fill: selEntry.shape.fill, op: selEntry.shape.op, dash: selEntry.shape.dash } : null,
      };
    }
    const palette = shapeCtx ? this.SHAPE_COLORS : this.COLORS;
    const hlHid = (!shapeCtx && opts && opts.highlightHid) || null;
    const hlEntry = hlHid ? (this._getStore()[hook.fingerprint] || []).find((h) => h.hid === hlHid) : null;
    const currentColor = shapeCtx ? this._shapeColor : (hlEntry ? hlEntry.color : this._hlColor);
    const markKind = hlEntry ? (hlEntry.mark || "fill") : this._textMark;
    const markW = hlEntry ? (hlEntry.mw || 6) : this._markWidth;
    const rule = () => {
      const d = doc.createElement("div");
      d.style.cssText = "height:1px;background:var(--divider-color,rgba(201,206,201,.07));margin:0 0 13px;";
      return d;
    };
    // --- colours (4px squares, per the house radius) ---
    p.appendChild(label(shapeCtx ? "Shape Colour" : "Highlight Colour"));
    const sw = doc.createElement("div");
    sw.style.cssText = "display:grid;grid-template-columns:repeat(" + this._swatchCols(palette.length) + ",minmax(0,1fr));gap:8px;margin-bottom:13px;";
    for (const c of palette) {
      const b = doc.createElement("button");
      b.title = c.label;
      b.style.cssText = "width:100%;aspect-ratio:1;padding:0;border:0;border-radius:4px;cursor:pointer;display:block;background:rgb(" + c.rgb + ");" +
        (c.key === currentColor
          ? "box-shadow:0 0 0 2px var(--side-bg-color,#1c1f22),0 0 0 3.5px var(--color-primary-500,#6fae9e);"
          : "box-shadow:inset 0 0 0 1px rgba(128,128,128,.6);");
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (shapeCtx) this._setShapeStyle(hook, { stroke: c.key });
        else if (hlHid) { this._setHlColor(c.key); this._paintStyleDot(); this._restyleHighlight(hook, hlHid, { color: c.key }); }
        else { this._setHlColor(c.key); this._paintStyleDot(); }
        this._closeStylePanel(true); this._toggleStylePanel(hook, anchorEl, opts); // reopen with the new state
      });
      sw.appendChild(b);
    }
    p.appendChild(sw);
    const slider = (text, min, max, step, value, onInput, preview) => {
      const wrap = doc.createElement("div");
      wrap.style.cssText = "margin-bottom:13px;";
      const head = doc.createElement("div");
      head.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;";
      const name = doc.createElement("span");
      name.textContent = text;
      name.style.cssText = "color:var(--color-text-700,#636965);font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;font-weight:600;";
      const val = doc.createElement("span");
      val.style.cssText = "color:var(--color-text-100,#c5cac6);font-size:11.5px;font-variant-numeric:tabular-nums;";
      head.appendChild(name); head.appendChild(val);
      wrap.appendChild(head);
      if (preview) wrap.appendChild(preview);
      const inp = doc.createElement("input");
      inp.type = "range"; inp.min = min; inp.max = max; inp.step = step; inp.value = value;
      inp.style.cssText = "width:100%;margin:0;cursor:pointer;accent-color:var(--color-text-400,#9aa19b);";
      const show = () => { val.textContent = onInput.format(inp.value); };
      show();
      inp.addEventListener("input", () => { show(); onInput.apply(inp.value); });
      wrap.appendChild(inp);
      return wrap;
    };
    if (shapeCtx) { // stroke weight, fill and opacity mean nothing for a text highlight
    p.appendChild(rule());
    // --- fill: a proper switch, not a system checkbox (which looks alien in Thymer) ---
    const fillRow = doc.createElement("div");
    fillRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:13px;cursor:pointer;";
    const fillTxt = doc.createElement("span");
    fillTxt.textContent = "Fill Shape";
    fillTxt.style.cssText = "color:var(--color-text-100,#c5cac6);";
    const track = doc.createElement("span");
    const knob = doc.createElement("span");
    const paintSwitch = () => {
      const on = !!this._shapeFill;
      track.style.cssText = "width:30px;height:18px;border-radius:4px;display:flex;align-items:center;padding:0 2px;" +
        "box-sizing:border-box;transition:background 90ms ease;justify-content:" + (on ? "flex-end" : "flex-start") + ";" +
        (on ? "background:var(--color-primary-600,#568c7e);border:1px solid var(--color-primary-600,#568c7e);"
            : "background:var(--input-bg-color,#101110);border:1px solid var(--color-bg-600,#33383c);");
      knob.style.cssText = "width:12px;height:12px;border-radius:3px;display:block;background:" +
        (on ? "var(--color-primary-text-100,#fff)" : "var(--color-text-700,#636965)") + ";";
    };
    paintSwitch();
    track.appendChild(knob);
    fillRow.appendChild(fillTxt); fillRow.appendChild(track);
    fillRow.addEventListener("mousedown", (e) => e.preventDefault());
    fillRow.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      this._setShapeStyle(hook, { fill: !this._shapeFill });
      paintSwitch();
    });
    p.appendChild(fillRow);
    // --- line type: previews rather than words, so you pick what you can see ---
    p.appendChild(label("Line"));
    const dashRow = doc.createElement("div");
    dashRow.style.cssText = "display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-bottom:13px;";
    for (const d of [{ k: "solid", d: "" }, { k: "dashed", d: "7,5" }, { k: "dotted", d: "0.01,5" }, { k: "dashdot", d: "7,4,0.01,4" }]) {
      const b2 = doc.createElement("button");
      b2.title = d.k.charAt(0).toUpperCase() + d.k.slice(1);
      const on = (this._shapeDash || "solid") === d.k;
      b2.style.cssText = "height:26px;padding:0;border:0;border-radius:4px;cursor:pointer;display:flex;align-items:center;" +
        "justify-content:center;background:var(--input-bg-color,#101110);" +
        (on ? "box-shadow:0 0 0 1.5px var(--color-primary-500,#6fae9e);" : "box-shadow:inset 0 0 0 1px rgba(128,128,128,.35);");
      b2.innerHTML = '<svg viewBox="0 0 34 10" width="30" height="10"><path d="M2 5 H32" fill="none" stroke="' +
        (on ? "var(--color-primary-500,#6fae9e)" : "var(--color-text-400,#9aa19b)") + '" stroke-width="2.4" stroke-linecap="round"' +
        (d.d ? ' stroke-dasharray="' + d.d + '"' : "") + "/></svg>";
      b2.addEventListener("mousedown", (e) => e.preventDefault());
      b2.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        this._setShapeStyle(hook, { dash: d.k });
        this._closeStylePanel(true); this._toggleStylePanel(hook, anchorEl, opts);
      });
      dashRow.appendChild(b2);
    }
    p.appendChild(dashRow);

    // --- thickness + opacity. Sliders stay NEUTRAL: the accent means "active tool" and
    // "selected shape", so spending it on every control would drown that signal. ---
    // Thickness is stored as a fraction of page width; show it as a plain 1-12 scale, with
    // a live stroke above the slider so the number means something.
    const strokeBox = doc.createElement("div");
    strokeBox.style.cssText = "height:22px;border-radius:4px;background:var(--input-bg-color,#101110);" +
      "display:flex;align-items:center;padding:0;margin-bottom:8px;overflow:hidden;";
    const strokeBar = doc.createElement("span");
    const paintStroke = () => {
      const px = Math.max(2, Math.round(this._shapeWidth / 0.0008));
      strokeBar.style.cssText = "width:100%;display:block;border-radius:2px;height:" + px + "px;" +
        "background:rgb(" + this._shapeRgb(this._shapeColor) + ");";
    };
    paintStroke();
    strokeBox.appendChild(strokeBar);
    this._paintStroke = paintStroke;
    p.appendChild(slider("Thickness", 1, 12, 1, Math.round(this._shapeWidth / 0.0008), {
      format: (v) => String(v),
      apply: (v) => { this._setShapeStyle(hook, { sw: Number(v) * 0.0008 }); paintStroke(); },
    }, strokeBox));
    p.appendChild(slider("Opacity", 20, 100, 5, Math.round((this._shapeOpacity != null ? this._shapeOpacity : 1) * 100), {
      format: (v) => v + "%",
      apply: (v) => this._setShapeStyle(hook, { op: Number(v) / 100 }),
    }));
    }

    if (!shapeCtx && (markKind === "underline" || markKind === "strike")) { // these have a weight worth tuning
      p.appendChild(slider("Thickness", 1, 12, 1, markW, {
        format: (v) => String(v),
        apply: (v) => {
          const n = Number(v);
          this._markWidth = n;
          try { window.localStorage.setItem("pdfhl_markWidth", String(n)); } catch (e) {}
          if (hlHid) this._restyleHighlight(hook, hlHid, { mw: n });
        },
      }));
    }
    if (opts && opts.deleteHid) { // right-clicked a shape: styling and removal in one place
      p.appendChild(rule());
      const del = doc.createElement("button");
      del.className = "pdfhl-del-btn";
      del.textContent = shapeCtx ? "Delete Shape" : "Delete Highlight";
      del.addEventListener("mousedown", (e) => e.preventDefault());
      del.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        const hid = opts.deleteHid;
        this._closeStylePanel();
        if (hook && hook.selectedShape === hid) hook.selectedShape = null;
        this._deleteHighlight(hook, hid);
      });
      p.appendChild(del);
    }
    doc.body.appendChild(p);
    // Sit beside the rail button, clamped to the window.
    const a = anchorEl ? anchorEl.getBoundingClientRect() : { right: 0, top: 0 };
    const pw = p.offsetWidth || 176, ph = p.offsetHeight || 240;
    // At the cursor when opened by right-click, otherwise top-aligned with its button.
    const lx = atPoint ? opts.x + 2 : a.right + 8;
    const ly = atPoint ? opts.y + 2 : a.top;
    p.style.left = Math.max(8, Math.min(lx, window.innerWidth - pw - 8)) + "px";
    p.style.top = Math.max(8, Math.min(ly, window.innerHeight - ph - 8)) + "px";
    this._stylePanel = p;
    // Any click outside closes it.
    const away = (e) => { if (!p.contains(e.target) && (!anchorEl || (e.target !== anchorEl && !anchorEl.contains(e.target)))) this._closeStylePanel(); };
    setTimeout(() => document.addEventListener("mousedown", away, true), 0);
    this._stylePanelAway = away;
    const onKey = (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); this._closeStylePanel(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this._revertStyleEdits(hook); this._closeStylePanel(); }
    };
    document.addEventListener("keydown", onKey, true);
    this._styleKey = onKey;
  }

  _closeStylePanel(keepSnapshot) {
    try { if (this._stylePanel) this._stylePanel.remove(); } catch (e) {}
    try { if (this._stylePanelAway) document.removeEventListener("mousedown", this._stylePanelAway, true); } catch (e) {}
    try { if (this._styleKey) document.removeEventListener("keydown", this._styleKey, true); } catch (e) {}
    this._stylePanel = null; this._stylePanelAway = null; this._styleKey = null;
    if (!keepSnapshot) this._styleSnapshot = null;
  }

  // Esc: put everything back the way it was when the panel opened.
  _revertStyleEdits(hook) {
    const s = this._styleSnapshot;
    if (!s) return;
    this._hlColor = s.hlColor; this._shapeColor = s.shapeColor; this._shapeWidth = s.shapeWidth;
    this._shapeFill = s.shapeFill; this._shapeOpacity = s.shapeOpacity; this._shapeDash = s.shapeDash;
    try {
      window.localStorage.setItem("pdfhl_hlColor", s.hlColor);
      window.localStorage.setItem("pdfhl_shapeColor", s.shapeColor);
      window.localStorage.setItem("pdfhl_shapeWidth", String(s.shapeWidth));
      window.localStorage.setItem("pdfhl_shapeFill", s.shapeFill ? "1" : "0");
      window.localStorage.setItem("pdfhl_shapeOpacity", String(s.shapeOpacity));
      window.localStorage.setItem("pdfhl_shapeDash", s.shapeDash || "solid");
    } catch (e) {}
    if (s.hid && s.shape) this._restyleShape(hook, s.hid, s.shape);
    this._paintStyleDot();
    this._redrawShapes(hook);
  }

  // Apply a style change to the defaults for new shapes — and, if one is selected, to it.
  _setShapeStyle(hook, patch) {
    if (patch.stroke != null) this._shapeColor = patch.stroke;
    if (patch.sw != null) this._shapeWidth = patch.sw;
    if (patch.fill != null) this._shapeFill = !!patch.fill;
    if (patch.op != null) this._shapeOpacity = patch.op;
    if (patch.dash != null) this._shapeDash = patch.dash;
    try {
      window.localStorage.setItem("pdfhl_shapeColor", this._shapeColor);
      window.localStorage.setItem("pdfhl_shapeWidth", String(this._shapeWidth));
      window.localStorage.setItem("pdfhl_shapeFill", this._shapeFill ? "1" : "0");
      window.localStorage.setItem("pdfhl_shapeOpacity", String(this._shapeOpacity));
      window.localStorage.setItem("pdfhl_shapeDash", this._shapeDash);
    } catch (e) {}
    this._paintStyleDot();
    if (hook && hook.selectedShape) this._restyleShape(hook, hook.selectedShape, patch);
    else this._redrawShapes(hook);
  }

  _paintStyleDot() {
    const rgb = this._isShapeTool()
      ? this._shapeRgb(this._shapeColor)
      : ((this.COLORS.find((c) => c.key === this._hlColor) || this.COLORS[0]).rgb);
    document.querySelectorAll(".pdfhl-style-dot").forEach((d) => { d.style.background = "rgb(" + rgb + ")"; });
    try { if (this._paintStroke) this._paintStroke(); } catch (e) {}
  }

  // Restyle an existing shape: update the store, redraw, and rewrite the style params in
  // the note's backlink so the change survives (the note is the durable source).
  async _restyleShape(hook, hid, patch) {
    const store = this._getStore();
    const entry = (store[hook.fingerprint] || []).find((h) => h.hid === hid && h.shape);
    if (!entry) return;
    Object.assign(entry.shape, patch);
    this._setStore(store);
    this._redrawShapes(hook);
    try {
      const note = this._findAssociatedNote(hook.iframe);
      if (!note) return;
      const items = (await note.getLineItems()) || [];
      for (const li of items) {
        const segs = li.segments || [];
        const has = segs.some((s) => s && s.type === "linkobj" && s.text && typeof s.text.link === "string" && s.text.link.indexOf("hid=" + hid) !== -1);
        if (!has) continue;
        li.setSegments(segs.map((s) => {
          if (!(s.type === "linkobj" && s.text && typeof s.text.link === "string" && s.text.link.indexOf("hid=" + hid) !== -1)) return { type: s.type, text: s.text };
          let link = s.text.link;
          const set = (k, v) => {
            link = link.indexOf("&" + k + "=") !== -1
              ? link.replace(new RegExp("([?&]" + k + "=)[^&]*"), "$1" + v)
              : link + "&" + k + "=" + v;
          };
          if (patch.geom != null) set("geom", this._encShapeGeom({ geom: patch.geom }));
          if (patch.stroke != null) set("stroke", patch.stroke);
          if (patch.sw != null) set("sw", Number(patch.sw).toFixed(5));
          if (patch.dash != null) set("ls", patch.dash);
          if (patch.fill != null) set("fill", patch.fill ? 1 : 0);
          if (patch.op != null) set("op", Number(patch.op).toFixed(2));
          return { type: "linkobj", text: { link, title: s.text.title } };
        }));
        break;
      }
    } catch (e) {}
  }

  // Change an existing text mark (colour or weight): store, overlay and the note's link.
  async _restyleHighlight(hook, hid, patch) {
    const store = this._getStore();
    const entry = (store[hook.fingerprint] || []).find((h) => h.hid === hid);
    if (!entry) return;
    if (patch.color != null) entry.color = patch.color;
    if (patch.mw != null) entry.mw = patch.mw;
    this._setStore(store);
    this._redrawOverlays(hook);
    try {
      const note = this._findAssociatedNote(hook.iframe);
      if (!note) return;
      const items = (await note.getLineItems()) || [];
      for (const li of items) {
        const segs = li.segments || [];
        const has = segs.some((sg) => sg && sg.type === "linkobj" && sg.text && typeof sg.text.link === "string" && sg.text.link.indexOf("hid=" + hid) !== -1);
        if (!has) continue;
        li.setSegments(segs.map((sg) => {
          if (!(sg.type === "linkobj" && sg.text && typeof sg.text.link === "string" && sg.text.link.indexOf("hid=" + hid) !== -1)) return { type: sg.type, text: sg.text };
          let link = sg.text.link;
          const set = (k, v) => {
            link = link.indexOf("&" + k + "=") !== -1 || link.indexOf("?" + k + "=") !== -1
              ? link.replace(new RegExp("([?&]" + k + "=)[^&]*"), "$1" + v)
              : link + "&" + k + "=" + v;
          };
          if (patch.color != null) set("color", patch.color);
          if (patch.mw != null) set("mw", patch.mw);
          return { type: "linkobj", text: { link: link, title: sg.text.title } };
        }));
        break;
      }
    } catch (e) {}
  }

  // Every gesture in one place, for when you forget which modifier does what.
  _toggleShortcuts(hook, anchorEl) {
    if (this._shortcuts && this._shortcuts.isConnected) { this._closeShortcuts(); return; }
    this._closeFlyout(); this._closeStylePanel();
    const doc = document;
    const p = doc.createElement("div");
    p.className = "pdfhl-shortcuts";
    p.style.cssText = "position:fixed;z-index:2147483647;border-radius:4px;padding:13px;width:290px;" +
      "max-height:70vh;overflow:auto;background:var(--side-bg-color,#1c1f22);color:var(--color-text-100,#c5cac6);" +
      "border:1px solid var(--color-bg-600,#33383c);box-shadow:0 10px 32px rgba(0,0,0,.5);" +
      "font:12.5px/1.5 var(--font-sans,system-ui),system-ui,-apple-system,sans-serif;";
    const SECTIONS = [
      ["Text", [
        ["Drag", "Mark the selection"],
        ["⌘ + drag", "Merge into the previous quote"],
        ["⌥ + drag", "Comment block instead of a quote"],
        ["Area + drag", "Box a region and capture its text"],
        ["Shift + boxes", "Scanned pages: OCR several boxes as one"],
      ]],
      ["Shapes", [
        ["Drag", "Draw the selected shape"],
        ["Esc", "Cancel the shape being drawn"],
      ]],
      ["Select", [
        ["Click", "Select a shape"],
        ["Drag", "Move it"],
        ["Drag a handle", "Resize it"],
        ["Delete", "Remove the selected shape"],
        ["Right-click", "Style panel for a shape or highlight"],
      ]],
      ["Style panel", [
        ["Enter", "Keep the changes"],
        ["Esc", "Undo them"],
      ]],
      ["Tool rail", [
        ["Click", "Use the tool shown"],
        ["Bottom edge", "Open its menu"],
        ["Right-click", "Open its menu"],
      ]],
    ];
    for (let i = 0; i < SECTIONS.length; i++) {
      if (i) {
        const sep = doc.createElement("div");
        sep.style.cssText = "height:1px;background:rgba(128,128,128,.28);margin:11px 0;";
        p.appendChild(sep);
      }
      const h = doc.createElement("div");
      h.textContent = SECTIONS[i][0];
      h.style.cssText = "color:var(--color-text-700,#636965);font-size:10.5px;letter-spacing:.05em;" +
        "text-transform:uppercase;font-weight:600;margin:0 0 7px;";
      p.appendChild(h);
      for (const row of SECTIONS[i][1]) {
        const r = doc.createElement("div");
        r.style.cssText = "display:flex;gap:10px;align-items:baseline;margin-bottom:5px;";
        r.innerHTML = '<span style="flex:0 0 96px;color:var(--color-text-50,#dfe3e0);' +
          'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;">' + row[0] + "</span>" +
          '<span style="flex:1 1 auto;color:var(--color-text-400,#9aa19b);">' + row[1] + "</span>";
        p.appendChild(r);
      }
    }
    doc.body.appendChild(p);
    const a = anchorEl.getBoundingClientRect();
    const pw = p.offsetWidth || 290, ph = p.offsetHeight || 380;
    p.style.left = Math.max(8, Math.min(a.right + 8, window.innerWidth - pw - 8)) + "px";
    p.style.top = Math.max(8, Math.min(a.top - ph + a.height, window.innerHeight - ph - 8)) + "px";
    this._shortcuts = p;
    const away = (e) => { if (!p.contains(e.target) && !anchorEl.contains(e.target)) this._closeShortcuts(); };
    setTimeout(() => document.addEventListener("mousedown", away, true), 0);
    this._shortcutsAway = away;
  }

  _closeShortcuts() {
    try { if (this._shortcuts) this._shortcuts.remove(); } catch (e) {}
    try { if (this._shortcutsAway) document.removeEventListener("mousedown", this._shortcutsAway, true); } catch (e) {}
    this._shortcuts = null; this._shortcutsAway = null;
  }

  // Anchor the rail to the left edge of the panel holding this viewer.
  _positionToolRail(hook) {
    const rail = hook.rail;
    if (!rail || !rail.isConnected) return;
    let box = null;
    try {
      const p = this.ui.getPanels().find((pp) => {
        try { return pp.getElement() && pp.getElement().contains(hook.iframe); } catch (e) { return false; }
      });
      const el = p && p.getElement();
      if (el) box = el.getBoundingClientRect();
    } catch (e) {}
    if (!box || !box.width || !hook.iframe.isConnected) { rail.style.left = "-9999px"; return; }
    rail.style.left = Math.round(box.left + 12) + "px";
    rail.style.top = Math.round(box.top + box.height / 2) + "px";
  }

  _styleToolButton(b, active) {
    b.style.cssText = "position:relative;display:flex;align-items:center;justify-content:center;width:28px;height:28px;" +
      "padding:0;border:0;border-radius:4px;cursor:pointer;background:transparent;" +
      "transition:background 90ms ease,color 90ms ease;color:" +
      (active ? "var(--color-primary-500,#6fae9e)" : "var(--color-text-400,#9aa19b)") + ";";
    if (active) this._selectedTint(b);
  }

  // Is the UI sitting on a light surface? Measured from what is actually rendered, since a
  // token can chain through other vars. A 16% tint that reads well on a dark rail nearly
  // disappears on a white one, so the "selected" tint leans harder in light themes.
  _themeIsLight() {
    try {
      let n = document.querySelector(".pdfhl-tools") || document.body;
      while (n) {
        const m = String(getComputedStyle(n).backgroundColor || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (m && (m[4] === undefined || parseFloat(m[4]) > 0.5)) {
          return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255 > 0.5;
        }
        n = n.parentElement;
      }
    } catch (e) {}
    return false;
  }

  // Background for a selected tool / selected menu row, in both flavours.
  _selectedTint(el) {
    const pct = this._themeIsLight() ? 32 : 16;
    if (el) {
      el.style.background = this._accentRgba(pct / 100); // fallback first
      el.style.background = "color-mix(in srgb, var(--color-primary-500,#6fae9e) " + pct + "%, transparent)";
    }
  }

  // The theme's contrast colour, read from Thymer's document. The shape SVG lives inside
  // the viewer iframe, which does NOT inherit Thymer's CSS variables, so the value has to
  // be resolved here and passed in as a literal.
  _accentRgba(alpha) {
    let raw = "";
    try { raw = (getComputedStyle(document.documentElement).getPropertyValue("--color-primary-500") || "").trim(); } catch (e) {}
    let r = 111, g = 174, b = 158; // sensible default if the token is missing
    const hex = raw.replace("#", "");
    if (/^[0-9a-f]{6}$/i.test(hex)) {
      r = parseInt(hex.slice(0, 2), 16); g = parseInt(hex.slice(2, 4), 16); b = parseInt(hex.slice(4, 6), 16);
    } else if (/^[0-9a-f]{3}$/i.test(hex)) {
      r = parseInt(hex[0] + hex[0], 16); g = parseInt(hex[1] + hex[1], 16); b = parseInt(hex[2] + hex[2], 16);
    } else {
      const m = raw.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
      if (m) { r = +m[1]; g = +m[2]; b = +m[3]; }
    }
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }

  // Tool choice is global, but each open viewer has its own rail — keep them in step.
  // A fly-out list shared by the Text and Shapes buttons: icon, label, tick on the current
  // one. Opens TOP-ALIGNED with its button rather than centred on it.
  _openFlyout(hook, anchorEl, groups, onPick) {
    const reopening = this._flyoutFor === anchorEl && this._flyout && this._flyout.isConnected;
    this._closeFlyout();
    this._closeStylePanel();
    if (reopening) return; // clicking the same button again just closes it
    const doc = document;
    const m = doc.createElement("div");
    m.className = "pdfhl-flyout";
    m.style.cssText = "position:fixed;z-index:2147483647;border-radius:4px;padding:5px;min-width:178px;" +
      "background:var(--side-bg-color,#1c1f22);border:1px solid var(--color-bg-600,#33383c);" +
      "box-shadow:0 10px 32px rgba(0,0,0,.5);font:12.5px/1.4 var(--font-sans,system-ui),system-ui,sans-serif;";
    let first = true;
    for (const grp of groups) {
      if (!first) {
        const sep = doc.createElement("div");
        // Neutral grey, not the theme divider token — that one is barely a whisper
        // (5% alpha), and these two sections mean different things.
        sep.style.cssText = "height:1px;background:rgba(128,128,128,.4);margin:7px 4px;";
        m.appendChild(sep);
      }
      first = false;
      for (const it of grp.items) {
      const on = it.key === grp.current;
      const row = doc.createElement("div");
      row.className = "pdfhl-flyout-row";
      row.style.cssText = "display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:4px;cursor:pointer;" +
        "color:var(--color-text-" + (on ? "50,#dfe3e0" : "100,#c5cac6") + ");";
      if (on) this._selectedTint(row); // same tint the active rail button wears
      row.innerHTML =
        '<span style="display:flex;color:' + (on ? "var(--color-primary-500,#6fae9e)" : "var(--color-text-400,#9aa19b)") + ';">' +
        '<svg viewBox="0 0 20 20" width="18" height="18">' + it.svg + "</svg></span>" +
        '<span style="flex-grow:1;">' + it.label + "</span>" +
        (on ? '<span style="display:flex;color:var(--color-primary-500,#6fae9e);"><svg viewBox="0 0 20 20" width="14" height="14"><path d="M4 10.5 L8 14.5 L16 5.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' : "");
      row.addEventListener("mousedown", (e) => e.preventDefault());
      row.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); this._closeFlyout(); onPick(it.key); });
      m.appendChild(row);
      }
    }
    doc.body.appendChild(m);
    const a = anchorEl.getBoundingClientRect();
    const mw = m.offsetWidth || 178, mh = m.offsetHeight || 120;
    m.style.left = Math.min(a.right + 8, window.innerWidth - mw - 8) + "px";
    m.style.top = Math.max(8, Math.min(a.top, window.innerHeight - mh - 8)) + "px";
    this._flyout = m; this._flyoutFor = anchorEl;
    const away = (e) => { if (!m.contains(e.target) && !anchorEl.contains(e.target)) this._closeFlyout(); };
    setTimeout(() => document.addEventListener("mousedown", away, true), 0);
    this._flyoutAway = away;
  }

  _closeFlyout() {
    try { if (this._flyout) this._flyout.remove(); } catch (e) {}
    try { if (this._flyoutAway) document.removeEventListener("mousedown", this._flyoutAway, true); } catch (e) {}
    this._flyout = null; this._flyoutAway = null; this._flyoutFor = null;
  }

  // The Text menu holds two independent choices: how the PDF is marked, and what the note
  // gets. They combine — e.g. Underline + Comment underlines the passage and gives you an
  // empty block to write in.
  _setTextChoice(hook, key) {
    if (this.NOTE_MODES.some((n) => n.key === key)) {
      this._noteMode = key;
      try { window.localStorage.setItem("pdfhl_noteMode", key); } catch (e) {}
      this._tool = "text";
      this._syncToolRails();
      return;
    }
    this._setTextMark(hook, key);
  }

  // Marking text: which treatment a selection gets. Always returns to text mode.
  _setTextMark(hook, key) {
    this._textMark = key;
    try { window.localStorage.setItem("pdfhl_textMark", key); } catch (e) {}
    this._tool = "text";
    this._cancelShape(hook);
    this._syncToolRails();
  }

  // Picking a shape both remembers it and arms it.
  _setShapeTool(hook, key) {
    this._shapeTool = key;
    this._tool = key;
    try { window.localStorage.setItem("pdfhl_shapeTool", key); } catch (e) {}
    this._cancelShape(hook);
    this._syncToolRails();
  }

  _syncToolRails() {
    // Each rail button wears the icon of whatever is currently selected inside it.
    const mark = this.TEXT_MARKS.find((m) => m.key === this._textMark) || this.TEXT_MARKS[0];
    const shape = this.SHAPE_TOOLS.find((s) => s.key === (this._isShapeTool() ? this._tool : this._shapeTool)) || this.SHAPE_TOOLS[0];
    const caret = '<span style="position:absolute;right:2px;bottom:2px;line-height:0;opacity:.75;"><svg viewBox="0 0 6 6" width="5" height="5"><path d="M6 6 L0 6 L6 0 Z" fill="currentColor"/></svg></span>';
    document.querySelectorAll(".pdfhl-tools").forEach((rail) => {
      const selb = rail.querySelector(".pdfhl-select-btn");
      if (selb) this._styleToolButton(selb, this._tool === "select");
      const tb = rail.querySelector(".pdfhl-text-btn");
      if (tb) {
        this._styleToolButton(tb, this._tool === "text");
        tb.title = mark.label;
        tb.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18">' + mark.svg + "</svg>" + caret;
      }
      const sb = rail.querySelector(".pdfhl-shape-btn");
      if (sb) {
        this._styleToolButton(sb, this._isShapeTool());
        sb.title = shape.label;
        sb.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18">' + shape.svg + "</svg>" + caret;
      }
    });
    this._paintStyleDot();
    // ...the crosshair belongs on the pages inside each viewer.
    document.querySelectorAll("iframe.id--pdf-viewer").forEach((fr) => {
      try {
        const d = fr.contentDocument;
        if (d && d.body) d.body.classList.toggle("pdfhl-armed", this._isShapeTool() || (this._tool === "text" && this._textMark === "area"));
      } catch (e) {}
    });
  }

  // "select" and "text" are selection modes; anything else draws.
  _isShapeTool() { return this._tool !== "select" && this._tool !== "text"; }

  _setTool(hook, key) {
    this._tool = key;
    this._cancelShape(hook);
    this._syncToolRails();
  }

  _startShape(hook, pageEl, e) {
    e.preventDefault(); // no text selection while drawing
    const ref = pageEl.querySelector(".textLayer") || pageEl.querySelector("canvas");
    if (!ref) return;
    const box = ref.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const page = parseInt(pageEl.getAttribute("data-page-number"), 10) || this._currentPage(hook);
    const x = (e.clientX - box.left) / box.width, y = (e.clientY - box.top) / box.height;
    hook.drawing = { pageEl, page, box, type: this._tool, x0: x, y0: y, x1: x, y1: y, pts: [x, y] };
    this._redrawShapes(hook);
  }

  _updateShape(hook, e) {
    const d = hook.drawing; if (!d) return;
    const cl = (v) => Math.max(0, Math.min(1, v));
    d.x1 = cl((e.clientX - d.box.left) / d.box.width);
    d.y1 = cl((e.clientY - d.box.top) / d.box.height);
    if (d.type === "draw") {
      // Freehand: keep the trail, but decimate so the path stays short enough to ride
      // along in the backlink URL.
      const n = d.pts.length;
      const dx = d.x1 - d.pts[n - 2], dy = d.y1 - d.pts[n - 1];
      if (d.pts.length < 800 && (dx * dx + dy * dy) > 0.000012) d.pts.push(d.x1, d.y1);
    }
    this._redrawShapes(hook);
  }

  _cancelShape(hook) {
    if (!hook || !hook.drawing) return;
    hook.drawing = null;
    this._redrawShapes(hook);
  }

  _finishShape(hook, e) {
    const d = hook.drawing; if (!d) return;
    this._updateShape(hook, e);
    hook.drawing = null;
    const shape = this._drawingShape(d);
    this._redrawShapes(hook); // drop the preview; the committed shape redraws after saving
    if (shape.type === "draw") { if (shape.geom.length < 6) return; } // barely a stroke
    else {
      const bb = this._shapeBBox(shape);
      if (!bb || (bb.w < 0.008 && bb.h < 0.008)) return; // a click, not a drag
    }
    this._commitShape(hook, d.page, shape);
  }

  async _commitShape(hook, page, shape) {
    const note = this._findAssociatedNote(hook.iframe);
    if (!note) {
      this.ui.addToaster({ title: "No note found", message: "Open the PDF beside its note, then draw.", dismissible: true });
      return;
    }
    await this._commitExtract(hook, note, {
      paragraphs: [], page, color: this._currentColor(), rectsByPage: {}, mode: "link", shape,
    });
  }

  // The in-progress drag as a shape record (geometry normalised to the page's text layer).
  // Geometry per type: rect/ellipse [x,y,w,h]; line/arrow [x1,y1,x2,y2] (direction matters,
  // the arrowhead sits at the end); draw [x1,y1,x2,y2,…] along the stroke.
  _drawingShape(d) {
    const base = { type: d.type, stroke: this._shapeColor, sw: this._shapeWidth, fill: this._shapeFill, op: this._shapeOpacity, dash: this._shapeDash };
    if (d.type === "draw") return Object.assign(base, { geom: d.pts.slice() });
    if (d.type === "line" || d.type === "arrow") return Object.assign(base, { geom: [d.x0, d.y0, d.x1, d.y1] });
    return Object.assign(base, { geom: [Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)] });
  }

  // Normalised bounding box for any shape type (hit-testing, selection outline).
  _shapeBBox(shape) {
    const g = (shape && shape.geom) || [];
    if (g.length < 4) return null;
    if (shape.type === "rect" || shape.type === "ellipse") return { x: g[0], y: g[1], w: g[2], h: g[3] };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i + 1 < g.length; i += 2) {
      x0 = Math.min(x0, g[i]); x1 = Math.max(x1, g[i]);
      y0 = Math.min(y0, g[i + 1]); y1 = Math.max(y1, g[i + 1]);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // Geometry travels in the backlink URL as a flat comma list (rect/ellipse: x,y,w,h).
  _encShapeGeom(shape) { return (shape.geom || []).map((n) => Number(n).toFixed(4)).join(","); }
  _decShapeGeom(str) {
    const a = String(str || "").split(",").map(Number);
    return a.length && a.every((n) => !isNaN(n)) ? a : null;
  }

  // Column count that leaves no orphan swatch on the last row (5 -> one row of 5,
  // 8 -> two rows of 4).
  _swatchCols(n) {
    if (n <= 5) return n;
    if (n % 4 === 0) return 4;
    if (n % 3 === 0) return 3;
    return 4;
  }

  // Dash patterns are expressed in multiples of the stroke width so they hold their
  // rhythm at any weight and zoom. Dots are zero-length segments with round caps.
  _dashArray(kind, sw) {
    if (kind === "dashed") return (sw * 3.2) + "," + (sw * 2.4);
    if (kind === "dotted") return "0.01," + (sw * 2.1);
    if (kind === "dashdot") return (sw * 3.2) + "," + (sw * 1.8) + ",0.01," + (sw * 1.8);
    return null;
  }

  _shapeRgb(key) {
    const c = this.SHAPE_COLORS.find((x) => x.key === key);
    return c ? c.rgb : this.SHAPE_COLORS[0].rgb;
  }

  // One SVG element for a shape, in the page's pixel space (so stroke width is honest
  // and everything scales with zoom, since the layer is rebuilt on every render).
  _shapeEl(doc, shape, W, H, hid) {
    const NS = "http://www.w3.org/2000/svg";
    const g = shape.geom || [];
    const rgb = this._shapeRgb(shape.stroke);
    const sw = Math.max(1, (shape.sw || 0.003) * W);
    let el = null, head = null;
    if (shape.type === "rect" || shape.type === "ellipse") {
      const x = g[0] * W, y = g[1] * H, w = g[2] * W, h = g[3] * H;
      if (!(w > 0 && h > 0)) return null;
      if (shape.type === "rect") {
        el = doc.createElementNS(NS, "rect");
        el.setAttribute("x", x); el.setAttribute("y", y);
        el.setAttribute("width", w); el.setAttribute("height", h);
      } else {
        el = doc.createElementNS(NS, "ellipse");
        el.setAttribute("cx", x + w / 2); el.setAttribute("cy", y + h / 2);
        el.setAttribute("rx", w / 2); el.setAttribute("ry", h / 2);
      }
    } else if (shape.type === "line" || shape.type === "arrow") {
      if (g.length < 4) return null;
      const x1 = g[0] * W, y1 = g[1] * H, x2 = g[2] * W, y2 = g[3] * H;
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const hl = shape.type === "arrow" ? Math.max(7, sw * 3.2) : 0;
      // Stop the shaft just short of the head so it doesn't poke through the tip.
      const ex = x2 - Math.cos(ang) * hl * 0.8, ey = y2 - Math.sin(ang) * hl * 0.8;
      el = doc.createElementNS(NS, "line");
      el.setAttribute("x1", x1); el.setAttribute("y1", y1);
      el.setAttribute("x2", hl ? ex : x2); el.setAttribute("y2", hl ? ey : y2);
      el.setAttribute("stroke-linecap", "round");
      if (hl) {
        const a1 = ang + Math.PI - 0.42, a2 = ang + Math.PI + 0.42;
        head = doc.createElementNS(NS, "polygon");
        head.setAttribute("points", [
          x2 + "," + y2,
          (x2 + Math.cos(a1) * hl) + "," + (y2 + Math.sin(a1) * hl),
          (x2 + Math.cos(a2) * hl) + "," + (y2 + Math.sin(a2) * hl),
        ].join(" "));
        head.setAttribute("fill", "rgb(" + rgb + ")");
        head.setAttribute("stroke", "none");
      }
    } else if (shape.type === "draw") {
      if (g.length < 4) return null;
      const pts = [];
      for (let i = 0; i + 1 < g.length; i += 2) pts.push((g[i] * W) + "," + (g[i + 1] * H));
      el = doc.createElementNS(NS, "polyline");
      el.setAttribute("points", pts.join(" "));
      el.setAttribute("stroke-linecap", "round");
      el.setAttribute("stroke-linejoin", "round");
    }
    if (!el) return null;
    const outlineOnly = shape.type === "line" || shape.type === "arrow" || shape.type === "draw";
    el.setAttribute("fill", (shape.fill && !outlineOnly) ? "rgba(" + rgb + ",0.25)" : "none");
    el.setAttribute("stroke", "rgb(" + rgb + ")");
    el.setAttribute("stroke-width", sw);
    const dash = this._dashArray(shape.dash, sw);
    if (dash) {
      el.setAttribute("stroke-dasharray", dash);
      if (shape.dash !== "dashed") el.setAttribute("stroke-linecap", "round"); // round dots
    }
    el.setAttribute("opacity", shape.op != null ? shape.op : 1);
    if (hid) el.setAttribute("data-hid", hid);
    if (!head) return el;
    // Arrow: shaft + head travel together.
    const grp = doc.createElementNS(NS, "g");
    grp.setAttribute("opacity", shape.op != null ? shape.op : 1);
    el.removeAttribute("opacity");
    if (hid) grp.setAttribute("data-hid", hid);
    grp.appendChild(el); grp.appendChild(head);
    return grp;
  }

  // Which shape is under the cursor (topmost wins). Bounding-box test, since the SVG
  // layer is pointer-events:none so text selection keeps working over a shape.
  _shapeAtPoint(hook, x, y) {
    const doc = hook.doc;
    const all = (this._getStore()[hook.fingerprint] || []).filter((h) => h.shape);
    const pages = [...doc.querySelectorAll(".page")];
    for (let i = all.length - 1; i >= 0; i--) {
      const h = all[i];
      const pageEl = pages.find((p) => parseInt(p.getAttribute("data-page-number"), 10) === h.page);
      if (!pageEl) continue;
      const ref = pageEl.querySelector(".textLayer") || pageEl.querySelector("canvas");
      if (!ref) continue;
      const b = ref.getBoundingClientRect();
      const bb = this._shapeBBox(h.shape);
      if (!bb) continue;
      const pad = 6;
      const x0 = b.left + bb.x * b.width, y0 = b.top + bb.y * b.height;
      const w = bb.w * b.width, hh = bb.h * b.height;
      if (x >= x0 - pad && x <= x0 + w + pad && y >= y0 - pad && y <= y0 + hh + pad) return h.hid;
    }
    return null;
  }

  // Selection indicator: the SAME geometry traced in a wider translucent accent, painted
  // under the shape. It follows every form exactly — no bounding box around an ellipse,
  // a line or a freehand stroke. Resize handles are drawn on top, in _redrawShapes.
  _selectionEl(doc, shape, W, H, accent) {
    const el = this._shapeEl(doc, Object.assign({}, shape, { op: 1 }), W, H, null);
    if (!el) return null;
    const SEL = accent || this._accentRgba(0.55);
    const halo = Math.max(1, (shape.sw || 0.003) * W) + 6;
    const nodes = el.tagName === "g" ? [...el.childNodes] : [el];
    for (const n of nodes) {
      if (n.tagName === "polygon") { // an arrow head: grow it rather than outline it
        n.setAttribute("fill", SEL); n.setAttribute("stroke", SEL);
        n.setAttribute("stroke-width", 6); n.setAttribute("stroke-linejoin", "round");
      } else {
        n.setAttribute("fill", "none");
        n.setAttribute("stroke", SEL);
        n.setAttribute("stroke-width", halo);
        n.setAttribute("stroke-linejoin", "round");
        n.setAttribute("stroke-linecap", "round");
      }
    }
    return el;
  }

  // ---- move & resize -------------------------------------------------------
  // Handle positions in normalised page coords. A box gets eight, a line or arrow gets
  // its two ends, a freehand stroke gets its bounding corners (it scales as a whole).
  _shapeHandles(shape) {
    const g = shape.geom || [];
    if (shape.type === "line" || shape.type === "arrow") {
      if (g.length < 4) return [];
      return [{ key: "p1", x: g[0], y: g[1] }, { key: "p2", x: g[2], y: g[3] }];
    }
    const bb = this._shapeBBox(shape);
    if (!bb) return [];
    const x = bb.x, y = bb.y, w = bb.w, h = bb.h;
    const corners = [
      { key: "nw", x: x, y: y }, { key: "ne", x: x + w, y: y },
      { key: "se", x: x + w, y: y + h }, { key: "sw", x: x, y: y + h },
    ];
    if (shape.type === "draw") return corners;
    return corners.concat([
      { key: "n", x: x + w / 2, y: y }, { key: "s", x: x + w / 2, y: y + h },
      { key: "w", x: x, y: y + h / 2 }, { key: "e", x: x + w, y: y + h / 2 },
    ]);
  }

  _handleAtPoint(hook, cx, cy) {
    const hid = hook.selectedShape;
    if (!hid) return null;
    const entry = (this._getStore()[hook.fingerprint] || []).find((h) => h.hid === hid && h.shape);
    if (!entry) return null;
    const ref = this._pageRef(hook, entry.page);
    if (!ref) return null;
    for (const p of this._shapeHandles(entry.shape)) {
      const px = ref.left + p.x * ref.width, py = ref.top + p.y * ref.height;
      if (Math.abs(cx - px) <= 7 && Math.abs(cy - py) <= 7) return { hid, key: p.key, page: entry.page };
    }
    return null;
  }

  // Client coords inside the viewer iframe are NOT the parent window's: the iframe is laid
  // out at full document height and the panel scrolls it, so anything drawn in Thymer's
  // document (the style panel, the rail) has to be offset by the iframe's own box.
  _toTopCoords(hook, x, y) {
    try {
      const r = hook.iframe.getBoundingClientRect();
      return { x: r.left + x, y: r.top + y };
    } catch (e) { return { x: x, y: y }; }
  }

  // The page's text-layer box in client coords — the frame every shape is normalised to.
  _pageRef(hook, pageNum) {
    const pageEl = [...hook.doc.querySelectorAll(".page")].find((p) => parseInt(p.getAttribute("data-page-number"), 10) === pageNum);
    if (!pageEl) return null;
    const ref = pageEl.querySelector(".textLayer") || pageEl.querySelector("canvas");
    if (!ref) return null;
    const b = ref.getBoundingClientRect();
    return b.width && b.height ? b : null;
  }

  _cursorForHandle(key) {
    if (key === "nw" || key === "se") return "nwse-resize";
    if (key === "ne" || key === "sw") return "nesw-resize";
    if (key === "n" || key === "s") return "ns-resize";
    if (key === "e" || key === "w") return "ew-resize";
    return "move"; // line/arrow endpoints
  }

  _startShapeDrag(hook, e, hid, kind, handle) {
    const entry = (this._getStore()[hook.fingerprint] || []).find((h) => h.hid === hid && h.shape);
    if (!entry) return;
    const ref = this._pageRef(hook, entry.page);
    if (!ref) return;
    e.preventDefault();
    hook.shapeDrag = {
      hid, kind, handle, ref,
      startX: e.clientX, startY: e.clientY,
      geom0: (entry.shape.geom || []).slice(),
      entry,
    };
  }

  _updateShapeDrag(hook, e) {
    const d = hook.shapeDrag;
    if (!d) return;
    const dx = (e.clientX - d.startX) / d.ref.width;
    const dy = (e.clientY - d.startY) / d.ref.height;
    d.entry.shape.geom = d.kind === "move"
      ? this._geomMoved(d.entry.shape, d.geom0, dx, dy)
      : this._geomResized(d.entry.shape, d.geom0, d.handle, dx, dy);
    this._redrawShapes(hook);
  }

  _geomMoved(shape, g0, dx, dy) {
    const cl = (v) => Math.max(0, Math.min(1, v));
    if (shape.type === "rect" || shape.type === "ellipse") {
      return [cl(g0[0] + dx), cl(g0[1] + dy), g0[2], g0[3]];
    }
    const out = g0.slice();
    for (let i = 0; i + 1 < out.length; i += 2) { out[i] = cl(out[i] + dx); out[i + 1] = cl(out[i + 1] + dy); }
    return out;
  }

  _geomResized(shape, g0, key, dx, dy) {
    const cl = (v) => Math.max(0, Math.min(1, v));
    const MIN = 0.005;
    if (shape.type === "line" || shape.type === "arrow") {
      const out = g0.slice();
      if (key === "p1") { out[0] = cl(g0[0] + dx); out[1] = cl(g0[1] + dy); }
      else { out[2] = cl(g0[2] + dx); out[3] = cl(g0[3] + dy); }
      return out;
    }
    // Box-like: rect, ellipse and (scaling the whole path) freehand.
    const bb = this._shapeBBox({ type: shape.type, geom: g0 });
    if (!bb) return g0;
    let x1 = bb.x, y1 = bb.y, x2 = bb.x + bb.w, y2 = bb.y + bb.h;
    if (key.indexOf("w") !== -1) x1 = cl(x1 + dx);
    if (key.indexOf("e") !== -1) x2 = cl(x2 + dx);
    if (key.indexOf("n") !== -1) y1 = cl(y1 + dy);
    if (key.indexOf("s") !== -1) y2 = cl(y2 + dy);
    const nx = Math.min(x1, x2), ny = Math.min(y1, y2);
    const nw = Math.max(MIN, Math.abs(x2 - x1)), nh = Math.max(MIN, Math.abs(y2 - y1));
    if (shape.type !== "draw") return [nx, ny, nw, nh];
    if (!(bb.w > 0 && bb.h > 0)) return g0;
    const out = g0.slice();
    for (let i = 0; i + 1 < out.length; i += 2) {
      out[i] = nx + ((g0[i] - bb.x) / bb.w) * nw;
      out[i + 1] = ny + ((g0[i + 1] - bb.y) / bb.h) * nh;
    }
    return out;
  }

  // Only on release does the new geometry go into the note (the durable source).
  _finishShapeDrag(hook, e) {
    const d = hook.shapeDrag;
    if (!d) return;
    this._updateShapeDrag(hook, e);
    hook.shapeDrag = null;
    const geom = (d.entry.shape.geom || []).slice();
    const moved = geom.some((v, i) => Math.abs(v - (d.geom0[i] || 0)) > 0.0005);
    if (!moved) return;
    this._restyleShape(hook, d.hid, { geom });
  }

  _redrawShapes(hook) {
    const doc = hook.doc;
    const all = (this._getStore()[hook.fingerprint] || []).filter((h) => h.shape);
    const d = hook.drawing;
    // Resolved once per redraw: the iframe can't read Thymer's CSS variables itself.
    const accent = hook.selectedShape ? this._accentRgba(0.55) : null;
    doc.querySelectorAll(".page").forEach((pageEl) => {
      const pageNum = parseInt(pageEl.getAttribute("data-page-number"), 10);
      const tl = pageEl.querySelector(".textLayer") || pageEl.querySelector("canvas");
      let svg = pageEl.querySelector(".pdfhl-shapes");
      const mine = all.filter((h) => h.page === pageNum);
      const preview = d && d.page === pageNum ? this._drawingShape(d) : null;
      if ((!mine.length && !preview) || !tl) { if (svg) svg.remove(); return; }
      if (!svg) {
        svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "pdfhl-shapes");
        pageEl.appendChild(svg);
      }
      const W = tl.offsetWidth, H = tl.offsetHeight;
      svg.setAttribute("viewBox", "0 0 " + W + " " + H);
      svg.style.cssText = "position:absolute;pointer-events:none;z-index:4;left:" + tl.offsetLeft + "px;top:" + tl.offsetTop + "px;width:" + W + "px;height:" + H + "px;";
      svg.innerHTML = "";
      for (const h of mine) {
        // Selection halo goes UNDER, so the shape itself stays fully readable.
        if (h.hid === hook.selectedShape) {
          const sel = this._selectionEl(doc, h.shape, W, H, accent);
          if (sel) svg.appendChild(sel);
        }
        const el = this._shapeEl(doc, h.shape, W, H, h.hid);
        if (el) svg.appendChild(el);
        if (h.hid === hook.selectedShape) {
          // Handles sit ON TOP so they stay grabbable over the shape's own stroke.
          const solid = this._accentRgba(1);
          for (const pt of this._shapeHandles(h.shape)) {
            const k = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
            const sz = 8;
            k.setAttribute("x", pt.x * W - sz / 2); k.setAttribute("y", pt.y * H - sz / 2);
            k.setAttribute("width", sz); k.setAttribute("height", sz);
            k.setAttribute("rx", "1.5");
            k.setAttribute("fill", solid);
            k.setAttribute("stroke", "#fff");
            k.setAttribute("stroke-width", "1.5");
            svg.appendChild(k);
          }
        }
      }
      if (preview) {
        const el = this._shapeEl(doc, preview, W, H, null);
        if (el) { el.setAttribute("stroke-dasharray", "5 4"); svg.appendChild(el); }
      }
    });
  }

  // Area capture on a page that HAS text: collect the spans inside the box and rebuild
  // paragraphs from their geometry. Exact characters, no OCR — the scanned-page path
  // (same gesture) falls back to Tesseract instead.
  async _commitAreaText(hook, pageEl, page, rectOrRects, mode) {
    const tl = pageEl.querySelector(".textLayer");
    if (!tl) return;
    const box = tl.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const rects0 = Array.isArray(rectOrRects) ? rectOrRects : [rectOrRects];
    const inAny = (cx, cy) => rects0.some((r) => {
      const rx = box.left + r.x * box.width, ry = box.top + r.y * box.height;
      return cx >= rx && cx <= rx + r.w * box.width && cy >= ry && cy <= ry + r.h * box.height;
    });
    const picked = [];
    for (const sp of tl.querySelectorAll("span")) {
      const b = sp.getBoundingClientRect();
      if (!b.width || !(sp.textContent || "").trim()) continue;
      if (inAny(b.left + b.width / 2, b.top + b.height / 2)) picked.push({ sp: sp, b: b });
    }
    if (!picked.length) {
      this.ui.addToaster({ title: "No text in that area", message: "Drag over text, or use a shape to mark the region.", dismissible: true, autoDestroyTime: 2800 });
      return;
    }
    const note = this._findAssociatedNote(hook.iframe);
    if (!note) {
      this.ui.addToaster({ title: "No note found", message: "Open the PDF beside its note, then capture.", dismissible: true });
      return;
    }
    // Group into visual lines, then lines into paragraphs.
    picked.sort((p1, p2) => (p1.b.top - p2.b.top) || (p1.b.left - p2.b.left));
    const lines = [];
    for (const it of picked) {
      const last = lines[lines.length - 1];
      const mid = it.b.top + it.b.height / 2;
      if (last && Math.abs(mid - last.mid) < Math.min(it.b.height, last.h) * 0.6) {
        last.items.push(it);
        last.h = Math.max(last.h, it.b.height);
      } else {
        lines.push({ mid: mid, h: it.b.height, top: it.b.top, items: [it] });
      }
    }
    const paragraphs = [];
    let prevBottom = null, prevH = null;
    for (const ln of lines) {
      ln.items.sort((a1, a2) => a1.b.left - a2.b.left);
      // A text-layer span is often a FRAGMENT of a word (pdf.js splits on kerning), so
      // joining with a space breaks words apart ("H ere"). Let the gap decide: roughly a
      // sixth of the font size is the smallest real word space.
      let text = "";
      for (let i = 0; i < ln.items.length; i++) {
        const cur = ln.items[i], t = cur.sp.textContent || "";
        if (!i) { text = t; continue; }
        const prev = ln.items[i - 1];
        const gap = cur.b.left - (prev.b.left + prev.b.width);
        const em = Math.max(cur.b.height, prev.b.height) || 10;
        const needSpace = gap > em * 0.16 && !/\s$/.test(text) && !/^\s/.test(t);
        text += (needSpace ? " " : "") + t;
      }
      text = text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const gap = prevBottom == null ? 0 : ln.top - prevBottom;
      const isBullet = this.BULLET_RE.test(text) || this.NUMBER_RE.test(text);
      const newPara = !paragraphs.length || isBullet || (prevH && gap > prevH * 0.9);
      if (newPara) paragraphs.push(text);
      else {
        const prev = paragraphs[paragraphs.length - 1];
        paragraphs[paragraphs.length - 1] = /[‐-―-]$/.test(prev)
          ? prev.replace(/[‐-―-]$/, "") + text
          : prev + " " + text;
      }
      prevBottom = ln.top + ln.h; prevH = ln.h;
    }
    if (!paragraphs.length) return;
    // Overlay follows the captured LINES, not the box, so it reads like a highlight.
    const rects = this._mergeLineRects(picked.map((x) => ({
      x: (x.b.left - box.left) / box.width,
      y: (x.b.top - box.top) / box.height,
      w: x.b.width / box.width,
      h: x.b.height / box.height,
    })));
    const effMode = this._noteMode === "comment" && (mode || "normal") === "normal" ? "link" : (mode || "normal");
    await this._commitExtract(hook, note, {
      paragraphs: paragraphs, page: page, color: this._currentColor(),
      rectsByPage: { [page]: rects }, mode: effMode, mark: "fill",
    });
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

  _startMarquee(hook, pageEl, e, isArea) {
    e.preventDefault();
    const el = hook.doc.createElement("div");
    el.className = "pdfhl-marquee";
    hook.doc.body.appendChild(el);
    hook.marquee = { active: true, pageEl, startX: e.clientX, startY: e.clientY, el, shift: !!e.shiftKey, area: !!isArea, mode: e.metaKey ? "append" : (e.altKey ? "link" : "normal") };
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
    const pageEl = m.pageEl, el = m.el, wasShift = m.shift;
    // Read ⌘/⌥ at RELEASE, exactly like a text selection does. Holding a modifier for the
    // whole gesture is impossible anyway — ⌘+scroll is the viewer's zoom — so you press it
    // just before letting go.
    let mode = e.metaKey ? "append" : (e.altKey ? "link" : "normal");
    if (mode === "normal" && this._noteMode === "comment") mode = "link";
    const left = Math.min(m.startX, e.clientX), top = Math.min(m.startY, e.clientY);
    const right = Math.max(m.startX, e.clientX), bottom = Math.max(m.startY, e.clientY);
    hook.marquee = null; // detach; `el` is managed directly below
    const drop = () => { try { el.remove(); } catch (er) {} };
    if (right - left < 8 || bottom - top < 8) { // a click, not a drag
      drop();
      // A wide-but-flat drag on an image page is usually a (futile) text-selection attempt.
      if (mode === "normal" && right - left >= 40 && bottom - top < 8) {
        this.ui.addToaster({ title: "No selectable text here", message: "This page is an image — drag a box around the text to capture it.", dismissible: true, autoDestroyTime: 3500 });
      }
      return;
    }
    // Normalise against the text layer box (== canvas == page content box).
    const ref = (pageEl.querySelector(".textLayer") || pageEl.querySelector("canvas")).getBoundingClientRect();
    if (!ref.width || !ref.height) { drop(); return; }
    const clamp = (v) => Math.max(0, Math.min(1, v));
    const x = clamp((left - ref.left) / ref.width), y = clamp((top - ref.top) / ref.height);
    const x2 = clamp((right - ref.left) / ref.width), y2 = clamp((bottom - ref.top) / ref.height);
    const rect = { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
    if (rect.w < 0.01 || rect.h < 0.01) { drop(); return; }
    const page = parseInt(pageEl.getAttribute("data-page-number"), 10) || this._currentPage(hook);
    if (m.area && !this._isScannedPage(pageEl)) {
      // No Shift-collecting here: on a text page Shift is the browser's own
      // extend-selection, and reading a modifier mid-drag proved unreliable. ⌘ is the
      // one way to combine captures.
      drop();
      this._commitAreaText(hook, pageEl, page, rect, mode);
      return;
    }
    if (wasShift) {
      // Accumulate this box (keep it outlined); commit them all on Shift release.
      el.classList.add("pdfhl-marquee-pending");
      (hook._ocrBoxes = hook._ocrBoxes || []).push({ page, rect, el, mode });
    } else if (mode === "link") {
      // ⌥ note-link on an image region: no OCR, just an empty linked line + overlay box.
      drop();
      this._pendingRange = null;
      this._commitRegionLink(hook, page, [rect], this._currentColor());
    } else {
      drop();
      hook._pendingRegion = { page, rect, mode }; // mode carries ⌘ (append) through OCR
      this._pendingRange = null;
      this._extractOCR(hook, this._currentColor());
    }
  }

  // ⌥ note-link on image region(s): skip OCR entirely; create an empty "note" block carrying
  // just the backlink, whose overlay box(es) are the marquee rect(s) (carried in the URL).
  async _commitRegionLink(hook, page, rects, color) {
    const note = this._findAssociatedNote(hook.iframe);
    if (!note) { this.ui.addToaster({ title: "No note found", message: "Open the PDF beside its note, then highlight.", dismissible: true }); return; }
    await this._commitExtract(hook, note, { paragraphs: [], page, color, rectsByPage: { [page]: rects }, mode: "link" });
  }

  // Shift released -> commit every accumulated box together as ONE extract, honouring a
  // ⌘ (append) or ⌥ (note block) held during the boxing.
  _commitOcrBoxes(hook) {
    const boxes = hook._ocrBoxes || [];
    if (!boxes.length) return;
    hook._ocrBoxes = [];
    boxes.forEach((b) => { try { b.el.remove(); } catch (e) {} });
    const mode = boxes.map((b) => b.mode).find((m) => m && m !== "normal") || "normal";
    if (mode === "link") {
      // ⌥: a single note block linked to all the boxes, no OCR.
      const page = boxes[0].page;
      const rects = boxes.filter((b) => b.page === page).map((b) => b.rect);
      this._commitRegionLink(hook, page, rects, this._currentColor());
    } else {
      this._ocrAndExtract(hook, boxes.map((b) => ({ page: b.page, rect: b.rect })), this._currentColor(), mode);
    }
  }

  // Esc -> discard the pending boxes without extracting.
  _cancelOcrBoxes(hook) {
    const boxes = hook._ocrBoxes || [];
    hook._ocrBoxes = [];
    boxes.forEach((b) => { try { b.el.remove(); } catch (e) {} });
  }

  async _extractOCR(hook, color) {
    const region = hook._pendingRegion;
    if (!region) return;
    hook._pendingRegion = null;
    await this._ocrAndExtract(hook, [region], color, region.mode || "normal");
  }

  // OCR one or more boxed regions (sorted into reading order), combine the text, and
  // write a single extract. Multiple regions come from Shift-boxing several lines, so
  // you can start mid-sentence and skip the ragged ends.
  async _ocrAndExtract(hook, regions, color, mode) {
    regions = (regions || []).filter((r) => r && r.rect);
    if (!regions.length) return;
    const note = this._findAssociatedNote(hook.iframe);
    if (!note) {
      this.ui.addToaster({ title: "No note found", message: "Open the PDF beside its note, then highlight.", dismissible: true });
      return;
    }
    const sorted = regions.slice().sort((a, b) => (a.page - b.page) || (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x));
    const lang = this.OCR_LANGUAGES.find((x) => x.code === this._ocrLang);
    const more = sorted.length > 1 ? " (" + sorted.length + " boxes)" : "";
    const prog = this.ui.addToaster({ title: "Running OCR…", message: "Reading " + (lang ? lang.label : "text") + more + "…", dismissible: false });
    const datas = [];
    try {
      for (const r of sorted) { datas.push(await this._ocrRegion(hook, r.page, r.rect)); }
    } catch (e) {
      try { prog && prog.destroy(); } catch (_) {}
      this.ui.addToaster({ title: "OCR failed", message: String((e && e.message) || e), dismissible: true });
      return;
    }
    try { prog && prog.destroy(); } catch (_) {}
    // Each box becomes its own paragraphs (line boxes decide the breaks); several boxes are
    // then stitched only where the text genuinely runs on.
    const perBox = datas.map((d) => this._ocrDataToParagraphs(d));
    const paragraphs = perBox.length === 1 ? perBox[0] : this._joinOcrBoxes([].concat.apply([], perBox));
    if (!paragraphs.length) {
      this.ui.addToaster({ title: "No text found", message: "OCR didn't find readable text in that selection.", dismissible: true, autoDestroyTime: 2800 });
      return;
    }
    const rectsByPage = {};
    for (const r of sorted) (rectsByPage[r.page] = rectsByPage[r.page] || []).push(r.rect);
    const page = sorted[0].page;
    const ocrRects = sorted.filter((r) => r.page === page).map((r) => r.rect);
    await this._commitExtract(hook, note, { paragraphs, page, color, rectsByPage, ocrRects, mode: mode || "normal" });
  }

  // Join per-box OCR text (each box ≈ a line/fragment) into one flowing passage,
  // de-hyphenating broken words at box boundaries.
  _joinOcrBoxes(texts) {
    // Boxes are stitched only where the text actually runs on: a hyphen break, or a box
    // that ends mid-sentence followed by one that doesn't start a new item. Otherwise each
    // box stays its own paragraph, so line and list structure survives (this used to
    // collapse everything into a single run-on paragraph).
    const out = [];
    for (const raw of texts || []) {
      const t = (raw || "").replace(/\s+/g, " ").trim();
      if (!t) continue;
      if (!out.length) { out.push(t); continue; }
      const prev = out[out.length - 1];
      if (/[‐-―-]$/.test(prev) && /^[a-zà-ÿ]/.test(t)) { out[out.length - 1] = prev.replace(/[‐-―-]$/, "") + t; continue; }
      const endsSentence = /[.!?:;]["')\]]?$/.test(prev);
      const startsItem = this.BULLET_RE.test(t) || this.NUMBER_RE.test(t);
      if (!endsSentence && !startsItem) { out[out.length - 1] = prev + " " + t; continue; }
      out.push(t);
    }
    return out;
  }

  async _ocrRegion(hook, page, rect) {
    const canvas = await this._renderRegionCanvas(hook, page, rect);
    if (!canvas) throw new Error("Couldn't capture that region.");
    const worker = await this._ensureOcrWorker();
    const res = await worker.recognize(canvas);
    return (res && res.data) || null;
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
  // Tesseract reports each LINE with a bounding box. A line that stops well short of the
  // right margin ends a paragraph; a list marker starts one. Same heuristic the text-layer
  // extractor uses — far better than splitting on blank lines, which a list never has.
  _ocrDataToParagraphs(data) {
    const raw = (data && data.lines) || null;
    if (!raw || !raw.length) return this._ocrTextToParagraphs((data && data.text) || "");
    const items = raw
      .map((l) => ({ text: String(l.text || "").replace(/\s+/g, " ").trim(), bb: l.bbox || null }))
      .filter((x) => x.text);
    if (!items.length) return [];
    const withBox = items.filter((x) => x.bb);
    const maxRight = withBox.length ? Math.max.apply(null, withBox.map((x) => x.bb.x1)) : 0;
    const minLeft = withBox.length ? Math.min.apply(null, withBox.map((x) => x.bb.x0)) : 0;
    const shortThresh = Math.max(1, (maxRight - minLeft) * 0.12);
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const cur = items[i], prev = items[i - 1];
      const isMarker = this.BULLET_RE.test(cur.text) || this.NUMBER_RE.test(cur.text);
      const prevEndedShort = !!(prev && prev.bb && (maxRight - prev.bb.x1) > shortThresh);
      if (!out.length || isMarker || prevEndedShort) { out.push(cur.text); continue; }
      const last = out[out.length - 1];
      out[out.length - 1] = /[‐-―-]$/.test(last) && /^[a-zà-ÿ]/.test(cur.text)
        ? last.replace(/[‐-―-]$/, "") + cur.text
        : last + " " + cur.text;
    }
    return out;
  }

  _ocrTextToParagraphs(text) {
    if (!text) return [];
    return text.replace(/\r/g, "")
      .split(/\n[ \t]*\n+/)
      .map((para) => para.split("\n").map((l) => l.trim()).filter(Boolean).reduce((acc, line) => {
        if (!acc) return line;
        // A list marker always begins its own line, even without a blank line before it.
        if (this.BULLET_RE.test(line) || this.NUMBER_RE.test(line)) return acc + "\n" + line;
        if (/[‐-―-]$/.test(acc) && /^[a-zà-ÿ]/.test(line)) return acc.replace(/[‐-―-]$/, "") + line;
        return acc + " " + line;
      }, ""))
      .reduce((acc, para) => acc.concat(para.split("\n")), [])
      .map((p) => p.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  // Set the active OCR language (from a per-language command-palette command).
  _setOcrLang(code) {
    const L = this.OCR_LANGUAGES.find((x) => x.code === code);
    if (code !== this._ocrLang) {
      this._ocrLang = code;
      try { window.localStorage.setItem("pdfhl_ocrLang", code); } catch (e) {} // config doesn't round-trip on reload here
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
  // Clip a text-layer span's text to the part actually inside the selection.
  // pdf.js textLayer spans are single-text-node, and a mid-span selection lands
  // its start/end boundary INSIDE that text node — so only the two boundary spans
  // get trimmed; fully-selected interior spans (and geometric-only bullet spans,
  // whose boundary lives elsewhere) keep their whole text. Without this, selecting
  // mid-sentence captured the leading/trailing text of the first/last line because
  // the entire span was taken.
  _clipSpanText(range, span) {
    const tn = span.firstChild;
    if (!tn || tn.nodeType !== 3 || span.childNodes.length !== 1) return span.textContent;
    let from = 0, to = tn.length;
    if (range.startContainer === tn) from = range.startOffset;
    if (range.endContainer === tn) to = range.endOffset;
    return tn.textContent.slice(from, to);
  }

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
        spans.push({ pageNum, text: this._clipSpanText(range, span), top: r.top, bottom: r.bottom || (r.top + 8), left: r.left, right: r.right, height: r.height || 8 });
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
    const BULLET = this.BULLET_RE;
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
    // getClientRects() returns one rect per text run, so a selected sentence arrives as a
    // row of per-word boxes with gaps. Merge each line into one continuous band.
    for (const num in byPage) byPage[num] = this._mergeLineRects(byPage[num]);
    return byPage;
  }

  // Merge rects that sit on the same line into a single span. Rects are only joined when
  // they overlap vertically (same line) AND the horizontal gap is small — a wide gap means
  // a different column, which must stay separate.
  _mergeLineRects(rects) {
    const out = [];
    const sorted = (rects || []).slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
    for (const r of sorted) {
      let merged = false;
      for (const L of out) {
        const overlap = Math.min(L.y + L.h, r.y + r.h) - Math.max(L.y, r.y);
        if (overlap <= 0.5 * Math.min(L.h, r.h)) continue; // a different line
        if (r.x - (L.x + L.w) > 0.03) continue;            // a different column
        const x1 = Math.max(L.x + L.w, r.x + r.w), y1 = Math.max(L.y + L.h, r.y + r.h);
        L.x = Math.min(L.x, r.x); L.y = Math.min(L.y, r.y);
        L.w = x1 - L.x; L.h = y1 - L.y;
        merged = true; break;
      }
      if (!merged) out.push({ x: r.x, y: r.y, w: r.w, h: r.h });
    }
    return out;
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

  // Toggle whether extracts are grouped under a "Highlights" heading.
  _setUseHeading(on) {
    this._useHeading = !!on;
    try { window.localStorage.setItem("pdfhl_useHeading", on ? "1" : "0"); } catch (e) {}
    try {
      const conf = this.getConfiguration();
      conf.custom = conf.custom || {};
      conf.custom.useHeading = !!on;
      const mine = (this.data.getAllGlobalPlugins() || []).find((g) => g.guid === this.getGuid());
      if (mine && typeof mine.saveConfiguration === "function") mine.saveConfiguration(conf);
    } catch (e) {}
    this.ui.addToaster({
      title: "Highlights heading " + (on ? "on" : "off"),
      message: on ? "New extracts are grouped under a Highlights heading." : "New extracts go after the line you last clicked in the note.",
      dismissible: true, autoDestroyTime: 3200,
    });
  }

  // Where a new extract goes: under the Highlights heading (default), or — when that's
  // toggled off — after the last note line the user clicked (else the end of the note).
  async _insertLocation(note) {
    if (this._useHeading) return await this._highlightsParent(note);
    return await this._cursorLocation(note);
  }

  async _cursorLocation(note) {
    try {
      const items = (await note.getLineItems()) || [];
      const rows = items.map((li) => ({ li, row: (li._getItem && li._getItem()) || {} }));
      const byGuid = {}; rows.forEach((x) => { if (x.row.guid) byGuid[x.row.guid] = x; });
      const cur = this._lastNoteLineGuid ? byGuid[this._lastNoteLineGuid] : null;
      if (cur && cur.row.type !== "document") {
        // Insert as a sibling right after the clicked line: same parent, after = it.
        // (A top-level line's pguid is the record root, so parentItem is null — same
        //  parent+after pattern _highlightsParent uses to append under a heading.)
        const parent = cur.row.pguid ? byGuid[cur.row.pguid] : null;
        return { parentItem: parent ? parent.li : null, after: cur.li };
      }
    } catch (e) {}
    return { parentItem: null, after: await this._lastContentItem(note) };
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
          try { h.setHeadingSize(2); } catch (e) {} // H2 (default would be H1)
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
  _closeHighlightMenu(hook) {
    try { if (hook && hook._menu) { hook._menu.remove(); hook._menu = null; } } catch (e) {}
  }

  // Recolour an existing highlight: the in-memory store, the overlay, AND the colour
  // param in the note's backlink URL (so a later rebuild-from-note keeps the change).
  async _changeHighlightColor(hook, hid, colorKey) {
    this._setHlColor(colorKey); // recolouring also sets the default for new highlights
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
    this._redrawShapes(hook);
    let wasShape = false;
    try {
      const note = this._findAssociatedNote(hook.iframe);
      if (note) {
        const lines = await this._findHighlightLines(note, hid); // children first, block last
        wasShape = lines.some((li) => {
          try { return (li.segments || []).some((s) => s && s.type === "linkobj" && s.text && typeof s.text.link === "string" && s.text.link.indexOf("&shape=") !== -1); } catch (e) { return false; }
        });
        for (const li of lines) { try { li.delete(); } catch (e) {} }
      }
    } catch (e) {}
    this.ui.addToaster({ title: wasShape ? "Shape deleted" : "Highlight deleted", dismissible: true, autoDestroyTime: 1500 });
  }

  // Lines to delete for one highlight, via the `hid` carried in the backlink URL (line
  // metadata isn't readable). A block can hold SEVERAL highlights (⌘-append), so delete
  // only THIS highlight's run — the paragraph lines up to and including its backlink line —
  // and remove the block itself only when this was the last highlight in it. Children are
  // returned before the block so deletion never orphans a child.
  async _findHighlightLines(note, hid) {
    const items = (await note.getLineItems()) || [];
    const byGuid = {};
    items.forEach((li) => { const g = ((li._getItem && li._getItem()) || {}).guid; if (g) byGuid[g] = li; });
    const hasHidLink = (li) => {
      let segs = []; try { segs = li.segments || []; } catch (e) {}
      return segs.some((s) => s && s.type === "linkobj" && s.text && typeof s.text.link === "string" && s.text.link.indexOf("hid=" + hid) !== -1);
    };
    const hasAnyBacklink = (li) => {
      let segs = []; try { segs = li.segments || []; } catch (e) {}
      return segs.some((s) => s && s.type === "linkobj" && s.text && typeof s.text.link === "string" && s.text.link.indexOf(this.BACKLINK_HOST) !== -1);
    };
    const anchor = items.find(hasHidLink);
    if (!anchor) return [];
    const blockGuid = ((anchor._getItem && anchor._getItem()) || {}).pguid || null;
    const block = blockGuid ? byGuid[blockGuid] : null;
    if (!block) return [anchor]; // a lone line (not inside a block) — just delete it
    // Children in document order via the block's cguids (oind is uniformly 0 in records).
    let kids = (((block._getItem && block._getItem()) || {}).cguids || []).map((g) => byGuid[g]).filter(Boolean);
    if (!kids.length) kids = items.filter((li) => (((li._getItem && li._getItem()) || {}).pguid) === blockGuid);
    // Segment into runs, each ending at a backlink line; pick the run containing the anchor.
    const runs = []; let cur = [];
    for (const li of kids) { cur.push(li); if (hasAnyBacklink(li)) { runs.push(cur); cur = []; } }
    if (cur.length) runs.push(cur);
    const target = runs.find((run) => run.indexOf(anchor) !== -1) || [anchor];
    const highlightRuns = runs.filter((run) => run.some(hasAnyBacklink));
    if (highlightRuns.length <= 1) return target.concat([block]); // last one → take the block too
    return target; // other highlights remain → keep the block
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

    // Group children by parent. A highlight is a RUN of sibling lines ending at the line
    // that carries the backlink: a normal extract is a quote block whose one run is all
    // its children; an APPENDED block holds several runs (a backlink each); a note-link is
    // a lone line with a backlink and no quote text. Only TEXT segments form the quote we
    // match back against the PDF — the "linkobj" (backlink) and the "icon" segment (whose
    // text is the literal "ti-arrow-up-right") would corrupt the _locateText needle.
    const childrenByParent = {};
    for (const li of items) {
      const it = li._getItem && li._getItem();
      if (it && it.pguid) (childrenByParent[it.pguid] = childrenByParent[it.pguid] || []).push({ li, oind: it.oind || 0 });
    }
    const textOf = (li) => (li.segments || []).filter((s) => s.type === "text").map((s) => (typeof s.text === "string" ? s.text : "")).join("").trim();
    const backlinkOf = (li) => (li.segments || []).find((s) => s && s.type === "linkobj" && s.text && typeof s.text.link === "string" && s.text.link.indexOf(this.BACKLINK_HOST) !== -1);
    const seen = new Set(), hls = [];
    for (const pg in childrenByParent) {
      const kids = childrenByParent[pg].slice().sort((a, b) => (a.oind || 0) - (b.oind || 0));
      let run = []; // paragraph texts accumulated since the last backlink
      for (const k of kids) {
        const t = textOf(k.li);
        if (t) run.push(t);
        const link = backlinkOf(k.li);
        if (!link) continue;
        const paragraphs = run.slice(); run = []; // close this highlight's run
        let u; try { u = new URL(link.text.link); } catch (e) { continue; }
        if (u.searchParams.get("pdf") !== hook.fingerprint) continue;
        const hid = u.searchParams.get("hid"); if (!hid || seen.has(hid)) continue; seen.add(hid);
        const page = parseInt(u.searchParams.get("page"), 10) || 1;
        const color = u.searchParams.get("color") || "yellow";
        const ocr = u.searchParams.get("ocr") === "1";
        const isLink = u.searchParams.get("link") === "1";
        let rects = null;
        const rstr = u.searchParams.get("rect");
        if (rstr) {
          rects = rstr.split(";").map((s) => s.split(",").map(Number)).filter((a) => a.length === 4 && a.every((n) => !isNaN(n))).map((a) => ({ x: a[0], y: a[1], w: a[2], h: a[3] }));
          if (!rects.length) rects = null;
        }
        // A drawn shape carries its whole definition in the URL (no text to locate).
        let shape = null;
        const shapeType = u.searchParams.get("shape");
        if (shapeType) {
          const geom = this._decShapeGeom(u.searchParams.get("geom"));
          const op = parseFloat(u.searchParams.get("op"));
          if (geom) shape = {
            type: shapeType, geom,
            stroke: u.searchParams.get("stroke") || "red",
            sw: parseFloat(u.searchParams.get("sw")) || 0.003,
            fill: u.searchParams.get("fill") === "1",
            op: isNaN(op) ? 1 : op,
            dash: u.searchParams.get("ls") || "solid",
          };
        }
        hls.push({ hid, page, color, paragraphs, ocr, link: isLink, rects, shape, mark: u.searchParams.get("mark") || "fill", mw: parseInt(u.searchParams.get("mw"), 10) || 6 });
      }
    }

    // locate rects for each, on whatever page is currently rendered; keep prior rects otherwise
    const prior = this._getStore()[hook.fingerprint] || [];
    const result = hls.map((h) => {
      let rectsByPage = {};
      // Shapes are drawn from their own geometry, not located in the text layer.
      if (h.shape) return { hid: h.hid, page: h.page, color: h.color, shape: h.shape, rectsByPage };
      // OCR and note-link highlights carry their overlay rect(s) in the backlink URL —
      // a scanned page has no text layer, and a note-link has no quote text, so the
      // passage can't be located; use the stored rects directly.
      if ((h.ocr || h.link) && h.rects) { rectsByPage[h.page] = h.rects; return { hid: h.hid, page: h.page, color: h.color, rectsByPage, mark: h.mark, mw: h.mw }; }
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
      return { hid: h.hid, page: h.page, color: h.color, rectsByPage, mark: h.mark, mw: h.mw };
    });

    const store = this._getStore();
    store[hook.fingerprint] = result;
    this._setStore(store);
    this._redrawOverlays(hook);
    this._redrawShapes(hook);
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
      // mix-blend-mode belongs on the LAYER, not the boxes: the layer's z-index makes it a
      // stacking context, which isolates blending, so per-box multiply never reached the
      // page canvas and the colour washed over the text instead of tinting it.
      layer.style.cssText = "position:absolute;pointer-events:none;mix-blend-mode:multiply;z-index:3;left:" + tl.offsetLeft + "px;top:" + tl.offsetTop + "px;width:" + tl.offsetWidth + "px;height:" + tl.offsetHeight + "px;";
      layer.innerHTML = "";
      for (const h of wanted) {
        const rgb = (this.COLORS.find((c) => c.key === h.color) || this.COLORS[0]).rgb;
        const mark = h.mark || "fill";
        const rects = h.rectsByPage[pageNum];
        for (const r of rects) {
          // The box always covers the WHOLE line — it carries the hid and is the hit target
          // for right-click/delete. An underline or strike is drawn as a bar INSIDE it;
          // making the box itself the thin bar left a 2px target nobody could hit.
          const box = doc.createElement("div");
          box.className = "pdfhl-box";
          box.dataset.hid = h.hid || "";
          box.style.cssText =
            "left:" + (r.x * 100) + "%;top:" + (r.y * 100) + "%;width:" + (r.w * 100) + "%;height:" + (r.h * 100) + "%;" +
            (mark === "fill" ? "background:rgba(" + rgb + ",0.40);" : "");
          if (mark !== "fill") {
            const bar = doc.createElement("div");
            const pct = Math.max(2, (h.mw || 6) * 2.4); // 1-12 -> 2.4%-28.8% of the line
            bar.style.cssText = "position:absolute;left:0;right:0;height:" + pct + "%;min-height:2px;border-radius:1px;" +
              "background:rgba(" + rgb + ",0.95);" +
              (mark === "underline" ? "bottom:1%;" : "top:50%;transform:translateY(-50%);");
            box.appendChild(bar);
          }
          layer.appendChild(box);
        }
      }
    });
  }

  // Highlight store lives in the plugin configuration custom blob.
  // The store is kept in memory (this._storeCache) as the in-session source of
  // truth, seeded ONCE from the persisted config. In the web client getConfiguration()
  // does not reflect just-written saveConfiguration() data, so reading the store back
  // from config (as this used to) returned empty there — _redrawOverlays then saw no
  // highlights and wiped every overlay. The note text remains the durable cross-session
  // source (see _rebuildFromNote), which repopulates this cache on load.
  _getStore() {
    if (this._storeCache) return this._storeCache;
    try {
      const conf = this.getConfiguration();
      this._storeCache = (conf && conf.custom && conf.custom.pdfhl_highlights) || {};
    } catch (e) { this._storeCache = {}; }
    return this._storeCache;
  }
  _setStore(store) {
    this._storeCache = store; // authoritative for this session
    try {
      const conf = this.getConfiguration();
      conf.custom = conf.custom || {};
      conf.custom.pdfhl_highlights = store;
      // Re-assert settings from in-memory state so a stale getConfiguration() can't drop
      // them when this store write saves (was clobbering the heading toggle).
      conf.custom.useHeading = this._useHeading;
      conf.custom.hlColor = this._hlColor;
      conf.custom.ocrLang = this._ocrLang;
      const mine = (this.data.getAllGlobalPlugins() || []).find((g) => g.guid === this.getGuid());
      if (mine && typeof mine.saveConfiguration === "function") mine.saveConfiguration(conf);
    } catch (e) {}
  }

  // =======================================================================
  // Styles
  // =======================================================================
  // Destructive action: a real button, centred, that turns red on hover. Needed in both
  // stylesheets — the highlight menu lives in the viewer iframe, the style panel does not.
  _deleteBtnCSS() {
    return ".pdfhl-del-btn{display:block;width:100%;text-align:center;padding:7px 8px;border-radius:4px;" +
      "border:1px solid rgba(128,128,128,.55);background:transparent;color:var(--color-text-100,#c5cac6);" +
      "cursor:pointer;font:12.5px/1.4 var(--font-sans,system-ui),system-ui,-apple-system,sans-serif;" +
      "transition:background 90ms ease,color 90ms ease,border-color 90ms ease;}" +
      ".pdfhl-del-btn:hover{background:#d83a3a;border-color:#d83a3a;color:#fff;}";
  }

  _injectMainCSS() {
    // Always replace: an early-return here meant a stale sheet survived a reload and newly
    // added rules never landed (the same trap as _injectViewerCSS).
    try { const old = document.getElementById("pdfhl-main-style"); if (old) old.remove(); } catch (e) {}
    const s = document.createElement("style");
    s.id = "pdfhl-main-style";
    // Match a normal Thymer link (page then arrow, not bold, not italic, underlined),
    // overriding the quote-block's italic. The arrow icon (next sibling) takes the
    // link colour so it reads as a backlink, with a little space from the page.
    const host = this.BACKLINK_HOST;
    s.textContent =
      "a.lineitem-linkobj[href*='" + host + "']{cursor:pointer;font-style:normal !important;font-weight:400 !important;text-decoration:underline;}" +
      "a.lineitem-linkobj[href*='" + host + "'] + .lineitem-icon{margin-left:4px;color:var(--link-color);cursor:pointer;}" +
      "a.lineitem-linkobj[href*='" + host + "'] + .lineitem-icon .ti{color:var(--link-color);}" +
      // Markup tool rail: hover brightens (base styles are inline on the elements).
      ".pdfhl-tool:hover{background:var(--color-bg-700,#262a2d) !important;color:var(--color-text-50,#dfe3e0) !important;}" +
      this._deleteBtnCSS();
    document.head.appendChild(s);
  }

  _injectViewerCSS(doc) {
    // Always replace: an early-return here meant a stale stylesheet from a previous
    // build survived a re-hook, so newly added rules never landed.
    try { const old = doc.getElementById("pdfhl-style"); if (old) old.remove(); } catch (e) {}
    const s = doc.createElement("style");
    s.id = "pdfhl-style";
    s.textContent = [
      ".pdfhl-swatch{width:100%;aspect-ratio:1;display:block;border-radius:4px;border:0;box-shadow:inset 0 0 0 1px rgba(128,128,128,.6);cursor:pointer;padding:0;transition:transform 90ms ease;}",
      ".pdfhl-swatch:hover{transform:scale(1.12);}",
      ".pdfhl-overlay{position:absolute;inset:0;pointer-events:none;z-index:3;}",
      ".pdfhl-box{position:absolute;border-radius:2px;}", // blending is on .pdfhl-overlay
      ".pdfhl-box.pdfhl-pulse{animation:pdfhl-pulse .9s ease-out 2;}",
      "@keyframes pdfhl-pulse{0%{outline:0 solid rgba(0,0,0,0);}40%{outline:3px solid rgba(0,0,0,.55);}100%{outline:0 solid rgba(0,0,0,0);}}",
      ".pdfhl-marquee{position:fixed;z-index:2147483646;border:1.5px dashed rgba(31,31,31,.9);",
      "background:rgba(31,31,31,.10);pointer-events:none;border-radius:2px;}",
      ".pdfhl-marquee-pending{border-style:solid;background:rgba(31,31,31,.18);}",
      ".pdfhl-menu{position:fixed;z-index:2147483647;background:#1c1f22;border:1px solid #33383c;border-radius:4px;padding:9px;",
      "box-shadow:0 10px 32px rgba(0,0,0,.5);min-width:150px;}",
      ".pdfhl-menu .pdfhl-menu-swatches{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:0 0 9px;}",
      ".pdfhl-menu .pdfhl-swatch-current{box-shadow:0 0 0 2px #1c1f22,0 0 0 3.5px #6fae9e;}",
      ".pdfhl-menu-item{color:#c5cac6;font:12.5px/1.4 system-ui,sans-serif;padding:7px 8px;border-radius:4px;cursor:pointer;}",
      ".pdfhl-menu-item:hover{background:rgba(255,255,255,.12);}",
      ".pdfhl-menu-delete:hover{background:#d83a3a;}",
      ".pdfhl-armed .page{cursor:crosshair;}", // the rail itself lives in Thymer's document
      this._deleteBtnCSS(),
    ].join("");
    doc.head.appendChild(s);
  }
}
