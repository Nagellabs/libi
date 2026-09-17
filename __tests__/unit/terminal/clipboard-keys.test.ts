import { describe, it, expect } from "vitest";
import { isWindowsPlatform, terminalClipboardShortcut } from "@/lib/terminal/clipboard-keys";

type Key = Parameters<typeof terminalClipboardShortcut>[0];

function key(keyCode: number, mods: Partial<Omit<Key, "keyCode">> = {}): Key {
  return { keyCode, ctrlKey: false, altKey: false, metaKey: false, ...mods };
}

const V = (mods: Partial<Omit<Key, "keyCode">> = {}) => key(86, { ctrlKey: true, ...mods });
const C = (mods: Partial<Omit<Key, "keyCode">> = {}) => key(67, { ctrlKey: true, ...mods });
const windows = { windows: true, hasSelection: false };

describe("terminalClipboardShortcut", () => {
  it("on Windows, Ctrl+V pastes, with or without Shift", () => {
    expect(terminalClipboardShortcut(V(), windows)).toBe("paste");
    expect(terminalClipboardShortcut({ ...V(), shiftKey: true } as Key, windows)).toBe("paste");
  });

  it("goes by the key the layout calls V: a Hebrew layout's Ctrl+V pastes, and Dvorak's physical V key (K) stays Ctrl+K", () => {
    // Windows reports keyCode 86 for V whatever character the layout types there.
    expect(terminalClipboardShortcut({ ...V(), code: "KeyV", key: "ה" } as Key, windows)).toBe("paste");
    expect(terminalClipboardShortcut({ ...key(75, { ctrlKey: true }), code: "KeyV" } as Key, windows)).toBeNull();
    expect(terminalClipboardShortcut({ ...key(74, { ctrlKey: true }), code: "KeyC" } as Key, { windows: true, hasSelection: true })).toBeNull();
  });

  it("on Windows, Ctrl+C copies only while text is selected; without a selection it stays the interrupt", () => {
    expect(terminalClipboardShortcut(C(), { windows: true, hasSelection: true })).toBe("copy");
    expect(terminalClipboardShortcut(C(), windows)).toBeNull();
  });

  it("leaves AltGr (Ctrl+Alt), ⌘ combinations and plain letters to xterm", () => {
    expect(terminalClipboardShortcut(V({ altKey: true }), windows)).toBeNull();
    expect(terminalClipboardShortcut(V({ metaKey: true }), windows)).toBeNull();
    expect(terminalClipboardShortcut(key(86), windows)).toBeNull();
    expect(terminalClipboardShortcut(key(65, { ctrlKey: true }), windows)).toBeNull();
  });

  it("changes nothing off Windows: a Mac pastes with ⌘V, and Ctrl+V stays ^V for the shell", () => {
    expect(terminalClipboardShortcut(V(), { windows: false, hasSelection: true })).toBeNull();
    expect(terminalClipboardShortcut(C(), { windows: false, hasSelection: true })).toBeNull();
  });
});

describe("isWindowsPlatform", () => {
  it("reads navigator.platform the way xterm does", () => {
    expect(isWindowsPlatform("Win32")).toBe(true);
    expect(isWindowsPlatform("MacIntel")).toBe(false);
    expect(isWindowsPlatform("Linux x86_64")).toBe(false);
    expect(isWindowsPlatform(undefined)).toBe(false);
  });
});
