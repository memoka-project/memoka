import { useRef, type ReactNode } from "react";
import type { SplitNode } from "../core/application-state";
import { clampSplitRatio } from "../core/window-layout";
import { PaneResizeHandle } from "./PaneResizeHandle";

interface Props {
  node: SplitNode;
  renderWindow: (windowId: string) => ReactNode;
  onResize: (splitId: string, ratio: number) => Promise<unknown>;
  onError: (error: unknown) => void;
}

export function EditorSplitLayout(props: Props): ReactNode {
  const { node, renderWindow } = props;
  return node.type === "leaf" ? (
    renderWindow(node.windowId)
  ) : (
    <SplitPane key={node.id} {...props} node={node} />
  );
}

function SplitPane({
  node,
  renderWindow,
  onResize,
  onError,
}: Props & { node: Extract<SplitNode, { type: "split" }> }) {
  const root = useRef<HTMLDivElement>(null);
  const vertical = node.direction === "vertical";
  const property = vertical ? "gridTemplateColumns" : "gridTemplateRows";
  const tracks = (ratio: number) =>
    `minmax(0, ${ratio}fr) minmax(0, ${1 - ratio}fr)`;
  return (
    <div
      ref={root}
      className={`editor-split editor-split--${node.direction}`}
      data-split-id={node.id}
      data-split-direction={node.direction}
      style={{ [property]: tracks(node.ratio) }}
    >
      <EditorSplitLayout
        node={node.first}
        renderWindow={renderWindow}
        onResize={onResize}
        onError={onError}
      />
      <EditorSplitLayout
        node={node.second}
        renderWindow={renderWindow}
        onResize={onResize}
        onError={onError}
      />
      <PaneResizeHandle
        orientation={vertical ? "vertical" : "horizontal"}
        label={vertical ? "Windowの横幅を調整" : "Windowの高さを調整"}
        style={
          vertical
            ? { left: `${node.ratio * 100}%` }
            : { top: `${node.ratio * 100}%` }
        }
        onError={onError}
        onStart={() => {
          const element = root.current;
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          const pixels = vertical ? element.clientWidth : element.clientHeight;
          const visualPixels = vertical ? rect.width : rect.height;
          if (pixels <= 1 || visualPixels <= 0) return null;
          const handle = element.lastElementChild as HTMLElement;
          const handleProperty = vertical ? "left" : "top";
          const oldPosition = handle.style[handleProperty];
          const oldTracks = element.style[property];
          return {
            preview(delta) {
              const ratio = clampSplitRatio(
                node,
                node.ratio + delta / visualPixels,
                pixels,
              );
              element.style[property] = tracks(ratio);
              handle.style[handleProperty] = `${ratio * 100}%`;
              return ratio;
            },
            commit: (ratio) => onResize(node.id, ratio),
            cancel() {
              element.style[property] = oldTracks;
              handle.style[handleProperty] = oldPosition;
            },
          };
        }}
      />
    </div>
  );
}
