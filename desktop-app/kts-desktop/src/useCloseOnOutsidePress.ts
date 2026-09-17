import { type RefObject, useEffect, useRef } from "react";

/**
 * Calls `onClose` on the next mousedown/touchstart outside `ref.current` (capture phase).
 */
export function useCloseOnOutsidePress(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      const node = ref.current;
      const t = e.target;
      if (node == null || !(t instanceof Node)) return;
      if (node.contains(t)) return;
      onCloseRef.current();
    };
    document.addEventListener("mousedown", handler, true);
    document.addEventListener("touchstart", handler, true);
    return () => {
      document.removeEventListener("mousedown", handler, true);
      document.removeEventListener("touchstart", handler, true);
    };
  }, [open, ref]);
}
