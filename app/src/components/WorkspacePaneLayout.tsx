import { useRef, type CSSProperties, type ReactNode } from "react";
import type {
  LeftSidebarState,
  RightSidebarState,
  SidebarSide,
} from "../core/application-state";
import {
  MIN_SIDEBAR_WIDTH_PX,
  MIN_WINDOW_WIDTH_PX,
} from "../core/window-layout";
import { PaneResizeHandle } from "./PaneResizeHandle";

export function WorkspacePaneLayout({
  left,
  right,
  children,
  onResize,
  onError,
}: {
  left: LeftSidebarState;
  right: RightSidebarState;
  children: ReactNode;
  onResize: (side: SidebarSide, widthPx: number) => Promise<unknown>;
  onError: (error: unknown) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const count = Number(left.visible) + Number(right.visible);
  const width = (side: SidebarSide) =>
    `min(var(--workspace-${side}-width), max(0px, calc((100% - ${MIN_WINDOW_WIDTH_PX}px) / ${Math.max(1, count)})))`;
  const columns = [
    left.visible ? `minmax(0, ${width("left")})` : null,
    "minmax(0, 1fr)",
    right.visible ? `minmax(0, ${width("right")})` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      ref={root}
      className="application-workspace"
      style={
        {
          gridTemplateColumns: columns,
          "--workspace-left-width": `${left.widthPx}px`,
          "--workspace-right-width": `${right.widthPx}px`,
        } as CSSProperties
      }
    >
      {children}
      {(["left", "right"] as const)
        .filter((side) => (side === "left" ? left : right).visible)
        .map((side) => (
          <PaneResizeHandle
            key={side}
            orientation="vertical"
            label={side === "left" ? "Treeの横幅を調整" : "Outlineの横幅を調整"}
            style={{
              [side]: width(side),
              transform:
                side === "right" ? "translateX(50%)" : "translateX(-50%)",
            }}
            onError={onError}
            onStart={() => {
              const element = root.current;
              if (!element) return null;
              const visualWidth = element.getBoundingClientRect().width;
              const layoutWidth = element.clientWidth;
              if (layoutWidth <= 0 || visualWidth <= 0) return null;
              const maximum = Math.max(
                1,
                (layoutWidth - MIN_WINDOW_WIDTH_PX) / count,
              );
              const initial = Math.min(
                (side === "left" ? left : right).widthPx,
                maximum,
              );
              const property = `--workspace-${side}-width`;
              const original = element.style.getPropertyValue(property);
              return {
                preview(delta) {
                  const value = Math.max(
                    Math.min(MIN_SIDEBAR_WIDTH_PX, maximum),
                    Math.min(
                      maximum,
                      initial +
                        ((side === "left" ? delta : -delta) * layoutWidth) /
                          visualWidth,
                    ),
                  );
                  element.style.setProperty(property, `${value}px`);
                  return value;
                },
                commit: (value) => onResize(side, value),
                cancel: () => element.style.setProperty(property, original),
              };
            }}
          />
        ))}
    </div>
  );
}
