import { createContext, useContext, useEffect } from "react";

export const BackupNoticeContext = createContext<
  (id: string, message: string | null) => void
>(() => {});

export function useBackupNotice(id: string, message: string | null) {
  const report = useContext(BackupNoticeContext);
  useEffect(() => {
    report(id, message);
    return () => report(id, null);
  }, [id, message, report]);
}
