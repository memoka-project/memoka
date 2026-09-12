import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ModalDialog } from "./ModalDialog";
import { formatEventDateTime } from "../core/display-datetime";
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

function failureCode(cause: unknown): string | null {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

function receiveErrorGuide(code: string | null): {
  title: string;
  next: string;
} {
  switch (code) {
    case "SYNC_INVITE_EXPIRED":
      return {
        title: "招待コードの有効期限が切れています。",
        next: "元端末で新しい招待コードを作成して貼り付け直してください。",
      };
    case "SYNC_INVITE":
    case "SYNC_SCHEMA":
      return {
        title: "招待コードを正しく読み込めませんでした。",
        next: "元端末の「招待コードをコピー」で全体をそのまま貼り付けてください。",
      };
    case "SYNC_JOIN_DESTINATION":
      return {
        title: "保存先が受信に使用できません。",
        next: "初めての受信には新しい空のディレクトリを選んでください。中断した受信の再開にも同じ保存先が必要です。",
      };
    case "SYNC_REPLICA_REUSE":
      return {
        title: "保存先が中断した受信と一致しません。",
        next: "受信を始めたときと同じ保存先を選んで再開してください。",
      };
    default:
      return {
        title: "元端末へ接続できませんでした。",
        next: "両方の端末が同じLAN・VPNに接続していることと、招待コードの有効期限を確認して、もう一度試してください。",
      };
  }
}

interface InvitationPreview {
  addresses: string[];
  expiresAt: number;
}

function previewInvitation(code: string): InvitationPreview | null {
  const encoded = code.trim().replace(/^memoka-sync:/, "");
  if (!encoded) return null;
  try {
    const standard = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const padded = standard.padEnd(
      standard.length + ((4 - (standard.length % 4)) % 4),
      "=",
    );
    const decoded = atob(padded);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index++)
      bytes[index] = decoded.charCodeAt(index);
    const signed = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof signed.content !== "string") return null;
    const contentDecoded = atob(signed.content);
    const content = new Uint8Array(contentDecoded.length);
    for (let index = 0; index < contentDecoded.length; index++)
      content[index] = contentDecoded.charCodeAt(index);
    const invitation = JSON.parse(new TextDecoder().decode(content));
    if (
      !Array.isArray(invitation.addresses) ||
      !invitation.addresses.every((a: unknown) => typeof a === "string") ||
      typeof invitation.expiresAt !== "number"
    )
      return null;
    return {
      addresses: invitation.addresses,
      expiresAt: invitation.expiresAt,
    };
  } catch {
    return null;
  }
}

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
  const [errorCode, setErrorCode] = useState<string | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    void invoke<string | null>("sync_default_device_name")
      .then((suggested) => {
        if (!cancelled && suggested) setName((current) => current || suggested);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const reportError = (cause: unknown) => {
    if (!active.current) return;
    setError(synchronizationError(cause));
    setErrorCode(failureCode(cause));
  };
  const act = async (action: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    setErrorCode(null);
    try {
      await action();
    } catch (cause) {
      reportError(cause);
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
  const failed = view?.phase === "error";
  const guide = receiveErrorGuide(errorCode ?? view?.error?.code ?? null);

  return (
    <ModalDialog
      ariaLabel="別端末から受信"
      focusSurface="sync-join"
      className="sync-settings-dialog"
      busy={busy}
      onClose={close}
    >
      <h2>別端末から受信</h2>
      {(error || view?.error) && (
        <section role="alert" className="sync-join-error">
          <h3>{guide.title}</h3>
          <p>{error ?? view?.error?.message}</p>
          <p>{guide.next}</p>
          {(errorCode ?? view?.error?.code) && (
            <details>
              <summary>エラーの詳細</summary>
              <code>{errorCode ?? view?.error?.code}</code>
            </details>
          )}
        </section>
      )}
      {view && !failed && (
        <section aria-live="polite">
          <h3>{labels[view.phase] ?? view.phase}</h3>
          <p>{view.name}</p>
          <code>{view.fingerprint}</code>
          {view.phase === "approval" && (
            <p>
              この名前と鍵の識別情報を元端末で確認し、承認してもらってください。
            </p>
          )}
        </section>
      )}
      {!receiving && view?.phase !== "ready" && (
        <section aria-label="受信を開始">
          <label>
            この端末の名前
            <input
              value={name}
              maxLength={256}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            ここに同期元で作成した招待コードを貼り付けてください
            <textarea
              rows={4}
              value={info}
              onChange={(event) => setInfo(event.target.value)}
            />
          </label>
          {(() => {
            if (!info.trim()) return null;
            const preview = previewInvitation(info);
            if (!preview)
              return <p role="alert">有効な招待コードではありません</p>;
            return (
              <dl className="sync-status-facts">
                <div>
                  <dt>同期元のアドレス</dt>
                  <dd>{preview.addresses.join("、")}</dd>
                </div>
                <div>
                  <dt>有効期限</dt>
                  <dd>
                    {formatEventDateTime(
                      new Date(preview.expiresAt * 1000).toISOString(),
                    )}
                  </dd>
                </div>
              </dl>
            );
          })()}
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const selected = await dataArea.chooseDirectory();
                if (selected) setPath(selected);
              })
            }
            type="button"
          >
            新しい空の保存先を選択
          </button>
          <p>{path ?? "保存先を選択してください"}</p>
          <button
            disabled={busy || !path || !name.trim() || !info.trim()}
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
            type="button"
          >
            受信を開始
          </button>
        </section>
      )}
      {view?.phase === "ready" && (
        <>
          <p>添付ファイルはWorkspaceを開いてから引き続き取得します。</p>
          <button
            disabled={busy}
            onClick={() => void act(() => onReady(view.path))}
            type="button"
          >
            Workspaceを開く
          </button>
        </>
      )}
      <div className="application-modal-actions">
        <button disabled={busy} onClick={close} type="button">
          {receiving ? "中断して閉じる" : "閉じる"}
        </button>
      </div>
    </ModalDialog>
  );
}
