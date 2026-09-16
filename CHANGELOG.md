# Changelog

## v2.7.0 — 2026-09-17

- **Fixed: undo could say it worked without undoing anything.** Removing a mark deletes its line from the note, and that happens asynchronously, so a redraw running in the next moment still saw the line and put the mark straight back. A deleted mark is now ignored until the note actually stops reporting it, which covers every way of removing one, not just undo. The message also tells you when an undo failed, instead of claiming success either way.
- **Dark page.** Press **9**, or hit the moon in the tool rail, and the PDF inverts for night reading. Only the rendered page is inverted, never your markup: highlights, shapes and text boxes keep their real colours, and so do the document's own, since the filter flips lightness and puts the hues back. Highlights switch to a blend that lightens, so they still read as a band over a dark page instead of burying it. The setting is remembered, and the same key turns it off.

## v2.6.0 — 2026-09-16

- **PDF Only.** A third choice beside Citation and Comment: mark the page and write nothing to your note. Highlights, shapes and text boxes all honour it. They live in a collection the plugin owns, **PDF Marks**, hidden from the sidebar and from search, so they follow you between devices without putting anything in your notes. It's created the first time you use the mode, and never otherwise.
- **Rewrite text you've placed.** Double-click a text box to edit it. **Shift+Enter** starts a new line, and line breaks now survive everywhere: on the page, in the note, and in the exported PDF.
- **Number shortcuts.** **1** to **5** pick a tool, top to bottom. **6**, **7** and **8** choose what the note gets. They only fire inside the PDF, so numbers still type normally in your notes, and never while you're typing in a text box or the find bar.
- **Fixed: markup disappeared when you zoomed.** Zooming re-renders every page, which takes the overlays with it, and the redraw that should have put them back was being dropped. It's queued now, so the same can't happen on fast scrolling or page changes either.
- **Fixed: Backspace deleted a shape while you were typing.** The key handler was acting on Delete, Escape and ⌘Z even when a text box or the find bar had the keyboard.
- **Fixed: the keyboard jumped to your note after every mark**, which turned the tool shortcuts into stray digits typed into it.
- **Your markup now shows on a phone or iPad.** Those show one panel at a time, so the note isn't beside the PDF and the marks that are rebuilt from it had nothing to rebuild from. The plugin now keeps a travelling copy on the same synced page, and reads it only where the note can't be reached. The note stays the source of truth everywhere it's open. Deleting a note-backed mark still needs the note, and says so instead of half-removing it.

## v2.5.2 — 2026-09-16

- **Fixed: markup could disappear.** Highlights, shapes and text boxes could vanish after refreshing the page, or after navigating away and coming back. The note still held every reference, but nothing was drawn on the PDF and nothing brought it back. The plugin rebuilds its markup from the note, and it could not tell "this note has no marks" apart from "this note hasn't loaded yet" — so an empty read overwrote real work. A note with no lines is now treated as not ready, only the note a PDF is actually filed under may clear it, and the rebuild keeps asking until the note answers instead of giving up after two seconds.
- **Number shortcuts for the tool rail.** 1 Select, 2 Text, 3 Text Box, 4 Shapes, 5 Style, top to bottom. They work only inside the PDF, so numbers still type normally in your note, and never fire while you're typing in a text box or the find bar.

## v2.5.1 — 2026-09-02

- **Both download arrows now export your markup.** The PDF viewer's own download button used to save the original file, silently and without markup, while the plugin's export lived in the tool rail. Now either one gives you the annotated PDF.
- **No more silent unmarked copies.** If nothing could be drawn, the export stops and tells you why instead of handing you a file that looks like the original. When only some marks fail, it says how many and what went wrong.
- **Correct filename in the browser.** The web client named the file "PDF.js viewer (annotated).pdf"; it now uses the document's own name, as the desktop app already did.

## v2.5.0 — 2026-09-02

- **Export an annotated PDF.** The download button in the tool rail saves a copy of the PDF with your markup drawn into it. It's written as real vector objects, not a flattened image, so the text stays selectable and searchable and it prints correctly from any reader.
- **Type on the page.** A new **Text Box** tool writes directly onto the PDF. What you type appears in the note as a plain heading with a linked arrow back to the spot, and exports as real PDF text — selectable and searchable in the exported file.
- **Undo and redo.** **⌘Z** and **⌘⇧Z** cover creating, deleting, moving, resizing, restyling and merging quotes. They work inside the PDF only, so Thymer keeps its own undo in the note. Dragging a slider counts as one step, not forty.
- **Fixes.** Backlinks now scroll to shapes and text boxes, not just highlights. Marks are hit-tested against what is actually drawn, so a text box can be selected, moved, recoloured and deleted reliably. The Text Box tool now uses the shape palette it actually draws with, so the colour you pick is the colour you get. Deleting the last mark under the Highlights heading no longer removes the heading itself.

## v2.4.0 — 2026-08-24

- **A tool rail over the PDF.** Four compact buttons — Select, Text, Shapes and Style — each showing what it will do. A click uses the tool; its menu opens from the button's bottom edge or a right-click.
- **Underline and strikethrough**, alongside highlighting. A strikethrough files its note in a **warning** block.
- **Area capture.** Drag a box over a column or a paragraph instead of selecting it line by line. On a page with real text the capture is exact, character for character; on a scanned page the same drag runs OCR.
- **Citation or Comment.** Every text mark can either quote the passage or give you an empty block to write your own note in — combined freely with highlight, underline, strikethrough or area.
- **Draw on the page.** Rectangles, ellipses, lines, arrows and freehand, with colour, fill, line type (solid, dashed, dotted, dash-dot), thickness and opacity. Select a shape to move it, drag its handles to resize it, and press Delete to remove it. Every shape writes a note block with a line to say why it's there.
- **⌘ now merges.** Holding ⌘ while selecting folds the passage into your previous quote, so a passage broken across ragged line ends becomes one citation with a single backlink. Merging stops at a page break, where one link could only point at one of the pages.
- **Captured lists become real lists.** A bullet or numbered list arrives as Thymer list items rather than text that happens to start with a bullet — including from OCR, which rarely reads a bullet glyph as one.
- **Better OCR structure.** Line breaks and paragraphs survive: the recognised text is rebuilt from Tesseract's own line boxes instead of being flattened into one run-on paragraph.
- **It follows your theme.** The rail, menus and panels use Thymer's colours, and a selected shape is outlined in your theme's accent.
- **A shortcuts panel** behind the **?** button, listing every gesture.
- **Fixes.** Highlight colour no longer washes over the text it marks; a highlighted sentence is one continuous band instead of a box per word; a selection that starts or ends mid-line no longer pulls in the surrounding words.

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
