import React, { useLayoutEffect, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface DropdownPortalProps {
  anchorEl: HTMLElement | null;
  width: number;
  align?: 'left' | 'right';
  onClose: () => void;
  children: React.ReactNode;
}

// Dropdown rendered in a body portal with viewport clamping, so it can never be
// clipped by overflow containers or pushed outside the visible window.
export default function DropdownPortal({ anchorEl, width, align = 'left', onClose, children }: DropdownPortalProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const update = () => {
      if (!anchorEl) return;
      const r = anchorEl.getBoundingClientRect();
      const mh = menuRef.current?.offsetHeight ?? 0;
      let left = align === 'right' ? r.right - width : r.left;
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      let top = r.bottom + 4;
      // Flip above the anchor (or clamp) when it would overflow the bottom edge
      if (mh && top + mh > window.innerHeight - 8) {
        top = Math.max(8, Math.min(r.top - mh - 4, window.innerHeight - mh - 8));
      }
      setPos({ top, left });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorEl, width, align, children]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [anchorEl, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[70] bg-surface-100 border border-surface-300 rounded-xl shadow-2xl overflow-hidden"
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, width, visibility: pos ? 'visible' : 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  );
}
