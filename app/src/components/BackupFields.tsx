import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BackupRetention } from "../core/history";
export function PasswordForm({
  busy,
  newRepository = false,
  onSubmit,
  onDone,
  onCancel,
  children,
}: {
  busy: boolean;
  newRepository?: boolean;
  onSubmit: (password: string) => Promise<boolean>;
  onDone: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const passwordInput = useRef<HTMLInputElement>(null);
  const confirmationInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const password = passwordInput.current;
    const confirmation = confirmationInput.current;
    return () => {
      if (password) password.value = "";
      if (confirmation) confirmation.value = "";
    };
  }, []);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const password = passwordInput.current?.value ?? "";
        const confirmation = confirmationInput.current?.value ?? "";
        if (!password || password !== confirmation) {
          setError("空でないパスワードを同じ内容で2回入力してください");
          return;
        }
        setError("");
        if (passwordInput.current) passwordInput.current.value = "";
        if (confirmationInput.current) confirmationInput.current.value = "";
        void onSubmit(password).then((saved) => {
          if (saved) {
            onDone();
          }
        });
      }}
    >
      <fieldset disabled={busy}>
        {children}
        <label>
          パスワード
          <input
            type="password"
            autoComplete={newRepository ? "new-password" : "current-password"}
            required
            ref={passwordInput}
          />
        </label>
        <label>
          パスワードを再入力
          <input
            type="password"
            autoComplete={newRepository ? "new-password" : "current-password"}
            required
            ref={confirmationInput}
          />
        </label>
        <p>
          {newRepository
            ? "OS資格情報ストアへ保存します。復旧に備えパスワードを別途保管してください。"
            : "この保存先の既存パスワードを再登録します。バックアップのパスワードを変更する操作ではありません。"}
        </p>
        {error && <p role="alert">{error}</p>}
        <button type="submit">
          {newRepository ? "保存先を登録" : "パスワードを再登録"}
        </button>{" "}
        <button type="button" onClick={onCancel}>
          取り消す
        </button>
      </fieldset>
    </form>
  );
}
export function RetentionFields({
  value,
  previous,
  onChange,
}: {
  value: BackupRetention;
  previous?: BackupRetention;
  onChange: (value: BackupRetention) => void;
}) {
  return (
    <>
      <div className="backup-retention-fields">
        {(
          [
            ["last", "直近"],
            ["daily", "日次"],
            ["monthly", "月次"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}（世代）
            <input
              type="number"
              min={key === "last" ? 1 : 0}
              max={4294967295}
              step={1}
              required
              value={value[key]}
              onChange={(event) =>
                onChange({ ...value, [key]: Number(event.target.value) })
              }
            />
          </label>
        ))}
      </div>
      <p className="backup-setting-hint">
        いずれかの条件に該当する世代を保持します。日次・月次の0は、その条件を無効にします。
      </p>
      {previous &&
        (["last", "daily", "monthly"] as const).some(
          (key) => value[key] < previous[key],
        ) && (
          <p className="backup-retention-warning">
            保持数を減らすと、次回の整理で古い世代が削除される場合があります。
          </p>
        )}
    </>
  );
}
