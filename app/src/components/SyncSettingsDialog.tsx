import { useEffect, useRef, useState } from "react";
import { ModalDialog } from "./ModalDialog";
import { formatEventDateTime } from "../core/display-datetime";
import {
  devicePhase,
  nativeSynchronization,
  synchronizationError,
  type SyncAction,
  type SyncDevice,
  type SyncView,
  type SynchronizationPort,
} from "../platform/synchronization";

export interface SyncSettingsSession {
  restoreFocus: () => void;
}
const bytes = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1048576
      ? `${(value / 1024).toFixed(1)} KiB`
      : `${(value / 1048576).toFixed(1)} MiB`;
const addresses = (value: string) =>
  value
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
const fingerprint = (key: string) => key.match(/.{1,8}/g)?.join(" ") ?? key;

export function SyncSettingsDialog({
  workspaceId,
  session,
  onClose,
  onRecovery,
  prepare,
  port = nativeSynchronization,
}: {
  workspaceId: string;
  session: SyncSettingsSession;
  onClose: () => void;
  onRecovery: () => void;
  prepare?: () => Promise<void>;
  port?: SynchronizationPort;
}) {
  const [view, setView] = useState<SyncView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [bind, setBind] = useState("0.0.0.0:0");
  const [inviteAddresses, setInviteAddresses] = useState("");
  const [connectionInfo, setConnectionInfo] = useState<string | null>(null);
  const active = useRef(true);
  const saving = useRef(false);
  useEffect(() => {
    active.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const next = await port.status();
        if (active.current) setView(next);
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
  }, [port]);
  const act = async (action: SyncAction) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      if (action.action === "enable") await prepare?.();
      const result = await port.action(workspaceId, action);
      if (active.current) {
        if (result.connectionInfo) setConnectionInfo(result.connectionInfo);
        setView(await port.status());
      }
    } catch (cause) {
      if (active.current) setError(synchronizationError(cause));
    } finally {
      saving.current = false;
      if (active.current) setBusy(false);
    }
  };
  const close = () => {
    if (!saving.current) {
      onClose();
      queueMicrotask(session.restoreFocus);
    }
  };
  const configured = view?.config;
  return (
    <ModalDialog
      ariaLabel="端末間同期"
      focusSurface="sync-settings"
      className="sync-settings-dialog"
      busy={busy}
      onClose={close}
    >
      <h2>端末間同期</h2>
      <p>
        同じユーザーの端末をLAN・VPN内で接続します。Workspaceを開いている間は自動で同期し、切断中の編集は次の接続時に統合します。
      </p>
      <p>削除も他の端末へ伝わります。履歴とバックアップは引き続き必要です。</p>
      {(error || view?.error) && (
        <p role="alert">{error ?? view?.error?.message}</p>
      )}
      {!view ? (
        <p>読み込み中…</p>
      ) : !configured ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act({ action: "enable", name, bind });
          }}
        >
          <label>
            この端末の名前
            <input
              required
              maxLength={256}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            待受アドレス
            <input
              required
              value={bind}
              onChange={(e) => setBind(e.target.value)}
            />
          </label>
          <p>
            0.0.0.0:0で空きUDPポートを選びます。通信先は手動で登録したアドレスだけを使用します。
          </p>
          <button disabled={busy || !name.trim()} type="submit">
            同期を有効にする
          </button>
        </form>
      ) : (
        <>
          <div className="application-modal-actions">
            <button
              disabled={busy}
              onClick={() =>
                void act({ action: "pause", paused: !configured.paused })
              }
            >
              {configured.paused ? "再開" : "一時停止"}
            </button>
            <button
              disabled={busy || configured.paused}
              onClick={() => void act({ action: "reconnect" })}
            >
              今すぐ同期
            </button>
          </div>
          <p role="status">
            {configured.paused
              ? "一時停止中"
              : view.listening
                ? `待受中 ${view.listening}`
                : "接続準備中"}{" "}
            · 受信反映待ち {view.local.pendingApplyCount}件 (
            {bytes(view.local.pendingApplyBytes)}) · 添付取得待ち{" "}
            {view.local.pendingAttachmentCount}件 (
            {bytes(view.local.pendingAttachmentBytes)})
          </p>
          <p>
            最終反映{" "}
            {view.local.lastAppliedAt
              ? formatEventDateTime(view.local.lastAppliedAt)
              : "未確認"}{" "}
            · 送信準備 {view.local.pendingSignatureCount}件
          </p>
          {view.local.quarantinedCount > 0 && (
            <p role="alert">
              検証に失敗したデータ {view.local.quarantinedCount}
              件を隔離しました。
            </p>
          )}
          {!!view.failures.length && (
            <details>
              <summary>隔離したデータの失敗理由（先頭50件）</summary>
              <ul>
                {view.failures.map(([hash, reason]) => (
                  <li key={`${hash}:${reason}`}>
                    <p>{reason}</p>
                    <code>{hash}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!!view.attachmentTransfers.length && (
            <details>
              <summary>添付取得の詳細（先頭64件）</summary>
              <ul>
                {view.attachmentTransfers.map((transfer) => (
                  <li key={transfer.sha256}>
                    <p>
                      {bytes(transfer.received)} / {bytes(transfer.size)} ·{" "}
                      {transfer.error ?? "取得待ち"}
                    </p>
                    <code>{transfer.sha256}</code>
                    {transfer.error && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act({
                            action: "retryAttachment",
                            sha256: transfer.sha256,
                          })
                        }
                      >
                        この添付を再取得
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <section
            aria-label="登録端末"
            className="sync-device-list"
            data-modal-scroll
          >
            {view.devices.map((device) => (
              <Device
                key={device.member.origin.deviceId}
                device={device}
                frontier={view.local.frontier}
                local={
                  device.member.origin.deviceId === configured.origin.deviceId
                }
                paused={configured.paused}
                busy={busy}
                act={act}
              />
            ))}
          </section>
          <details>
            <summary>端末を追加</summary>
            <p>
              この端末のLAN・VPNアドレスと上に表示されたUDPポートを入力します。作成した接続情報を、参加側の「別端末から受信」へ入力してください。
            </p>
            <label>
              接続先アドレス
              <input
                placeholder="192.168.1.10:12345"
                value={inviteAddresses}
                onChange={(e) => setInviteAddresses(e.target.value)}
              />
            </label>
            <button
              disabled={busy || configured.paused || !inviteAddresses.trim()}
              onClick={() =>
                void act({
                  action: "invite",
                  addresses: addresses(inviteAddresses),
                })
              }
            >
              10分間有効な接続情報を作成
            </button>
            {connectionInfo && (
              <label>
                参加側へ渡す接続情報
                <textarea
                  readOnly
                  rows={4}
                  value={connectionInfo}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </label>
            )}
          </details>
          {view.pending
            .filter((p) => !p.approved)
            .map((pending) => (
              <section key={pending.invitationId} className="sync-review">
                <h3>参加承認待ち: {pending.member.name}</h3>
                <p>
                  参加側に表示された名前と鍵の識別情報が一致することを確認してください。
                </p>
                <code>{pending.fingerprint}</code>
                <p>
                  期限{" "}
                  {formatEventDateTime(
                    new Date(pending.expiresAt * 1000).toISOString(),
                  )}
                </p>
                <div className="application-modal-actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act({
                        action: "approve",
                        invitationId: pending.invitationId,
                        expectedPublicKey: pending.member.publicKey,
                      })
                    }
                  >
                    この端末を承認
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act({
                        action: "reject",
                        invitationId: pending.invitationId,
                      })
                    }
                  >
                    拒否
                  </button>
                </div>
              </section>
            ))}
          <details>
            <summary>待受アドレスを変更</summary>
            <label>
              IPアドレスとUDPポート
              <input value={bind} onChange={(e) => setBind(e.target.value)} />
            </label>
            <button
              disabled={busy}
              onClick={() => void act({ action: "listen", bind })}
            >
              変更して再接続
            </button>
          </details>
        </>
      )}
      <div className="application-modal-actions">
        <button disabled={busy} onClick={onRecovery}>
          保護された内容を復旧
        </button>
        <button disabled={busy} onClick={close}>
          閉じる
        </button>
      </div>
    </ModalDialog>
  );
}
function Device({
  device,
  frontier,
  local,
  paused,
  busy,
  act,
}: {
  device: SyncDevice;
  frontier: SyncView["local"]["frontier"];
  local: boolean;
  paused: boolean;
  busy: boolean;
  act: (action: SyncAction) => Promise<void>;
}) {
  const [address, setAddress] = useState(device.addresses.join("\n"));
  const [review, setReview] = useState(false);
  const member = device.member;
  return (
    <article>
      <h3>
        {member.name}
        {local ? "（この端末）" : ""}
      </h3>
      <p>
        {local
          ? member.revoked
            ? "登録解除済み"
            : "ローカル保存"
          : devicePhase(device, paused, frontier)}
      </p>
      {!local && (
        <p>
          未受信 {device.pendingReceivedCount}件 · 未反映{" "}
          {device.pendingAppliedCount}件 · {bytes(device.pendingBytes)}
          {device.checkpointRequired ? " ＋文書チェックポイント" : ""}
        </p>
      )}
      {!local && (
        <p>
          最終反映{" "}
          {device.lastAppliedAt
            ? formatEventDateTime(device.lastAppliedAt)
            : "未確認"}
        </p>
      )}
      {device.connection.error && (
        <p role="alert">{device.connection.error.message}</p>
      )}
      <details>
        <summary>端末の詳細</summary>
        <code>{fingerprint(member.publicKey)}</code>
        {!local && !member.revoked && (
          <>
            <label>
              接続情報を更新
              <textarea
                rows={2}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </label>
            <button
              disabled={busy || !address.trim()}
              onClick={() =>
                void act({
                  action: "addresses",
                  deviceId: member.origin.deviceId,
                  expectedPublicKey: member.publicKey,
                  addresses: addresses(address),
                })
              }
            >
              同じ鍵のアドレスを保存
            </button>
          </>
        )}
        {!member.revoked &&
          (review ? (
            <>
              <p>
                {member.name}
                の登録を解除すると、この鍵は再利用できません。渡したデータは相手の端末に残ります。
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  void act({
                    action: "revoke",
                    deviceId: member.origin.deviceId,
                    expectedPublicKey: member.publicKey,
                  })
                }
              >
                登録解除を確定
              </button>
              <button disabled={busy} onClick={() => setReview(false)}>
                戻る
              </button>
            </>
          ) : (
            <button disabled={busy} onClick={() => setReview(true)}>
              登録解除…
            </button>
          ))}
      </details>
    </article>
  );
}
