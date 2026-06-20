# Changelog

## v2.3.0 — 2026-06-20

- **Collect several passages into one quote.** Hold **⌘** while selecting text (or finishing an OCR box) to **append** it to your previous extract instead of starting a new quote block. A quote block can now hold many highlights, and you can delete them individually — deleting one no longer removes the whole block.
- **Link a note you write yourself.** Hold **⌥** while selecting (or boxing) to drop an empty **Note block** linked to that spot in the PDF — a clean line to write your own note, above the `p.N ↗` backlink, with no extracted text.
- **Combine with Shift on scanned pages.** **Shift + ⌘** OCRs several boxes and appends them into the previous block; **Shift + ⌥** turns several boxes into one note block.
- **Choose where extracts land.** A new Command Palette command, **PDF Highlighter: Toggle Highlights heading**, switches between grouping extracts under the **Highlights** heading and dropping them at the end of the note.
- **Settings persist.** Your colour, OCR language, and the heading setting are now remembered across reloads.
- **Fixes.** Extracts now cascade in order in collection/record notes (they had been stacking at the top), and a clearer message appears when you try to select text on an image-only page.

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
