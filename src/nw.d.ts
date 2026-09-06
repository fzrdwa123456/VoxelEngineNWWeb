// NW.js renderer-side globals (available directly in the DOM context, no import needed)
interface NWWindow {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  show(): void;
  focus(): void;
  close(): void;
  on(event: "focus" | "blur", callback: () => void): void;
}
declare const nw: {
  Window: { get(): NWWindow };
};

// Node globals (enabled by default in the NW.js renderer)
declare const process: {
  versions: Record<string, string>;
  execPath: string;
};
declare const require: (id: string) => any;