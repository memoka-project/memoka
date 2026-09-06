import { useState } from "react";
import { SearchPane } from "./SearchPane";

export interface GroupNameSession {
  readonly initialName: string;
  readonly rename: boolean;
  readonly accept: (name: string) => Promise<unknown>;
  readonly restoreFocus: () => void;
}

export function GroupNameDialog({
  session,
  onClose,
}: {
  session: GroupNameSession;
  onClose: () => void;
}) {
  const [name, setName] = useState(session.initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <SearchPane
      ariaLabel={session.rename ? "グループ名を変更" : "グループを作成"}
      inputAriaLabel="グループ名"
      focusSurface="group-name"
      query={name}
      onQueryChange={setName}
      items={[{ id: "accept", name }]}
      itemId={(item) => item.id}
      renderItem={() => (
        <span>
          {session.rename ? "グループ名を変更" : "グループを作成"} ·{" "}
          {name || "無題のグループ"}
        </span>
      )}
      renderPreview={() => null}
      prompt="group›"
      countLabel=""
      busy={busy}
      error={error}
      onAccept={() => {
        setBusy(true);
        void session.accept(name).then(
          () => {
            onClose();
            queueMicrotask(session.restoreFocus);
          },
          (cause) => {
            setError(cause instanceof Error ? cause.message : String(cause));
            setBusy(false);
          },
        );
      }}
      onClose={onClose}
      restoreFocus={session.restoreFocus}
    />
  );
}
