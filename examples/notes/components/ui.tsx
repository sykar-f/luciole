"use client";
import { useState, type ReactNode } from "react";
import type { MouseEvent } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useBindings } from "luciole/client";
import { usePalette, type Palette } from "./theme";
import { ui, useUi, type Menu } from "./ui-state";

// The notebook's controls: every action is something to point at. Keys exist for some
// of them, never written on screen.

/** One fixed-height, truncated line: long text never pushes the layout. */
export function Line({
  id,
  children,
  fg,
  bg,
  bold,
}: {
  id?: string;
  children?: ReactNode;
  fg?: string;
  bg?: string;
  bold?: boolean;
}) {
  return (
    <text id={id} height={1} flexShrink={0} wrapMode="none" truncate fg={fg} bg={bg}>
      {bold ? <strong>{children ?? ""}</strong> : (children ?? "")}
    </text>
  );
}

/** Hover state, and the hand pointer where the terminal draws one. */
export function useHover() {
  const renderer = useRenderer();
  const [hovered, setHovered] = useState(false);
  return {
    hovered,
    handlers: {
      onMouseOver: () => {
        setHovered(true);
        renderer.setMousePointer("pointer");
      },
      onMouseOut: () => {
        setHovered(false);
        renderer.setMousePointer("default");
      },
    },
  };
}

/** "danger" is quiet until pointed at, then says what it would destroy in red. */
type Tone = "primary" | "plain" | "quiet" | "danger";
/** A button's colors for its tone, lit under the pointer or not. */
function toneColors(color: Palette, tone: Tone, lit: boolean, disabled: boolean) {
  const background =
    tone === "primary"
      ? lit
        ? color.text
        : color.accent
      : tone === "quiet" || tone === "danger"
        ? lit
          ? color.buttonHover
          : undefined
        : lit
          ? color.buttonHover
          : color.button;
  const foreground = disabled
    ? color.faint
    : tone === "primary"
      ? color.onAccent
      : tone === "danger" && lit
        ? color.danger
        : (tone === "quiet" || tone === "danger") && !lit
          ? color.muted
          : color.text;
  return { background, foreground };
}
/** Pressed with any mouse button, never through to what lies beneath. */
function usePress(onPress: (event: MouseEvent) => void, disabled: boolean) {
  const { hovered, handlers } = useHover();
  return {
    lit: hovered && !disabled,
    props: {
      ...(disabled ? {} : handlers),
      onMouseDown: (event: MouseEvent) => {
        event.stopPropagation();
        if (!disabled) onPress(event);
      },
    },
  };
}
/** A labelled button, one row high: it lights up under the pointer. */
export function Button({
  id,
  children,
  onPress,
  tone = "plain",
  disabled = false,
}: {
  id?: string;
  children: ReactNode;
  /** The click that pressed it, for what opens where the pointer is (a menu). */
  onPress: (event: MouseEvent) => void;
  tone?: Tone;
  disabled?: boolean;
}) {
  const color = usePalette();
  const { lit, props } = usePress(onPress, disabled);
  const { background, foreground } = toneColors(color, tone, lit, disabled);
  return (
    <box id={id} height={1} flexShrink={0} paddingX={1} backgroundColor={background} {...props}>
      <text wrapMode="none" fg={foreground}>
        {children}
      </text>
    </box>
  );
}

/** An icon button's size: as tall as the search box beside it, about as wide as tall. */
export const ICON_BUTTON_WIDTH = 5;
export const ICON_BUTTON_HEIGHT = 3;
/**
 * One symbol in a rounded frame, three rows high: a target found without aiming, framed
 * like the search box so that a row of them reads as one block.
 */
export function IconButton({
  id,
  icon,
  onPress,
  tone = "plain",
}: {
  id?: string;
  icon: string;
  onPress: (event: MouseEvent) => void;
  tone?: Tone;
}) {
  const color = usePalette();
  const { lit, props } = usePress(onPress, false);
  const { foreground } = toneColors(color, tone, lit, false);
  // Every one on the same grey as the search box, so that the row reads as one bar. A
  // primary one is told by its frame and symbol in the accent: a cell filled with it
  // would square off the frame's rounded corners.
  const primary = tone === "primary";
  return (
    <box
      id={id}
      width={ICON_BUTTON_WIDTH}
      height={ICON_BUTTON_HEIGHT}
      flexShrink={0}
      justifyContent="center"
      alignItems="center"
      border
      borderStyle="rounded"
      borderColor={primary ? (lit ? color.text : color.accent) : lit ? color.muted : color.border}
      backgroundColor={lit ? color.buttonHover : color.button}
      {...props}
    >
      <text wrapMode="none" fg={primary ? (lit ? color.text : color.accent) : foreground}>
        {icon}
      </text>
    </box>
  );
}

/** The open menu, over everything, at the cells it was asked for. */
export function MenuLayer() {
  const { menu } = useUi();
  return menu ? <MenuView menu={menu} /> : null;
}

const MENU_MIN_WIDTH = 18;
const MENU_FRAME = 4;
function MenuView({ menu }: { menu: Menu }) {
  const color = usePalette();
  const renderer = useRenderer();
  const [active, setActive] = useState(0);
  const run = (index: number) => {
    const item = menu.items[index];
    ui.closeMenu();
    item?.run();
  };
  useBindings(
    () => ({
      bindings: [
        { key: "down", cmd: () => setActive((i) => (i + 1) % menu.items.length) },
        {
          key: "up",
          cmd: () => setActive((i) => (i - 1 + menu.items.length) % menu.items.length),
        },
        { key: "return", cmd: () => run(active) },
        { key: "escape", cmd: ui.closeMenu },
      ],
    }),
    [active, menu],
  );
  const width = Math.max(MENU_MIN_WIDTH, ...menu.items.map((i) => i.label.length + MENU_FRAME));
  const height = menu.items.length + 2;
  // Kept inside the screen: a menu opened near an edge opens towards the middle.
  const left = Math.max(0, Math.min(menu.x, renderer.width - width));
  const top = Math.max(0, Math.min(menu.y, renderer.height - height));
  return (
    <>
      {/* Catches every click outside the menu, of any button. */}
      <box
        position="absolute"
        left={0}
        top={0}
        width="100%"
        height="100%"
        zIndex={10}
        onMouseDown={ui.closeMenu}
      />
      <box
        id="menu"
        position="absolute"
        left={left}
        top={top}
        zIndex={11}
        width={width}
        flexDirection="column"
        border
        borderStyle="rounded"
        borderColor={color.border}
        backgroundColor={color.menu}
      >
        {menu.items.map((item, i) => (
          <box
            key={item.label}
            height={1}
            paddingX={1}
            backgroundColor={i === active ? color.selected : undefined}
            onMouseOver={() => setActive(i)}
            onMouseDown={(event: MouseEvent) => {
              event.stopPropagation();
              run(i);
            }}
          >
            <text wrapMode="none" fg={item.danger ? color.danger : color.text}>
              {item.label}
            </text>
          </box>
        ))}
      </box>
    </>
  );
}

/** The last notice, bottom right, with the one action it may offer (Undo). */
export function ToastLayer() {
  const { toast } = useUi();
  const color = usePalette();
  if (!toast) return null;
  return (
    <box
      id="toast"
      position="absolute"
      right={2}
      bottom={1}
      zIndex={9}
      flexDirection="row"
      gap={1}
      paddingX={1}
      border
      borderStyle="rounded"
      borderColor={color.border}
      backgroundColor={color.menu}
    >
      <text wrapMode="none" fg={color.text}>
        {toast.text}
      </text>
      {toast.action ? (
        <Button
          tone="primary"
          onPress={() => {
            ui.dismissToast();
            toast.action?.run();
          }}
        >
          {toast.action.label}
        </Button>
      ) : null}
      <Button tone="quiet" onPress={ui.dismissToast}>
        ✕
      </Button>
    </box>
  );
}
