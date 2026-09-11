import { useCallback, useEffect, useRef, useState } from "react";
import { ModalDialog } from "./ModalDialog";
import { formatEventDateTime } from "../core/display-datetime";
import { writeClipboardText } from "../platform/clipboard";
import {
  devicePhase,
  nativeSynchronization,
  synchronizationError,
  type SyncAction,
  type SyncAddressCandidate,
  type SyncDevice,
  type SyncView,
  type SynchronizationPort,
} from "../platform/synchronization";

export interface SyncSettingsSession {
  restoreFocus: () => void;
}

/** Invitation secrets live only in memory for the open Workspace session. */
export interface SyncInvitation {
  workspaceId: string;
  invitationId: string;
  expiresAt: number;
  code: string;
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
const nowSeconds = () => Math.floor(Date.now() / 1000);

export function SyncSettingsDialog({
  workspaceId,
  session,
  onClose,
  onRecovery,
  onReceive,
  invitation,
  onInvitation,
  prepare,
  port = nativeSynchronization,
}: {
  workspaceId: string;
  session: SyncSettingsSession;
  onClose: () => void;
  onRecovery: () => void;
  onReceive: () => void;
  invitation: SyncInvitation | null;
  onInvitation: (invitation: SyncInvitation | null) => void;
  prepare?: () => Promise<void>;
  port?: SynchronizationPort;
}) {
  const [view, setView] = useState<SyncView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [bind, setBind] = useState("0.0.0.0:0");
  const [addStep, setAddStep] = useState<1 | 2 | 3 | 4 | null>(null);
  const [candidates, setCandidates] = useState<SyncAddressCandidate[] | null>(
    null,
  );
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [refreshingCandidates, setRefreshingCandidates] = useState(false);
  const [selectedAddress, setSelectedAddress] = useState("");
  const [manualAddress, setManualAddress] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const active = useRef(true);
  const saving = useRef(false);
  const invitationClaimed = useRef(false);

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

  const refreshCandidates = useCallback(async () => {
    setRefreshingCandidates(true);
    setCandidateError(null);
    try {
      const next = await port.addressCandidates(workspaceId);
      if (active.current) {
        setCandidates(next);
        setSelectedAddress("");
      }
    } catch (cause) {
      if (active.current) setCandidateError(synchronizationError(cause));
    } finally {
      if (active.current) setRefreshingCandidates(false);
    }
  }, [port, workspaceId]);

  const openInviteStep = () => {
    setAddStep(2);
    void refreshCandidates();
  };

  const activeInvitation =
    invitation &&
    invitation.workspaceId === workspaceId &&
    invitation.expiresAt > nowSeconds()
      ? invitation
      : null;

  // Expiry, Workspace switches and a completed approval all clear the secret.
  useEffect(() => {
    if (!invitation) return;
    if (
      invitation.workspaceId !== workspaceId ||
      invitation.expiresAt <= nowSeconds()
    ) {
      onInvitation(null);
      return;
    }
    // Browser timers clamp beyond ~24.8 days; a far-future timestamp would
    // otherwise fire immediately and drop a still-valid invitation.
    const delay = Math.min(
      invitation.expiresAt * 1000 - Date.now() + 100,
      2_000_000_000,
    );
    const timer = setTimeout(() => onInvitation(null), delay);
    return () => clearTimeout(timer);
  }, [invitation, onInvitation, workspaceId]);

  useEffect(() => {
    if (!view || !invitation) return;
    const pending = view.pending.find(
      (candidate) => candidate.invitationId === invitation.invitationId,
    );
    if (pending?.approved) {
      invitationClaimed.current = false;
      onInvitation(null);
      return;
    }
    if (pending) {
      invitationClaimed.current = true;
    } else if (invitationClaimed.current) {
      invitationClaimed.current = false;
      onInvitation(null);
    }
  }, [invitation, onInvitation, view]);

  const act = async (action: SyncAction): Promise<boolean> => {
    if (saving.current) return false;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      if (action.action === "enable") await prepare?.();
      const result = await port.action(workspaceId, action);
      if (active.current) {
        if (
          result.connectionInfo &&
          result.invitationId !== undefined &&
          result.expiresAt !== undefined
        ) {
          invitationClaimed.current = false;
          setCopyState("idle");
          onInvitation({
            workspaceId,
            invitationId: result.invitationId,
            expiresAt: result.expiresAt,
            code: result.connectionInfo,
          });
        }
        setView(await port.status());
      }
      return true;
    } catch (cause) {
      if (active.current) setError(synchronizationError(cause));
      return false;
    } finally {
      saving.current = false;
      if (active.current) setBusy(false);
    }
  };

  const copyInvitation = async () => {
    if (!activeInvitation) return;
    setCopyState("idle");
    const copied = await writeClipboardText(activeInvitation.code);
    if (active.current) setCopyState(copied ? "copied" : "failed");
  };

  const close = () => {
    if (!saving.current) {
      onClose();
      queueMicrotask(session.restoreFocus);
    }
  };
  const configured = view?.config;
  const invitationAddress = selectedAddress || manualAddress.trim();

  const invitationPanel = (
    <>
      {activeInvitation ? (
        <div className="sync-invitation">
          <label>
            招待コード
            <textarea
              readOnly
              rows={4}
              value={activeInvitation.code}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <div className="application-modal-actions">
            <button type="button" onClick={() => void copyInvitation()}>
              招待コードをコピー
            </button>
          </div>
          <p role="status">
            {copyState === "copied"
              ? "コピーしました"
              : copyState === "failed"
                ? "コピーできませんでした。コードを選択してCtrl-Cでコピーしてください。"
                : `有効期限 ${formatEventDateTime(
                    new Date(activeInvitation.expiresAt * 1000).toISOString(),
                  )}`}
          </p>
        </div>
      ) : (
        <p>有効な招待コードがありません。新しいコードを作成してください。</p>
      )}
    </>
  );

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
      ) : addStep !== null ? (
        <section aria-label="端末を追加" data-modal-scroll>
          <h3>端末を追加</h3>
          <ol className="sync-add-steps">
            <li data-current={addStep === 1}>元端末で準備</li>
            <li data-current={addStep === 2}>元端末で招待</li>
            <li data-current={addStep === 3}>新しい端末で受信</li>
            <li data-current={addStep === 4}>元端末で承認</li>
          </ol>
          {addStep === 1 && (
            <section>
              <h4>元端末で準備</h4>
              {configured ? (
                <>
                  <p>この端末は準備済みです。待受は既定値を使います。</p>
                  <div className="application-modal-actions">
                    <button
                      disabled={busy}
                      onClick={() => setAddStep(null)}
                      type="button"
                    >
                      通常の画面に戻る
                    </button>
                    <button
                      disabled={busy}
                      onClick={openInviteStep}
                      type="button"
                    >
                      次へ
                    </button>
                  </div>
                </>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act({ action: "enable", name, bind }).then(
                      (succeeded) => {
                        if (succeeded && active.current) openInviteStep();
                      },
                    );
                  }}
                >
                  <label>
                    この端末の名前
                    <input
                      required
                      maxLength={256}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  <p>
                    待受設定は既定値（0.0.0.0:0で空きUDPポート）を使います。変更は通常画面の詳細から行います。
                  </p>
                  <button disabled={busy || !name.trim()} type="submit">
                    同期を有効にして次へ
                  </button>
                </form>
              )}
            </section>
          )}
          {addStep === 2 && (
            <section>
              <h4>元端末で招待</h4>
              <fieldset>
                <legend>この端末のLAN・VPNアドレス</legend>
                {candidateError && <p role="alert">{candidateError}</p>}
                {refreshingCandidates && <p role="status">候補を取得中…</p>}
                {candidates?.length
                  ? candidates.map((candidate) => (
                      <label key={candidate.address} className="sync-address">
                        <input
                          checked={selectedAddress === candidate.address}
                          name="sync-address-candidate"
                          type="radio"
                          value={candidate.address}
                          onChange={() => setSelectedAddress(candidate.address)}
                        />
                        {candidate.address}（{candidate.interfaceName}）
                      </label>
                    ))
                  : !refreshingCandidates && (
                      <p>
                        候補が見つかりませんでした。下の欄へ手入力できます。
                      </p>
                    )}
                <button
                  disabled={busy || refreshingCandidates}
                  onClick={() => void refreshCandidates()}
                  type="button"
                >
                  候補を更新
                </button>
              </fieldset>
              <label>
                または手入力
                <input
                  placeholder="192.168.1.10:12345"
                  value={manualAddress}
                  onChange={(event) => setManualAddress(event.target.value)}
                />
              </label>
              <button
                disabled={
                  busy || !configured || configured.paused || !invitationAddress
                }
                onClick={() =>
                  void act({
                    action: "invite",
                    addresses: [invitationAddress],
                  })
                }
                type="button"
              >
                招待コードを作成
              </button>
              {invitationPanel}
              <div className="application-modal-actions">
                <button
                  disabled={busy}
                  onClick={() => setAddStep(1)}
                  type="button"
                >
                  戻る
                </button>
                <button
                  disabled={busy || !activeInvitation}
                  onClick={() => setAddStep(3)}
                  type="button"
                >
                  次へ
                </button>
              </div>
            </section>
          )}
          {addStep === 3 && (
            <section>
              <h4>新しい端末で受信</h4>
              <p>
                新しい端末で<code>:new-workspace</code>
                を開き、「別端末から受信」を選びます。招待コード・端末名・新しい空の保存先を指定します。
              </p>
              {invitationPanel}
              <p>
                受信の初回と中断後の再開は、新しい端末で別の操作として案内されます。
              </p>
              <div className="application-modal-actions">
                <button
                  disabled={busy}
                  onClick={() => setAddStep(2)}
                  type="button"
                >
                  戻る
                </button>
                <button
                  disabled={busy}
                  onClick={() => setAddStep(4)}
                  type="button"
                >
                  次へ
                </button>
              </div>
            </section>
          )}
          {addStep === 4 && (
            <section>
              <h4>元端末で承認</h4>
              <p>
                新しい端末に表示された名前と鍵の識別情報が一致することを確認してから承認してください。承認後は新しい端末で受信完了を待ち、Workspaceを開きます。
              </p>
              {view.pending.filter((pending) => !pending.approved).length ? (
                view.pending
                  .filter((pending) => !pending.approved)
                  .map((pending) => (
                    <section key={pending.invitationId} className="sync-review">
                      <h5>参加承認待ち: {pending.member.name}</h5>
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
                          type="button"
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
                          type="button"
                        >
                          拒否
                        </button>
                      </div>
                    </section>
                  ))
              ) : (
                <p>この端末の承認を待っている要求はありません。</p>
              )}
              <div className="application-modal-actions">
                <button
                  disabled={busy}
                  onClick={() => setAddStep(3)}
                  type="button"
                >
                  戻る
                </button>
                <button
                  disabled={busy}
                  onClick={() => setAddStep(null)}
                  type="button"
                >
                  通常の画面に戻る
                </button>
              </div>
            </section>
          )}
        </section>
      ) : !configured ? (
        <section aria-label="このWorkspaceの同期状態">
          <p>
            このWorkspaceでは端末間同期が無効です。端末を追加すると準備から始まります。
          </p>
          <div className="application-modal-actions">
            <button disabled={busy} onClick={() => setAddStep(1)} type="button">
              端末を追加
            </button>
            <button disabled={busy} onClick={onReceive} type="button">
              別端末から受信
            </button>
          </div>
        </section>
      ) : (
        <>
          {view.pending
            .filter((pending) => !pending.approved)
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
                    type="button"
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
                    type="button"
                  >
                    拒否
                  </button>
                </div>
              </section>
            ))}
          <div className="application-modal-actions">
            <button
              disabled={busy}
              onClick={() =>
                void act({ action: "pause", paused: !configured.paused })
              }
              type="button"
            >
              {configured.paused ? "再開" : "一時停止"}
            </button>
            <button
              disabled={busy || configured.paused}
              onClick={() => void act({ action: "reconnect" })}
              type="button"
            >
              今すぐ同期
            </button>
            <button disabled={busy} onClick={openInviteStep} type="button">
              端末を追加
            </button>
            <button disabled={busy} onClick={onReceive} type="button">
              別端末から受信
            </button>
          </div>
          <p role="status">
            {configured.paused
              ? "一時停止中"
              : view.listening
                ? `待受中 ${view.listening}`
                : "接続準備中"}
          </p>
          <p>
            この端末で反映待ち {view.local.pendingApplyCount}件 (
            {bytes(view.local.pendingApplyBytes)}) · 相手への送信待ち{" "}
            {view.local.pendingSignatureCount}件 · 添付取得待ち{" "}
            {view.local.pendingAttachmentCount}件 (
            {bytes(view.local.pendingAttachmentBytes)})
          </p>
          <p>
            最終反映{" "}
            {view.local.lastAppliedAt
              ? formatEventDateTime(view.local.lastAppliedAt)
              : "未確認"}
          </p>
          {view.local.quarantinedCount > 0 && (
            <p role="alert">
              検証に失敗したデータ {view.local.quarantinedCount}
              件を隔離しました。
            </p>
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
            <summary>同期の詳細</summary>
            {!!view.failures.length && (
              <>
                <h4>隔離したデータの失敗理由（先頭50件）</h4>
                <ul>
                  {view.failures.map(([hash, reason]) => (
                    <li key={`${hash}:${reason}`}>
                      <p>{reason}</p>
                      <code>{hash}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {!!view.attachmentTransfers.length && (
              <>
                <h4>添付取得の詳細（先頭64件）</h4>
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
                          type="button"
                        >
                          この添付を再取得
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {!view.failures.length && !view.attachmentTransfers.length && (
              <p>隔離データと取得中の添付はありません。</p>
            )}
          </details>
          <details>
            <summary>待受設定を変更</summary>
            <label>
              IPアドレスとUDPポート
              <input
                value={bind}
                onChange={(event) => setBind(event.target.value)}
              />
            </label>
            <button
              disabled={busy}
              onClick={() => void act({ action: "listen", bind })}
              type="button"
            >
              変更して再接続
            </button>
          </details>
        </>
      )}
      <div className="application-modal-actions">
        <button disabled={busy} onClick={onRecovery} type="button">
          保護された内容を復旧
        </button>
        <button disabled={busy} onClick={close} type="button">
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
  act: (action: SyncAction) => Promise<boolean>;
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
          相手で未反映（未受信分を含む） {device.pendingAppliedCount}件 ·{" "}
          {bytes(device.pendingBytes)}
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
              接続先アドレスを更新
              <textarea
                rows={2}
                value={address}
                onChange={(event) => setAddress(event.target.value)}
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
              type="button"
            >
              同じ鍵の接続先アドレスを保存
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
                type="button"
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
