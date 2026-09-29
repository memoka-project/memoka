import { useEffect, useMemo, useState } from "react";
import type { VimRegisterName } from "../vim/register-store";
import { SearchPane } from "./SearchPane";

export interface RegisterPickerSession {
  readonly restoreFocus: () => void;
  readonly read: (name: VimRegisterName) => Promise<string | null>;
  readonly select: (name: VimRegisterName) => void;
}

const REGISTER_NAMES = [
  '"',
  "+",
  "*",
  "_",
  ..."abcdefghijklmnopqrstuvwxyz",
  ...Array.from({ length: 10 }, (_, index) => String(index)),
] as VimRegisterName[];

const REGISTER_LABELS: Partial<Record<VimRegisterName, string>> = {
  '"': "無名",
  "0": "直近のヤンク",
  "+": "クリップボード",
  "*": "PRIMARY 選択",
  _: "ブラックホール",
};

export function RegisterPicker({
  session,
  onClose,
}: {
  session: RegisterPickerSession;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<VimRegisterName | null>(null);
  const [preview, setPreview] = useState<{
    name: VimRegisterName;
    text: string | null;
  } | null>(null);
  const items = useMemo(
    () =>
      REGISTER_NAMES.filter((name) =>
        `${name} ${REGISTER_LABELS[name] ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [query],
  );

  useEffect(() => {
    if (!selected) return;
    let active = true;
    void session.read(selected).then((value) => {
      if (active) setPreview({ name: selected, text: value });
    });
    return () => {
      active = false;
    };
  }, [selected, session]);

  return (
    <SearchPane
      ariaLabel="Vimレジスタを選択"
      inputAriaLabel="Vimレジスタを検索"
      focusSurface="register-picker"
      commandContext="search.insert"
      query={query}
      onQueryChange={setQuery}
      items={items}
      itemId={(name) => name}
      renderItem={(name) => (
        <span className="command-picker__row">
          <strong>"{name}</strong>
          <span>
            {REGISTER_LABELS[name] ??
              (/[1-9]/u.test(name) ? "削除・変更履歴" : "名前付き")}
          </span>
        </span>
      )}
      renderPreview={(name) => (
        <div className="workspace-search-preview-pane command-picker__preview">
          <strong>{name ? `"${name}` : "レジスタ"}</strong>
          <pre>
            {name === "_"
              ? "読み取り不可"
              : ((preview?.name === name ? preview.text : null) ?? "空")}
          </pre>
        </div>
      )}
      prompt="レジスタ"
      countLabel={`${items.length}件`}
      onSelectionChange={setSelected}
      onAccept={(name) => {
        session.select(name);
        onClose();
        session.restoreFocus();
      }}
      onClose={onClose}
      restoreFocus={session.restoreFocus}
    />
  );
}
