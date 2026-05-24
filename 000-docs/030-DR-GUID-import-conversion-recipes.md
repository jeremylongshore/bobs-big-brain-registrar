# Import Conversion Recipes

How to get content from various sources into qmd-team-intent-kb's vault import pipeline.

**Principle**: Markdown is the universal input format. Don't build format converters — let
existing battle-tested tools handle conversion upstream. The import pipeline only needs to be
world-class at ingesting Markdown directories with frontmatter, wiki-links, and batch tracking.

## The Pipeline

```
Source format → Convert to Markdown → Place in a directory → teamkb_vault_import
```

All conversions produce a directory of `.md` files. The import pipeline handles:

- YAML frontmatter extraction (title, category, tags)
- Wiki-link resolution (`[[slug]]` → graph edges)
- Content hash dedup (exact match detection)
- Batch tracking with rollback

## Obsidian Vault (Native)

No conversion needed. Point the import directly at your vault:

```
teamkb_vault_import { "sourcePath": "/path/to/my-vault" }
```

The pipeline automatically:

- Excludes `.obsidian/`, `.trash/`, `.git/`, `node_modules/`
- Parses YAML frontmatter for title, category, tags
- Resolves `[[wiki-links]]` to graph edges
- Skips empty files

### Frontmatter Convention

For best results, add frontmatter to your Obsidian notes:

```yaml
---
title: API Design Patterns
category: pattern
tags: [api, architecture, rest]
---
```

Valid categories: `decision`, `pattern`, `convention`, `architecture`, `troubleshooting`, `onboarding`, `reference`. Files without a category default to `reference`.

## Notion

1. **Export**: Settings → Workspace → Export all workspace content → Markdown & CSV
2. **Unzip** the export to a local directory
3. **Import**:

   ```
   teamkb_vault_import { "sourcePath": "/path/to/notion-export" }
   ```

Notion exports include frontmatter-like headers. Titles are derived from filenames.

### Alternative: Obsidian Importer

The [Obsidian Importer](https://github.com/obsidianmd/obsidian-importer) plugin (MIT) converts
Notion exports to clean Obsidian-compatible Markdown with proper wiki-links.

## Google Docs

1. **Download** as .docx: File → Download → Microsoft Word (.docx)
2. **Convert** with pandoc:

   ```bash
   pandoc input.docx -t markdown -o output.md
   ```

3. **Import** the output directory

### Batch conversion for Google Drive exports

```bash
mkdir converted
for f in *.docx; do
  pandoc "$f" -t markdown -o "converted/${f%.docx}.md"
done
teamkb_vault_import { "sourcePath": "/path/to/converted" }
```

## Confluence

1. **Export**: Space Settings → Content Tools → Export → HTML or XML
2. **Convert** with pandoc:

   ```bash
   pandoc input.html -t markdown -o output.md
   ```

3. **Import** the converted directory

Or use Confluence's Markdown export plugin if available in your instance.

## Microsoft OneNote / Apple Notes / Evernote / Bear / Roam

Use the [Obsidian Importer](https://github.com/obsidianmd/obsidian-importer) plugin. It supports:

| Source        | Format          | Notes                      |
| ------------- | --------------- | -------------------------- |
| OneNote       | Direct API      | Requires sign-in           |
| Apple Notes   | Database        | macOS only                 |
| Evernote      | .enex export    | Export from Evernote first |
| Bear          | .bear2bk export | Export from Bear first     |
| Roam Research | .json export    | Export from Roam first     |
| Google Keep   | Google Takeout  | Download via Takeout       |

After importing into an Obsidian vault, point `teamkb_vault_import` at that vault.

## Plain Text / Code Documentation

Already Markdown? Just import directly. For other text formats:

```bash
# RST → Markdown
pandoc input.rst -t markdown -o output.md

# HTML → Markdown
pandoc input.html -t markdown -o output.md

# EPUB → Markdown
pandoc input.epub -t markdown -o output.md

# ODT → Markdown
pandoc input.odt -t markdown -o output.md
```

## Pandoc One-Liner (Any Supported Format)

pandoc supports 40+ input formats. For any supported format:

```bash
pandoc input.FORMAT -t markdown -o output.md
```

Common formats: `.docx`, `.pptx`, `.html`, `.epub`, `.odt`, `.rtf`, `.rst`, `.textile`, `.mediawiki`, `.org`

## Preview Before Import

Always preview first:

```
teamkb_vault_preview { "sourcePath": "/path/to/converted" }
```

This reports:

- Total file count
- How many would be created vs. skipped (duplicates)
- Per-file collision details

## Rollback

If an import went wrong:

```
teamkb_vault_rollback { "batchId": "uuid-from-import-result" }
```

This deletes all candidates created by the batch and marks it as rolled back.
