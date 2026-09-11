import { useRef, useState } from "react";
import { nativeErrorMessage } from "../core/history";
import { ModalDialog } from "./ModalDialog";

export function NewWorkspaceDialog({
  onCreate,
  onReceive,
  onClose,
}: {
  onCreate: () => Promise<void>;
  onReceive?: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = useRef(false);
  const create = async () => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await onCreate();
    } catch (cause) {
      setError(nativeErrorMessage(cause));
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  return (
    <ModalDialog
      ariaLabel="新しいWorkspace"
      focusSurface="new-workspace"
      compact
      busy={busy}
      onClose={() => {
        if (!working.current) onClose();
      }}
    >
      <h2>新しいWorkspace</h2>
      <p>
        新しい空の保存先を使います。別端末からの受信は途中から再開することもできます。
      </p>
      <p>切り替え前に、現在のWorkspaceの保存とバックアップの完了を待ちます。</p>
      {error && <p role="alert">{error}</p>}
      <div className="application-modal-actions">
        <button disabled={busy} onClick={() => void create()}>
          空のWorkspaceを作成
        </button>
        {onReceive && (
          <button disabled={busy} onClick={onReceive}>
            別端末から受信
          </button>
        )}
        <button disabled={busy} onClick={onClose}>
          閉じる
        </button>
      </div>
    </ModalDialog>
  );
}
