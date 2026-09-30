import {
  decodePasteBytes,
  MouseButton,
  parseColor,
  Renderable,
  type ColorInput,
  type KeyEvent,
  type MouseEvent,
  type OptimizedBuffer,
  type PasteEvent,
  type RenderableOptions,
  type RenderContext,
  type RGBA,
  type SyntaxStyle,
} from "@opentui/core";
import { EditorController } from "../editing/controller.ts";
import { isCollapsed, range, samePos, textOfBlock } from "../model/doc.ts";
import { wordAround } from "../model/text.ts";
import type { Pos } from "../model/types.ts";
import { drawLayout } from "./draw.ts";
import { intentOf, perform, type Intent, type Motion } from "./keys.ts";
import { forgetWaiting, imageAt, protocolOf } from "./images.ts";
import {
  cellOf,
  layoutDocument,
  posAt,
  type CellSize,
  type Glyph,
  type Layout,
  type LayoutOptions,
} from "./layout.ts";
import { lastPos, lineEdge, moveHorizontal, moveVertical } from "./motion.ts";
import { Highlighter } from "./highlight.ts";
import { Theme } from "./theme.ts";

export type MarkdownEditorOptions = RenderableOptions<MarkdownEditorRenderable> & {
  syntaxStyle?: SyntaxStyle;
  /** The document, as Markdown. Setting a value other than the last one reported reloads it. */
  value?: string;
  /** Shown, faint, while the document is empty. */
  placeholder?: string;
  /** The background of selected text; the code panel's color by default. */
  selectionColor?: ColorInput;
  /** Every edit, as Markdown. Not called for a value set from outside. */
  onChange?: (markdown: string) => void;
  /** A link clicked: a plain click while not focused, Ctrl or Alt+click while editing. */
  onLink?: (url: string) => void;
  /** The selection copied or cut, as Markdown: the application puts it on its clipboard. */
  onCopy?: (markdown: string) => void;
  /**
   * A click while not focused. Without it the editor takes the focus itself; with it the
   * application decides (and sets `focused`).
   */
  onFocusRequest?: () => void;
  /** The terminal's background (OSC 11): heading bands fade into it. */
  terminalBackground?: RGBA;
  /**
   * The widest the page runs, in cells, as on a printed page: narrower than the editor, it
   * is centered in it, and heading bands and code panels reach into its left margin so
   * that all text starts at one column. The editor's width by default.
   */
  readingWidth?: number;
};

const SCROLL_LINES = 3;
// How far bands and code panels reach into the margin, when there is one.
const HANG = 2;
// Narrower than this, an editor gives its margin back to the text.
const MIN_MARGINED = 40;
// Terminals that draw octants themselves (Unicode 16), whatever the font: bands get their
// rounded ends there, square ones elsewhere.
const OCTANTS = /ghostty|kitty|wezterm/i;
const MULTI_CLICK_MS = 400;
const DOUBLE = 2;
const TRIPLE = 3;

/**
 * The editor as an OpenTUI renderable: it draws its document, takes keys and pastes while
 * focused, and the mouse always. The editing itself is its `controller`'s.
 */
export class MarkdownEditorRenderable extends Renderable {
  readonly controller = new EditorController();
  private theme: Theme | null = null;
  private syntax: SyntaxStyle | null = null;
  private selectionBg: RGBA | undefined;
  private laid: { layout: Layout; doc: unknown; key: string; theme: Theme } | null = null;
  /** The task whose box is under the pointer. */
  private hoveredTask: number | null = null;
  /** Bumped when an image arrives: the blocks holding images are laid out again. */
  private images = 0;
  private readonly imageReady = () => {
    this.images++;
    this.laid = null;
    this.requestRender();
  };
  private readonly capabilitiesChanged = () => {
    this.laid = null;
    this.requestRender();
  };
  private scroll = 0;
  /** Where the cursor was at the last change. */
  private head: Pos = { block: 0, offset: 0 };
  /** The column vertical moves keep, from the first of them. */
  private goal: number | null = null;
  private clicks = { count: 0, at: 0, x: -1, y: -1 };
  private dragging = false;
  private _placeholder = "";
  private background: RGBA | undefined;
  private reading = Infinity;
  private _onChange: ((markdown: string) => void) | undefined;
  private _onLink: ((url: string) => void) | undefined;
  private _onCopy: ((markdown: string) => void) | undefined;
  private _onFocusRequest: (() => void) | undefined;
  private readonly highlighter = new Highlighter(() => {
    this.laid = null;
    this.requestRender();
  });

  constructor(ctx: RenderContext, options: MarkdownEditorOptions) {
    super(ctx, { ...options, buffered: false });
    this.focusable = true;
    this.controller.subscribe((change) => {
      // Only a cursor that moved is brought into view: a task ticked with the mouse, or
      // typing settled when the focus leaves, keeps the page where the reader has it.
      const { head } = this.controller.state.selection;
      if (!samePos(head, this.head)) this.keepCursorInView();
      this.head = head;
      this.requestRender();
      if (change.edited) this._onChange?.(change.markdown);
    });
    if (options.syntaxStyle) this.syntaxStyle = options.syntaxStyle;
    if (options.selectionColor !== undefined) this.selectionColor = options.selectionColor;
    if (options.value !== undefined) this.value = options.value;
    this._placeholder = options.placeholder ?? "";
    this.background = options.terminalBackground;
    this.reading = options.readingWidth ?? Infinity;
    this._onChange = options.onChange;
    this._onLink = options.onLink;
    this._onCopy = options.onCopy;
    this._onFocusRequest = options.onFocusRequest;
    this.listen("on");
  }

  /**
   * The terminal's capabilities (images, octants) arrive after the first frame. The context
   * is an EventEmitter typed only with Node's types, which this package does not load:
   * reached through Reflect.
   */
  private listen(method: "on" | "off") {
    const handler: unknown = Reflect.get(this.ctx, method);
    if (typeof handler === "function")
      Reflect.apply(handler, this.ctx, ["capabilities", this.capabilitiesChanged]);
  }
  protected override destroySelf(): void {
    this.listen("off");
    forgetWaiting(this.imageReady);
    super.destroySelf();
  }

  set value(markdown: string) {
    if (markdown === this.controller.markdown) return;
    this.controller.load(markdown);
    // Another text: the view goes to its cursor, even one that did not move.
    this.keepCursorInView();
  }
  get value(): string {
    return this.controller.markdown;
  }
  set syntaxStyle(style: SyntaxStyle) {
    this.syntax = style;
    this.theme = null;
    this.requestRender();
  }
  set selectionColor(color: ColorInput | undefined) {
    this.selectionBg = color === undefined ? undefined : parseColor(color);
    this.theme = null;
    this.requestRender();
  }
  set readingWidth(width: number | undefined) {
    this.reading = width ?? Infinity;
    this.requestRender();
  }
  set terminalBackground(color: RGBA | undefined) {
    this.background = color;
    this.requestRender();
  }
  set placeholder(text: string | undefined) {
    this._placeholder = text ?? "";
    this.requestRender();
  }
  set onChange(handler: ((markdown: string) => void) | undefined) {
    this._onChange = handler;
  }
  set onLink(handler: ((url: string) => void) | undefined) {
    this._onLink = handler;
  }
  set onCopy(handler: ((markdown: string) => void) | undefined) {
    this._onCopy = handler;
  }
  set onFocusRequest(handler: (() => void) | undefined) {
    this._onFocusRequest = handler;
  }

  private currentTheme(): Theme | null {
    if (!this.syntax) return null;
    this.theme ??= new Theme(this.syntax, this.selectionBg ? { selection: this.selectionBg } : {});
    return this.theme;
  }
  /**
   * The page: `readingWidth` wide at most, centered, and the margin left of it. With a
   * reading width, the page keeps a margin for bands and panels however narrow the editor
   * (unless it is too narrow to spare one).
   */
  private column() {
    const spare = Number.isFinite(this.reading) && this.width >= MIN_MARGINED;
    const room = spare ? this.width - HANG * 2 : this.width;
    const width = Math.max(1, Math.min(room, this.reading));
    const offset = Math.max(0, Math.floor((this.width - width) / 2));
    return { width, offset };
  }
  /** A cell's size in pixels, when the terminal told its own. */
  private cell(): CellSize | null {
    const { resolution, terminalWidth, terminalHeight } = this.ctx;
    if (!resolution || !terminalWidth || !terminalHeight) return null;
    return { width: resolution.width / terminalWidth, height: resolution.height / terminalHeight };
  }

  /** The document laid out for the current page, recomputed only when that changed. */
  private layout(): Layout | null {
    const theme = this.currentTheme();
    if (!theme) return null;
    const { width, offset } = this.column();
    const doc = this.controller.state.doc;
    const protocol = protocolOf(this.ctx);
    const cell = this.cell();
    const options: LayoutOptions = {
      highlight: (block, lang, text) => this.highlighter.lookup(block, lang, text),
      hang: Math.min(HANG, offset),
      caps: OCTANTS.test(this.ctx.capabilities?.terminal.name ?? ""),
      // The block being edited shows its Markdown: a table's pipes, an image's source.
      ...(this.focused ? { revealed: this.controller.state.selection.head.block } : {}),
      images: [protocol, this.images, cell?.width, cell?.height].join(":"),
      ...(cell ? { cell } : {}),
      image: (url) => {
        if (!protocol) return undefined;
        const image = imageAt(url, this.imageReady);
        return image === "missing" || image === undefined
          ? image
          : { width: image.width, height: image.height };
      },
    };
    const key = [width, options.hang, options.caps, options.revealed, options.images].join(":");
    const laid = this.laid;
    if (laid && laid.doc === doc && laid.key === key && laid.theme === theme) return laid.layout;
    const layout = layoutDocument(doc, width, theme, options);
    this.laid = { layout, doc, key, theme };
    return layout;
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const layout = this.layout();
    const theme = this.currentTheme();
    if (!layout || !theme) return;
    this.clampScroll(layout);
    const { selection } = this.controller.state;
    const { width, offset } = this.column();
    const protocol = protocolOf(this.ctx);
    drawLayout(
      buffer,
      layout,
      {
        x: this.screenX + offset,
        y: this.screenY,
        width,
        height: this.height,
        scroll: this.scroll,
      },
      theme,
      {
        selection: isCollapsed(selection) ? null : range(selection),
        ...(this._placeholder ? { placeholder: this._placeholder } : {}),
        ...(this.background ? { background: this.background } : {}),
        ...(this.hoveredTask === null ? {} : { hoveredTask: this.hoveredTask }),
        ...(protocol
          ? {
              images: {
                get: (url: string) => {
                  const image = imageAt(url, this.imageReady);
                  return image === "missing" ? undefined : image;
                },
                protocol,
                cell: this.cell(),
              },
            }
          : {}),
      },
    );
    this.placeCursor(layout);
  }

  private placeCursor(layout: Layout) {
    if (!this.focused) return;
    const { row, col } = cellOf(layout, this.controller.state.selection.head);
    const { width, offset } = this.column();
    const visible = row >= this.scroll && row < this.scroll + this.height && col < width;
    // Terminal cursor coordinates start at 1.
    this.ctx.setCursorPosition(
      this.screenX + offset + col + 1,
      this.screenY + row - this.scroll + 1,
      visible,
    );
  }
  override focus(): void {
    super.focus();
    this.requestRender();
  }
  override blur(): void {
    super.blur();
    this.controller.settle();
    this.ctx.setCursorPosition(0, 0, false);
    this.requestRender();
  }
  protected override onRemove(): void {
    if (this.focused) this.ctx.setCursorPosition(0, 0, false);
  }

  private clampScroll(layout: Layout) {
    const max = Math.max(0, layout.lines.length - this.height);
    this.scroll = Math.max(0, Math.min(max, this.scroll));
  }
  private keepCursorInView() {
    const layout = this.layout();
    if (!layout || this.height <= 0) return;
    const { row } = cellOf(layout, this.controller.state.selection.head);
    if (row < this.scroll) this.scroll = row;
    else if (row >= this.scroll + this.height) this.scroll = row - this.height + 1;
  }

  override handleKeyPress(key: KeyEvent): boolean {
    const intent = intentOf(key);
    if (!intent) return false;
    const handled = this.perform(intent);
    if (handled) key.preventDefault();
    return handled;
  }
  override handlePaste(event: PasteEvent): void {
    this.controller.paste(decodePasteBytes(event.bytes));
    event.preventDefault();
  }

  private perform(intent: Intent): boolean {
    const controller = this.controller;
    if (
      intent.type !== "move" ||
      (intent.to !== "up" &&
        intent.to !== "down" &&
        intent.to !== "pageUp" &&
        intent.to !== "pageDown")
    )
      this.goal = null;
    if (intent.type === "move") {
      this.move(intent.to, { word: intent.word, extend: intent.extend });
      return true;
    }
    return perform(controller, intent, { copy: (text) => this._onCopy?.(text) });
  }

  private move(to: Motion, options: { word: boolean; extend: boolean }) {
    const layout = this.layout();
    const { state } = this.controller;
    const { head } = state.selection;
    const collapsed = isCollapsed(state.selection);
    if (!layout) return;
    let target: Pos = head;
    switch (to) {
      case "left":
      case "right": {
        // Left or right on a selection lands on its edge.
        if (!collapsed && !options.extend) {
          const { from, to: end } = range(state.selection);
          target = to === "left" ? from : end;
          break;
        }
        target = moveHorizontal(
          state.doc,
          head,
          to === "left" ? -1 : 1,
          options.word ? "word" : "char",
        );
        break;
      }
      case "up":
      case "down":
      case "pageUp":
      case "pageDown": {
        const page = Math.max(1, this.height - 1);
        const delta = to === "up" ? -1 : to === "down" ? 1 : to === "pageUp" ? -page : page;
        const moved = moveVertical(layout, head, delta, this.goal);
        this.goal = moved.goal;
        target = moved.pos;
        // Down from the end of code or a table that ends the document: out of it.
        const atEnd = delta > 0 && collapsed && !options.extend && samePos(target, head);
        if (atEnd && head.block === state.doc.length - 1 && this.controller.leaveLast()) return;
        break;
      }
      case "lineStart":
      case "lineEnd":
        target = lineEdge(layout, head, to === "lineStart" ? "start" : "end");
        break;
      case "docStart":
        target = { block: 0, offset: 0 };
        break;
      case "docEnd":
        target = lastPos(layout) ?? head;
        break;
    }
    const goal = this.goal;
    this.controller.moveTo(target, { extend: options.extend });
    this.goal = goal;
  }

  /** The glyph, line and position under a screen cell. */
  private hit(event: MouseEvent) {
    const layout = this.layout();
    if (!layout) return null;
    const row = event.y - this.screenY + this.scroll;
    const col = event.x - this.screenX - this.column().offset;
    const line = layout.lines[row];
    const glyph: Glyph | undefined = line?.glyphs.find((g) => col >= g.x && col < g.x + g.width);
    return { layout, row, col, line, glyph, pos: posAt(layout, row, col) };
  }

  protected override onMouseEvent(event: MouseEvent): void {
    switch (event.type) {
      case "scroll": {
        const layout = this.layout();
        if (!layout || !event.scroll) return;
        const delta =
          event.scroll.direction === "up"
            ? -SCROLL_LINES
            : event.scroll.direction === "down"
              ? SCROLL_LINES
              : 0;
        this.scroll += delta;
        this.clampScroll(layout);
        this.requestRender();
        event.stopPropagation();
        return;
      }
      case "move":
      case "over": {
        const hit = this.hit(event);
        const task = hit && onTaskBox(hit.line, hit.col) ? (hit.line?.block ?? null) : null;
        if (task !== this.hoveredTask) {
          this.hoveredTask = task;
          this.requestRender();
        }
        const link = hit?.glyph?.link ?? hit?.line?.image?.link;
        const follows = !this.focused || event.modifiers.ctrl || event.modifiers.alt;
        this.ctx.setMousePointer(
          task !== null || (link !== undefined && follows) ? "pointer" : "text",
        );
        return;
      }
      case "out":
        if (this.hoveredTask !== null) {
          this.hoveredTask = null;
          this.requestRender();
        }
        this.ctx.setMousePointer("default");
        return;
      case "down":
        if (event.button === MouseButton.LEFT) this.press(event);
        return;
      case "drag":
        if (this.dragging) {
          const hit = this.hit(event);
          if (hit) this.controller.moveTo(hit.pos, { extend: true });
        }
        return;
      case "up":
      case "drag-end":
        this.dragging = false;
        return;
      default:
        return;
    }
  }

  private press(event: MouseEvent) {
    const hit = this.hit(event);
    if (!hit) return;
    event.stopPropagation();
    const { line, glyph, pos, col } = hit;
    // A task's box ticks it, whatever the focus.
    if (line && onTaskBox(line, col)) {
      this.controller.toggleTask(line.block);
      return;
    }
    const link = glyph?.link ?? line?.image?.link;
    if (
      link !== undefined &&
      this._onLink &&
      (!this.focused || event.modifiers.ctrl || event.modifiers.alt)
    ) {
      this._onLink(link);
      return;
    }
    if (!this.focused) {
      if (this._onFocusRequest) this._onFocusRequest();
      else this.focus();
    }
    const now = Date.now();
    const again =
      now - this.clicks.at < MULTI_CLICK_MS &&
      event.x === this.clicks.x &&
      event.y === this.clicks.y;
    this.clicks = { count: again ? this.clicks.count + 1 : 1, at: now, x: event.x, y: event.y };
    this.goal = null;
    if (this.clicks.count === DOUBLE) return this.selectWord(pos);
    if (this.clicks.count >= TRIPLE) return this.selectBlock(pos);
    this.dragging = true;
    this.controller.moveTo(pos, { extend: event.modifiers.shift });
  }
  private selectWord(pos: Pos) {
    const block = this.controller.state.doc[pos.block];
    if (!block) return;
    const { from, to } = wordAround(textOfBlock(block), pos.offset);
    this.controller.select({
      anchor: { block: pos.block, offset: from },
      head: { block: pos.block, offset: to },
    });
  }
  private selectBlock(pos: Pos) {
    const block = this.controller.state.doc[pos.block];
    if (!block) return;
    const length = textOfBlock(block).length;
    this.controller.select({
      anchor: { block: pos.block, offset: 0 },
      head: { block: pos.block, offset: length },
    });
  }
}

/** Whether column `col` of `line` is on a task's box (or the space after it). */
function onTaskBox(line: Layout["lines"][number] | undefined, col: number) {
  const marker = line?.marker;
  return marker?.task === true && col >= marker.x && col < marker.x + marker.text.length + 1;
}
