import { afterEach, beforeEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { DEFAULT_APPLICATION_THEME_ID } from "../app/src/core/application-theme";
import { applyApplicationTheme } from "../app/src/platform/application-theme";
import { resetJapaneseSegmentationConfiguration } from "../app/src/core/japanese-segmentation";

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class IntersectionObserverStub implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0];
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

Object.defineProperty(globalThis, "ResizeObserver", {
  value: ResizeObserverStub,
  writable: true,
});
Object.defineProperty(globalThis, "IntersectionObserver", {
  value: IntersectionObserverStub,
  writable: true,
});
Object.defineProperty(document, "elementFromPoint", {
  value: () => document.body,
  writable: true,
});
Object.defineProperty(window, "scrollBy", {
  value: () => {},
  writable: true,
});
Object.defineProperties(Range.prototype, {
  getClientRects: {
    value: () => [],
    writable: true,
    configurable: true,
  },
  getBoundingClientRect: {
    value: () => new DOMRect(),
    writable: true,
    configurable: true,
  },
});

beforeEach(() => {
  applyApplicationTheme(document.documentElement, DEFAULT_APPLICATION_THEME_ID);
  resetJapaneseSegmentationConfiguration();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});
