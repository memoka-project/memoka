// Paste this entire file into Memoka's DevTools console before reproducing.
// Stop/export: copy(JSON.stringify(memokaImeTrace.stop(), null, 2))
// Explicitly opt-in, memory-only, bounded. No text, titles, URLs or IDs are read.
(() => {
  window.memokaImeTrace?.stop();
  const records = [];
  const bindings = new Map();
  const nodes = new WeakMap();
  const started = performance.now();
  let stopped = false;
  let nextNode = 0;
  let dropped = 0;
  const nodeId = (node) => {
    if (!node) return null;
    if (!nodes.has(node)) nodes.set(node, ++nextNode);
    return nodes.get(node);
  };
  const record = (event, root, detail = {}) => {
    if (stopped) return;
    const editor = root.editor;
    const state = editor && !editor.isDestroyed ? editor.state : null;
    const selection = document.getSelection();
    const nativeInside = selection && root.contains(selection.focusNode);
    const surface = root.closest(".editor-window");
    const imeDetail = surface?.dataset.imeOffDetail;
    records.push({
      ms: Math.round((performance.now() - started) * 10) / 10,
      event,
      editor: nodeId(root),
      connected: root.isConnected,
      focused: document.activeElement === root,
      mode: root.dataset.vimMode,
      composing: editor && !editor.isDestroyed ? editor.view.composing : null,
      modelSelection: state
        ? [state.selection.anchor, state.selection.head]
        : null,
      ancestors: state
        ? Array.from(
            { length: state.selection.$head.depth },
            (_, i) => state.selection.$head.node(i + 1).type.name,
          )
        : [],
      storedMarks: state?.storedMarks?.map((mark) => mark.type.name) ?? null,
      nativeNode: nativeInside ? nodeId(selection.focusNode) : null,
      nativeOffset: nativeInside ? selection.focusOffset : null,
      imeOff: surface?.dataset.imeOffStatus,
      imeDetail: /^windows-ime-[a-z-]+$/.test(imeDetail ?? "")
        ? imeDetail
        : null,
      ...detail,
    });
    if (records.length > 800) {
      records.shift();
      dropped++;
    }
  };
  const bind = (root) => {
    if (bindings.has(root)) return;
    const editor = root.editor;
    const transaction = ({ transaction: tr, appendedTransactions = [] }) => {
      record("transaction", root, {
        docChanged: tr.docChanged,
        selectionSet: tr.selectionSet,
        scrollRequested: tr.scrolledIntoView,
        compositionTransaction: tr.getMeta("composition") !== undefined,
        steps: [tr, ...appendedTransactions].flatMap((t) =>
          t.steps.map((step) => step.constructor.name),
        ),
      });
    };
    editor?.on("transaction", transaction);
    const observer = new MutationObserver((mutations) => {
      record("dom-mutation", root, {
        childChanges: mutations.filter((m) => m.type === "childList").length,
        textChanges: mutations.filter((m) => m.type === "characterData").length,
        editableChanges: mutations.filter((m) => m.type === "attributes")
          .length,
        removedNodes: mutations.reduce((n, m) => n + m.removedNodes.length, 0),
      });
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["contenteditable"],
    });
    bindings.set(root, () => {
      editor?.off("transaction", transaction);
      observer.disconnect();
    });
    record("attach", root);
  };
  const events = [
    "keydown",
    "keyup",
    "beforeinput",
    "input",
    "compositionstart",
    "compositionupdate",
    "compositionend",
    "focus",
    "blur",
  ];
  const handle = (event) => {
    const root =
      event.target instanceof Element
        ? event.target.closest(".memoka-editor")
        : null;
    if (!root) return;
    bind(root);
    const detail = {
      key:
        event instanceof KeyboardEvent &&
        [
          "Escape",
          "Enter",
          "Control",
          "Shift",
          "Tab",
          "Process",
          "Unidentified",
        ].includes(event.key)
          ? event.key
          : null,
      ctrl: event instanceof KeyboardEvent ? event.ctrlKey : undefined,
      isComposing: event.isComposing,
      inputType: event instanceof InputEvent ? event.inputType : undefined,
      dataLength:
        typeof event.data === "string" ? event.data.length : undefined,
    };
    record(event.type, root, detail);
    // Observe after the editor/browser handlers without flushing the DOM,
    // changing focus/selection, or interfering with the IME event itself.
    queueMicrotask(() =>
      record(`${event.type}:after`, root, {
        prevented: event.defaultPrevented,
      }),
    );
  };
  const selectionChange = () => {
    for (const root of bindings.keys()) {
      if (document.activeElement === root || !root.isConnected)
        record("selectionchange", root);
    }
  };
  for (const type of events) document.addEventListener(type, handle, true);
  document.addEventListener("selectionchange", selectionChange);
  document.querySelectorAll(".memoka-editor").forEach(bind);
  const read = () => ({
    userAgent: navigator.userAgent,
    dropped,
    records: records.slice(),
  });
  window.memokaImeTrace = {
    read,
    stop() {
      stopped = true;
      for (const type of events)
        document.removeEventListener(type, handle, true);
      document.removeEventListener("selectionchange", selectionChange);
      for (const dispose of bindings.values()) dispose();
      bindings.clear();
      return read();
    },
  };
})();
