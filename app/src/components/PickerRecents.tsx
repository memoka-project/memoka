import { useEffect, useState, type ReactNode } from "react";
import {
  createDefaultPickerRecentsPort,
  type PickerRecentsPort,
} from "../platform/picker-recents";
import {
  PickerRecentsContext,
  PickerRecentsStore,
} from "./picker-recents-state";

export function PickerRecentsProvider({
  children,
  port,
}: {
  children: ReactNode;
  port?: PickerRecentsPort;
}) {
  const [defaultPort] = useState(createDefaultPickerRecentsPort);
  const [store] = useState(() => new PickerRecentsStore(port ?? defaultPort));
  useEffect(() => {
    void store.load();
  }, [store]);
  return (
    <PickerRecentsContext.Provider value={store}>
      {children}
    </PickerRecentsContext.Provider>
  );
}
