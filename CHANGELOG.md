# Changelog

## v2.2.0 — 2026-06-15

- **Now works in the browser version of Thymer.** Highlights and their coloured overlays were saved correctly but never re-drawn in the web app, so they only showed up in the desktop app. They now render identically in both — OCR highlights included.
- **More precise selections.** Selecting text that starts or ends mid-line no longer pulls in the surrounding words; only what you actually selected is extracted.

## v2.1.0 — 2026-06-14

- **Highlight in one step.** Selecting text (or finishing an OCR box) now applies your current colour instantly — no colour toolbar to click each time. Right-click a highlight to recolour it (which also sets the colour for new ones).
- **Multi-line OCR capture.** On a scanned page, hold **Shift** and drag a box on each piece you want (so you can start mid-sentence and skip ragged line-ends); release Shift and they're OCR'd together into a single extract. **Esc** cancels.

## v2.0.0 — 2026-06-14

- **OCR for scanned PDFs.** On image-only pages (no text layer) you can drag a box around the text; the region is recognised with [Tesseract](https://github.com/naptha/tesseract.js) and added to your note like a normal highlight — same colours, page backlink, coloured overlay, and delete.
- **Multi-language OCR.** English, Swedish, German, French, Spanish, Greek, and Hebrew. Pick the language from the Command Palette (a command per language, e.g. *PDF Highlighter: Swedish*); your choice is remembered and each language model downloads on first use.
- **Recolour or delete via right-click.** Right-click a highlight for a menu to change its colour (updated in both the PDF and the note) or delete it. Replaces the previous hover-✕.

## v1.0.0 — 2026-06-13

- Highlight selectable text in a PDF and extract it into the note as a colour-coded quote block ending with a clickable `p.N ↗` backlink to the exact page.
- Five highlight colours; click a backlink to jump back into the PDF and pulse the highlight.
- Highlights are re-derived from the note's text, so they persist and survive reloads.
- Augments Thymer's built-in PDF.js preview — no second viewer to load.
