# Symbol catalogs

- `symbol-emoji.json`: Unicode Emoji 17.0, fully-qualified and component entries
  from <https://www.unicode.org/Public/17.0.0/emoji/emoji-test.txt>.
  Copyright © 2025 Unicode, Inc. Distributed under the Unicode License v3:
  <https://www.unicode.org/license.txt>.
- `symbol-icons.json`, `symbol-names.json` and `symbol-aliases.json`: generated from the pinned `lucide`
  1.47.0 package (ISC license; see the project's third-party notices).

Regenerate explicitly using `node scripts/generate-symbol-catalog.mjs`.
The app uses these bundled catalogs offline. Only icon names and alias mappings are loaded eagerly;
emoji descriptions and icon geometry are loaded on demand. Canonical icon names
are the package's file names, with export aliases included for search only.
