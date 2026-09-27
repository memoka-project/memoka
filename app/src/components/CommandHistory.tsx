import { useEffect, useState, type ReactNode } from "react";
import {
  createDefaultCommandHistoryPort,
  type CommandHistoryPort,
} from "../platform/command-history";
import {
  CommandHistoryContext,
  CommandHistoryStore,
} from "./command-history-state";

export function CommandHistoryProvider({
  children,
  port,
}: {
  children: ReactNode;
  port?: CommandHistoryPort;
}) {
  const [defaultPort] = useState(createDefaultCommandHistoryPort);
  const [store] = useState(() => new CommandHistoryStore(port ?? defaultPort));
  useEffect(() => {
    void store.load();
  }, [store]);
  return (
    <CommandHistoryContext.Provider value={store}>
      {children}
    </CommandHistoryContext.Provider>
  );
}
