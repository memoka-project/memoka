import { CompactDictionary, Migemo } from "jsmigemo";
import dictionaryUrl from "../assets/migemo-compact-dict.bin?url";

let pending: Promise<Migemo> | null = null;

export function loadNoteMigemo(): Promise<Migemo> {
  pending ??= fetch(dictionaryUrl)
    .then((response) => {
      if (!response.ok)
        throw new Error(`Migemo辞書を読み込めません (${response.status})`);
      return response.arrayBuffer();
    })
    .then((buffer) => {
      const migemo = new Migemo();
      migemo.setDict(new CompactDictionary(buffer));
      return migemo;
    })
    .catch((error: unknown) => {
      pending = null;
      throw error;
    });
  return pending;
}
