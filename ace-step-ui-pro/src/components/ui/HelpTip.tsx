import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';

/** The floating bubble. Renders to <body>, measures itself and clamps to the viewport. */
function Bubble({ anchor, text }: { anchor: DOMRect; text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({
    position: 'fixed',
    left: anchor.right + 10,
    top: anchor.top + anchor.height / 2,
    transform: 'translateY(-50%)',
    visibility: 'hidden', // hidden until measured to avoid a flash in the wrong spot
    maxWidth: 280,
    zIndex: 9999,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const GAP = 10;
    const M = 8; // viewport margin
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prefer to the RIGHT of the icon; flip to the left only if it wouldn't fit.
    let left = anchor.right + GAP;
    if (left + box.width > vw - M) {
      const leftSide = anchor.left - GAP - box.width;
      left = leftSide >= M ? leftSide : Math.max(M, vw - M - box.width);
    }

    // Vertically centered on the icon, clamped inside the viewport.
    let top = anchor.top + anchor.height / 2 - box.height / 2;
    top = Math.min(Math.max(M, top), vh - M - box.height);

    setStyle({
      position: 'fixed',
      left,
      top,
      maxWidth: 280,
      zIndex: 9999,
      visibility: 'visible',
    });
  }, [anchor, text]);

  return createPortal(
    <span
      ref={ref}
      style={style}
      className="pointer-events-none px-2.5 py-1.5 rounded-lg bg-surface-100 border border-surface-300/60 text-[10px] text-surface-800 leading-snug shadow-xl whitespace-normal"
    >
      {text}
    </span>,
    document.body
  );
}

/**
 * Small help icon with a tooltip that always stays fully visible: it appears to
 * the right of the cursor/icon, is rendered through a portal (so no ancestor
 * `overflow`/stacking context can clip it), and is clamped to the viewport.
 */
export default function HelpTip({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const show = () => {
    if (ref.current) setAnchor(ref.current.getBoundingClientRect());
  };
  const hide = () => setAnchor(null);

  return (
    <span
      ref={ref}
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      <HelpCircle className="w-3 h-3 text-surface-400 hover:text-accent-400 cursor-help transition-colors" />
      {anchor && <Bubble anchor={anchor} text={text} />}
    </span>
  );
}
