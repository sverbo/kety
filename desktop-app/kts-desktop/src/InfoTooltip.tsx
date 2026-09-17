import {
  createContext,
  useCallback,
  useContext,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useCloseOnOutsidePress } from "./useCloseOnOutsidePress";

export const InfoTooltipCtx = createContext<{
  openId: string | null;
  setOpenId: (id: string | null) => void;
} | null>(null);

export function InfoTooltipProvider({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <InfoTooltipCtx.Provider value={{ openId, setOpenId }}>
      {children}
    </InfoTooltipCtx.Provider>
  );
}

export function InfoTooltip({ children }: { children: string }) {
  const id = useId();
  const ctx = useContext(InfoTooltipCtx);
  const [localOpen, setLocalOpen] = useState(false);
  const open = ctx ? ctx.openId === id : localOpen;
  const btnRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [shiftLeft, setShiftLeft] = useState(false);
  const setOpenId = ctx?.setOpenId;

  const close = useCallback(() => {
    if (setOpenId) setOpenId(null);
    else setLocalOpen(false);
  }, [setOpenId]);

  useCloseOnOutsidePress(wrapRef, open, close);

  function toggle() {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setShiftLeft(rect.right + 260 > window.innerWidth);
    }
    if (ctx) {
      ctx.setOpenId(open ? null : id);
    } else {
      setLocalOpen((o) => !o);
    }
  }

  return (
    <span ref={wrapRef} className="info-tooltip-wrap">
      <button
        ref={btnRef}
        type="button"
        className="info-tooltip-btn"
        onClick={toggle}
        aria-expanded={open}
        aria-label="More information"
      >
        ⓘ
      </button>
      {open && (
        <span className={`info-tooltip-content${shiftLeft ? " info-tooltip-left" : ""}`}>
          {children}
        </span>
      )}
    </span>
  );
}
