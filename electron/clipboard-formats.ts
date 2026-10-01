// electron/clipboard-formats.ts
/**
 * How Electron main puts an EXPORT FILE (not its path) on the OS clipboard, as
 * decided by plan task A0 (docs-local/superpowers/spikes/2026-09-29-file-clipboard.md).
 *
 * macOS: the pasteboard type written with `clipboard.writeBuffer` — verified by an
 * osascript file-URL read-back of both candidate formats (see the findings note
 * above). An actual Finder paste is not yet confirmed and is checked in the final
 * live verification.
 *
 * Windows: Electron cannot write the predefined CF_HDROP format (`writeBuffer`
 * registers a custom format by name). `"powershell-filedrop"` runs
 * `Set-Clipboard -LiteralPath`; it is used only once a paste in Explorer has been
 * observed on a real Windows desktop. Until then `"path"`: the renderer copies
 * the file's location instead and says so.
 */
export const MAC_FILE_CLIPBOARD_FORMAT: "NSFilenamesPboardType" | "public.file-url" = "NSFilenamesPboardType";
export const WINDOWS_FILE_CLIPBOARD: "path" | "powershell-filedrop" = "path";
