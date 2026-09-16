# PDF Highlighter — handover

## Where to work

| | |
|---|---|
| Source | `~/Documents/Claude/Projects/Thymer_plugins/pdf-highlight-to-text/plugin.js` (the only source file) |
| Repo | `github.com/parham-shafti/thymer-pdf-highlighter`, branch `main` |
| Installed plugin | guid `1RH8BM4PJR82QCM5739AEQ1F5G` |
| Workspace | `W3A94WDCQDSF6X2HT78CJBPBN1` |

Deploy to Parham's workspace (the desktop app must be running):

```bash
node --check plugin.js && thymer plugin update code 1RH8BM4PJR82QCM5739AEQ1F5G -w W3A94WDCQDSF6X2HT78CJBPBN1 --file plugin.js
```

**Keep source == deployed == git.** Before any release, prove it:

```bash
thymer plugin show 1RH8BM4PJR82QCM5739AEQ1F5G -w W3A94WDCQDSF6X2HT78CJBPBN1 --json | python3 -c "import sys,json;print((json.load(sys.stdin).get('code') or '')==open('plugin.js').read())"
```

Releasing also means bumping `plugin.json`, the CHANGELOG, the git tag, **and** the installed
config's `version` (Thymer shows that one, and it is easy to forget).

## State as of 2026-09-16

v2.6.0, commit `4330204`, tagged and pushed. Working tree clean. Nothing pending.

## How it works, in one paragraph

**The note is the record.** Highlights are not stored as pixels: every mark writes a line to
the note carrying a backlink URL, and `_rebuildFromNote` re-derives the overlays from those
lines whenever pages render. Text highlights are re-found in the page's text layer; shapes,
text boxes and OCR marks carry their geometry in the URL, so they need no text layer. The
plugin's config store is a cache of that derivation, never the truth.

Two things live outside the note:
- **PDF Only marks** (`_noteMode === "none"`) write nothing to the note, so they have no
  source to be rebuilt from. They live in a plugin-owned collection **PDF Marks**, hidden
  from sidebar and search, one page per PDF, identified by the page NAME.
- **A travelling cache** of the derived marks sits on that same page, read ONLY when the
  note cannot be reached (phone and iPad show one panel at a time).

## Invariants. Break these and users lose work

1. **Never write an empty derivation over a non-empty store.** An unread note and an empty
   note look identical at the call site. `_rebuildFromNote` bails when the note returns no
   line items, and only clears when the note it read is the one it has already seen holding
   this PDF's marks (`hook._ownerGuid`).
2. **Never drop the trailing call of a throttle.** Zoom tears down every page and takes the
   overlays with it; the dropped call is the one that would have restored them.
3. **The cache never competes with the note.** It is read only where the note is missing, and
   rewritten whenever the derivation changes.
4. **Guards go on the entrance, not the branch.** The capture-phase key handler bails whole
   when a field has focus; `_commitExtract` returns focus to the viewer on every path.

## Testing, and the traps that waste hours

- **The web client runs stale plugin code**, minutes to 25+ minutes after a push, and a reload
  does not force it. The version number updates before the code does. On a phone it is worse.
  A report right after a deploy is probably about the old build. Establish which build is
  running before debugging anything.
- **The viewer iframe is its own world.** It is laid out at full document height, so
  `position: fixed` inside it anchors to the whole document, its `clientX/clientY` are not the
  parent's (`_toTopCoords`), its clicks never bubble to Thymer's document, and typed arrays
  created inside it fail `instanceof` checks outside it.
- **CDP (port 9222) only opens at app launch**, so it is usually unavailable mid-session. The
  fallback that works: write a blob to the plugin config and read it with
  `thymer plugin show ... --json`.
- Verify in the app, never in a mock.

## Open, not urgent

- Radii are hardcoded 4px; the house rule moved to `var(--radius-normal)` on 2026-08-29.
- A PDF Marks page grows with the mark count (19 marks was about 5 kB on one line). Fine so
  far; the first place to look if a heavily annotated PDF misbehaves.
- Deferred to a Thymer Editor API: placing extracts at the caret, and image extraction.
