import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ModalDialog } from "./ModalDialog";
import type { DataAreaPort } from "../platform/data-area";
import {
  synchronizationError,
  type SyncFailure,
} from "../platform/synchronization";

interface JoinView {
  path: string;
  phase: string;
  name: string;
  fingerprint: string;
  error: SyncFailure | null;
}
const labels: Record<string, string> = {
  connecting: "接続中",
  retrying: "接続を再試行しています",
  approval: "招待側の承認待ち",
  receiving: "文書を受信中",
  applying: "文書を検証・保存中",
  ready: "本文の受信が完了しました",
  error: "受信が中断されました",
};

export function SyncJoinDialog({
  dataArea,
  onReady,
  onClose,
}: {
  dataArea: DataAreaPort;
  onReady: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [info, setInfo] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [view, setView] = useState<JoinView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true),
    working = useRef(false);
  useEffect(() => {
    active.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const next = await invoke<JoinView | null>("sync_join_status");
        if (active.current && next) setView(next);
      } catch (cause) {
        if (active.current) setError(synchronizationError(cause));
      } finally {
        if (active.current) timer = setTimeout(() => void read(), 1000);
      }
    };
    void read();
    return () => {
      active.current = false;
      clearTimeout(timer);
    };
  }, []);
  const act = async (action: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      if (active.current) setError(synchronizationError(cause));
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
    }
  };
  const receiving = view && !["error", "ready"].includes(view.phase);
  const close = () =>
    void act(async () => {
      await invoke("sync_join_stop");
      onClose();
    });
  return (
    <ModalDialog
      ariaLabel="別端末から受信"
      focusSurface="sync-join"
      className="sync-settings-dialog"
      busy={busy}
      onClose={close}
    >
      <h2>別端末から受信</h2>
      <p>
        招待側の:sync-settingsで作成した接続情報を入力してください。初回は新しい空の保存先へ複製します。
      </p>
      {(error || view?.error) && (
        <p role="alert">{error ?? view?.error?.message}</p>
      )}
      {view && (
        <section aria-live="polite">
          <h3>{labels[view.phase] ?? view.phase}</h3>
          <p>{view.name}</p>
          <code>{view.fingerprint}</code>
          {view.phase === "approval" && (
            <p>この名前と鍵の識別情報を招待側で確認し、承認してください。</p>
          )}
        </section>
      )}
      {!receiving && view?.phase !== "ready" && (
        <>
          <label>
            この端末の名前
            <input
              value={name}
              maxLength={256}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            接続情報
            <textarea
              rows={4}
              value={info}
              onChange={(e) => setInfo(e.target.value)}
            />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const selected = await dataArea.chooseDirectory();
                if (selected) setPath(selected);
              })
            }
          >
            新しい保存先・再開する保存先を選択
          </button>
          <p>{path ?? "保存先を選択してください"}</p>
          <p>
            途中から再開する場合は同じ保存先を選びます。保存済みの登録情報を使うため、名前と接続情報の再入力は不要です。
          </p>
          <button
            disabled={busy || !path}
            onClick={() =>
              void act(async () => {
                const next = await invoke<JoinView>("sync_join_start", {
                  path,
                  connectionInfo: info,
                  name,
                });
                if (active.current) setView(next);
              })
            }
          >
            受信・再開
          </button>
        </>
      )}
      {view?.phase === "ready" && (
        <>
          <p>添付ファイルはWorkspaceを開いてから引き続き取得します。</p>
          <button
            disabled={busy}
            onClick={() => void act(() => onReady(view.path))}
          >
            Workspaceを開く
          </button>
        </>
      )}
      <div className="application-modal-actions">
        <button disabled={busy} onClick={close}>
          {receiving ? "中断して閉じる" : "閉じる"}
        </button>
      </div>
    </ModalDialog>
  );
}
