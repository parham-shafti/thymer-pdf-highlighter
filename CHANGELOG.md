# Changelog

## v2.0.0 — 2026-06-14

- **OCR for scanned PDFs.** On image-only pages (no text layer) you can drag a box around the text; the region is recognised with [Tesseract](https://github.com/naptha/tesseract.js) and added to your note like a normal highlight — same colours, page backlink, coloured overlay, and delete.
- **Multi-language OCR.** English, Swedish, German, French, Spanish, Greek, and Hebrew. Pick the language from the Command Palette (a command per language, e.g. *PDF Highlighter: Swedish*); your choice is remembered and each language model downloads on first use.
- **Recolour or delete via right-click.** Right-click a highlight for a menu to change its colour (updated in both the PDF and the note) or delete it. Replaces the previous hover-✕.

## v1.0.0 — 2026-06-13

- Highlight selectable text in a PDF and extract it into the note as a colour-coded quote block ending with a clickable `p.N ↗` backlink to the exact page.
- Five highlight colours; click a backlink to jump back into the PDF and pulse the highlight.
- Highlights are re-derived from the note's text, so they persist and survive reloads.
- Augments Thymer's built-in PDF.js preview — no second viewer to load.
