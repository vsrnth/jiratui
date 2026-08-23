export type LayoutMode = "warning" | "one-pane" | "two-pane" | "full-shell";
export type TerminalSize = { width: number; height: number };
export type Pane = { x: number; width: number };
export type Layout = {
  mode: LayoutMode;
  size: TerminalSize;
  nav?: Pane;
  list: Pane;
  detail?: Pane;
  event?: Pane;
  warning: string | null;
};

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

export function layoutFor(size: TerminalSize): Layout {
  const width = Math.max(1, Math.floor(size.width));
  const height = Math.max(1, Math.floor(size.height));
  if (width < 60 || height < 20) {
    return {
      mode: "warning",
      size: { width, height },
      list: { x: 0, width },
      warning: `Terminal is too small (${width}x${height}; minimum 60x20). Resize, then press Ctrl-L to retry.`,
    };
  }
  if (width < 120) {
    return { mode: "one-pane", size: { width, height }, list: { x: 0, width }, warning: null };
  }
  if (width < 160) {
    const listWidth = clamp(Math.floor(width * 0.36), 35, 44);
    return {
      mode: "two-pane",
      size: { width, height },
      list: { x: 0, width: listWidth },
      detail: { x: listWidth + 1, width: width - listWidth - 1 },
      warning: null,
    };
  }
  const navWidth = 18;
  const eventWidth = 24;
  const listWidth = clamp(Math.floor(width * 0.25), 35, 44);
  return {
    mode: "full-shell",
    size: { width, height },
    nav: { x: 0, width: navWidth },
    list: { x: navWidth + 1, width: listWidth },
    detail: { x: navWidth + listWidth + 2, width: width - navWidth - listWidth - eventWidth - 3 },
    event: { x: width - eventWidth, width: eventWidth },
    warning: null,
  };
}

export function clampScroll(scroll: number, contentHeight: number, viewportHeight: number): number {
  return clamp(Math.floor(scroll), 0, Math.max(0, Math.floor(contentHeight) - Math.floor(viewportHeight)));
}

export function clampIndex(index: number, length: number): number {
  return clamp(Math.floor(index), 0, Math.max(0, length - 1));
}
