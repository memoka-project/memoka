import { BundleType, getBundleType, getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";

export const MEMOKA_RELEASES_URL =
  "https://github.com/memoka-project/memoka/releases/latest";

export function isStablePublicVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/u.test(version);
}

export type ApplicationUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "error"
  | "unsupported";

export interface ApplicationRelease {
  readonly currentVersion: string;
  readonly version: string;
  readonly date: string | null;
  readonly notes: string;
  readonly canSelfUpdate: boolean;
  readonly bundleType: string;
}

export interface ApplicationUpdateProgress {
  readonly phase: "preparing" | "downloading" | "installing";
  readonly downloadedBytes: number;
  readonly contentLength: number | null;
}

export interface ApplicationUpdatePort {
  check(): Promise<ApplicationRelease | null>;
  downloadAndInstall(
    onProgress: (progress: ApplicationUpdateProgress) => void,
  ): Promise<void>;
  relaunch(): Promise<void>;
  openReleasePage(): Promise<void>;
}

export class MemoryApplicationUpdatePort implements ApplicationUpdatePort {
  checkCount = 0;
  installCount = 0;
  relaunchCount = 0;
  releasePageCount = 0;

  constructor(
    private release: ApplicationRelease | null = null,
    private error: Error | null = null,
  ) {}

  async check(): Promise<ApplicationRelease | null> {
    this.checkCount += 1;
    if (this.error) throw this.error;
    return this.release ? { ...this.release } : null;
  }

  async downloadAndInstall(
    onProgress: (progress: ApplicationUpdateProgress) => void,
  ): Promise<void> {
    this.installCount += 1;
    onProgress({
      phase: "downloading",
      downloadedBytes: 4,
      contentLength: 8,
    });
    onProgress({
      phase: "installing",
      downloadedBytes: 8,
      contentLength: 8,
    });
  }

  async relaunch(): Promise<void> {
    this.relaunchCount += 1;
  }

  async openReleasePage(): Promise<void> {
    this.releasePageCount += 1;
  }

  setRelease(release: ApplicationRelease | null): void {
    this.release = release;
  }
}

class TauriApplicationUpdatePort implements ApplicationUpdatePort {
  private update: Update | null = null;
  private release: ApplicationRelease | null = null;

  async check(): Promise<ApplicationRelease | null> {
    await this.update?.close().catch(() => undefined);
    this.update = await check({ timeout: 15_000, allowDowngrades: false });
    if (!this.update) {
      this.release = null;
      return null;
    }
    if (!isStablePublicVersion(this.update.version)) {
      await this.update.close().catch(() => undefined);
      this.update = null;
      this.release = null;
      return null;
    }
    const bundleType = await getBundleType().catch(() => "unknown");
    const currentVersion = await getVersion().catch(
      () => this.update?.currentVersion ?? "unknown",
    );
    this.release = {
      currentVersion,
      version: this.update.version,
      date: this.update.date ?? null,
      notes: this.update.body?.trim() ?? "",
      canSelfUpdate:
        bundleType === BundleType.Nsis || bundleType === BundleType.AppImage,
      bundleType,
    };
    return { ...this.release };
  }

  async downloadAndInstall(
    onProgress: (progress: ApplicationUpdateProgress) => void,
  ): Promise<void> {
    if (!this.update || !this.release) {
      throw new Error("更新情報を確認してから実行してください");
    }
    if (!this.release.canSelfUpdate) {
      throw new Error(
        `${this.release.bundleType} buildはアプリ内更新に対応していません`,
      );
    }
    let downloadedBytes = 0;
    let contentLength: number | null = null;
    await this.update.downloadAndInstall((event: DownloadEvent) => {
      if (event.event === "Started") {
        contentLength = event.data.contentLength ?? null;
        onProgress({ phase: "downloading", downloadedBytes, contentLength });
      } else if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
        onProgress({ phase: "downloading", downloadedBytes, contentLength });
      } else {
        onProgress({ phase: "installing", downloadedBytes, contentLength });
      }
    });
  }

  relaunch(): Promise<void> {
    return relaunch();
  }

  openReleasePage(): Promise<void> {
    return openUrl(MEMOKA_RELEASES_URL);
  }
}

export function createDefaultApplicationUpdatePort(): ApplicationUpdatePort {
  const tauri =
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>);
  return tauri
    ? new TauriApplicationUpdatePort()
    : new MemoryApplicationUpdatePort();
}
