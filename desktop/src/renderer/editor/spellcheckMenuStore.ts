// A one-bit shared store: "is the spellcheck context menu currently open?".
//
// The spellcheck menu (components/SpellcheckMenu) and the floating format toolbar
// (FloatingFormatToolbarPlugin) are independent React trees — one is an app-root
// overlay driven by IPC, the other lives inside each editor's LexicalComposer.
// Both can be triggered by the same gesture: right-clicking a misspelled word
// selects it (a range → the format toolbar wants to show) AND fires the native
// context-menu (→ the spellcheck menu shows). That's the "two menus" bug.
//
// So they need to agree on who's visible. Rather than thread a prop across two
// trees, the spellcheck menu writes this flag and the format toolbar reads it via
// useSyncExternalStore, hiding itself while the flag is set. Deliberately tiny and
// framework-free so either side can import it without a provider.
let open = false;
const listeners = new Set<() => void>();

export const spellcheckMenuStore = {
  isOpen: () => open,
  setOpen: (next: boolean) => {
    if (open === next) return;
    open = next;
    for (const listener of listeners) listener();
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
