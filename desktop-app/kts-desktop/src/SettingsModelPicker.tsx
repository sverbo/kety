import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { IconCloudModel } from "./appConstants";

export type SettingsModelPickerKind = "none" | "local" | "openai" | "kety";

export type SettingsModelPickerOption = {
  value: string;
  label: string;
  disabled?: boolean;
  kind: SettingsModelPickerKind;
};

const MARK_COL_PX = 24;

function RowLeadingVisual({ kind }: { kind: SettingsModelPickerKind }) {
  const wrap: CSSProperties = {
    width: MARK_COL_PX,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
  if (kind === "openai") {
    return (
      <span style={wrap} aria-hidden>
        <IconCloudModel width={15} height={15} strokeWidth={1.65} />
      </span>
    );
  }
  if (kind === "kety") {
    return (
      <span style={wrap} aria-hidden>
        <img
          src="/kety-app-mark.png"
          alt=""
          width={16}
          height={16}
          draggable={false}
          style={{ display: "block", objectFit: "contain" }}
        />
      </span>
    );
  }
  return <span style={{ ...wrap, minHeight: 20 }} aria-hidden />;
}

export type SettingsModelPickerProps = {
  id: string;
  value: string;
  options: SettingsModelPickerOption[];
  onChange: (value: string) => void;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
};

export function SettingsModelPicker({
  id,
  value,
  options,
  onChange,
  className,
  style,
  "aria-label": ariaLabel,
}: SettingsModelPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value);
  const selectedLabel = selected?.label ?? value;

  const updateMenuRect = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = typeof window !== "undefined" ? window.innerHeight - r.bottom - 12 : 280;
    setMenuRect({
      top: r.bottom + 4,
      left: r.left,
      width: r.width,
      maxHeight: Math.max(120, Math.min(320, spaceBelow)),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setMenuRect(null);
      return;
    }
    updateMenuRect();
  }, [open, options, updateMenuRect]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onResize = () => updateMenuRect();
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, updateMenuRect]);

  return (
    <div
      ref={rootRef}
      className="settings-model-picker"
      style={{ position: "relative", width: "100%", minWidth: 0, ...style }}
    >
      <button
        ref={btnRef}
        id={id}
        type="button"
        className={`settings-input settings-model-picker__trigger${className ? ` ${className}` : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        disabled={options.length === 0}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="settings-model-picker__trigger-inner">
          <RowLeadingVisual kind={selected?.kind ?? "none"} />
          <span className="settings-model-picker__trigger-label">{selectedLabel}</span>
        </span>
        <span className="settings-model-picker__chevron" aria-hidden>
          ▾
        </span>
      </button>
      {open && menuRect && typeof document !== "undefined"
        ? createPortal(
            <ul
              ref={menuRef}
              id={listId}
              role="listbox"
              className="settings-model-picker__menu"
              style={{
                position: "fixed",
                top: menuRect.top,
                left: menuRect.left,
                width: menuRect.width,
                maxHeight: menuRect.maxHeight,
              }}
            >
              {options.map((opt) => {
                const isSel = opt.value === value;
                return (
                  <li
                    key={opt.value}
                    role="option"
                    aria-selected={isSel}
                    className={`settings-model-picker__option${
                      isSel ? " settings-model-picker__option--selected" : ""
                    }${opt.disabled ? " settings-model-picker__option--disabled" : ""}`}
                    onClick={() => {
                      if (opt.disabled) return;
                      onChange(opt.value);
                      setOpen(false);
                    }}
                  >
                    <RowLeadingVisual kind={opt.kind} />
                    <span className="settings-model-picker__option-label">{opt.label}</span>
                  </li>
                );
              })}
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}
