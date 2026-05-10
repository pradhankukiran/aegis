"use client";

/**
 * Drag-and-drop file picker for Witness.
 *
 * Behaviour:
 *   - Drag a file into the brutalist dashed-border zone → anchor pipeline
 *     fires.
 *   - Click anywhere on the zone → opens the native file picker.
 *   - While `working` is true the zone shows a "computing hash…" hint and
 *     ignores further drops (clicks are still permitted; the parent hook
 *     guards re-entry).
 *
 * The component itself is dumb — it does not hash or sign. It just hands
 * the chosen file to `onFile` and reflects the working/disabled state
 * passed in.
 *
 * The 2px dashed border is part of the brutalist palette and uses the same
 * border-style-carries-state convention as `NetworkStatusBadges`.
 */
import { useCallback, useRef, useState } from "react";
import { Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function FileDropzone({
  onFile,
  working,
  disabled,
  helper,
}: {
  onFile: (file: File) => void;
  working: boolean;
  disabled: boolean;
  helper?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);

  const open = useCallback(() => {
    if (disabled || working) return;
    inputRef.current?.click();
  }, [disabled, working]);

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) onFile(f);
      // Reset so picking the same file twice fires onChange again.
      e.target.value = "";
    },
    [onFile],
  );

  const onDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (disabled || working) return;
      e.preventDefault();
      setOver(true);
    },
    [disabled, working],
  );

  const onDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setOver(false);
    },
    [],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setOver(false);
      if (disabled || working) return;
      const f = e.dataTransfer.files?.[0];
      if (f) onFile(f);
    },
    [disabled, working, onFile],
  );

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      aria-disabled={disabled || working || undefined}
      data-state={
        working ? "working" : over ? "over" : disabled ? "disabled" : "idle"
      }
      className={cn(
        "flex w-full cursor-pointer flex-col items-center justify-center gap-3 border-2 border-dashed border-foreground bg-background p-8 text-center transition-shadow",
        over && "shadow-[var(--shadow-brutal-lg)]",
        working && "border-dotted",
        (disabled || working) && "cursor-default",
        disabled && "opacity-60",
      )}
    >
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={onChange}
        disabled={disabled || working}
      />
      <div className="bg-foreground text-background flex size-14 items-center justify-center sm:size-16">
        <Upload className="size-7 sm:size-8" strokeWidth={2.5} />
      </div>
      <p className="font-heading text-lg font-black uppercase tracking-tight">
        {working ? "Anchoring…" : "Drop a file to anchor"}
      </p>
      <p className="text-muted-foreground max-w-md text-sm leading-relaxed">
        {helper ??
          "Or click to pick. Your file is hashed locally — only the SHA-256 and signature leave this browser."}
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={disabled || working}
        onClick={(e) => {
          e.stopPropagation();
          open();
        }}
        className="shadow-[var(--shadow-brutal)]"
      >
        {working ? "Working…" : "Choose file"}
      </Button>
    </div>
  );
}
