// Shared title helpers used by services, the disk scanner, and the parser.

export function sortTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, "")
    .trim();
}

// Normalized form for fuzzy matching release names against library titles.
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/['’.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Windows/SMB-illegal characters plus ASCII control characters.
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;

export function sanitizePathComponent(name: string): string {
  return name.replace(ILLEGAL, "").replace(/\.+$/, "").replace(/\s+/g, " ").trim();
}

// Path separators plus ASCII control characters — the minimum required to keep a
// name a single, safe path component. Used when the user disabled the aggressive
// "replace illegal characters" sanitize but we still can't let a name escape its
// directory (so ':', '?', '*', etc. are preserved, but '/' and '\' are not).
// eslint-disable-next-line no-control-regex
const PATH_UNSAFE = /[/\\\u0000-\u001f]/g;

export function stripPathSeparators(name: string): string {
  return name.replace(PATH_UNSAFE, "").replace(/\.+$/, "").replace(/\s+/g, " ").trim();
}
