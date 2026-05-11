"use client";

/**
 * Crucible — source-side drop submission form.
 *
 * Brutalist, dense, prominent. Three inputs and a submit:
 *
 *   - Newsroom pubkey: 64- or 66-char hex. Live validation through
 *     `isValidPubkeyHex`; submit stays disabled while invalid.
 *   - Message: markdown textarea. No length cap in the source-side UI
 *     (envelope format supports up to ~4 GiB; UX cap is the textarea
 *     itself shouldn't grow indefinitely on screen, so we let CSS handle
 *     it).
 *   - Attachment: single optional file via native file picker. The
 *     envelope packs zero-or-one files; multi-file is reserved.
 *   - Submit: locked while `working` is true to prevent double-submit.
 *
 * The component is dumb — it owns input state and validation only. The
 * full submit pipeline (ephemeral → ECDH → encrypt → Pinata → publish)
 * lives in `useSubmitDrop`. On success the page swaps this form for
 * `<SuccessScreen />`.
 *
 * # No identity required
 *
 * The source page never asks for an identity. The ephemeral keypair
 * inside the submit pipeline is the source's sole "identity" for this
 * one drop, and it never leaves the in-memory call stack.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { ShieldAlert, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import {
  CRUCIBLE_MAX_ATTACHMENT_BYTES,
  isValidPubkeyHex,
} from "@/lib/crucible";

export type SourceDropboxProps = {
  /** Called when the user clicks Submit. Parent handles the pipeline + redirect. */
  onSubmit: (newsroomPubkey: string, message: string, file?: File) => void;
  /** True while a submit is in flight. Locks the form. */
  working: boolean;
  /** Error message to show above the submit, or null. */
  error: string | null;
  /** True if the transport hasn't finished bringing up — disables submit. */
  transportPending: boolean;
};

export function SourceDropbox(props: SourceDropboxProps) {
  const { onSubmit, working, error, transportPending } = props;

  const [pubkey, setPubkey] = useState("");
  const [message, setMessage] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const pubkeyValid = useMemo(
    () => pubkey.length > 0 && isValidPubkeyHex(pubkey),
    [pubkey],
  );
  const fileTooLarge = useMemo<boolean>(
    () => Boolean(file && file.size > CRUCIBLE_MAX_ATTACHMENT_BYTES),
    [file],
  );
  const canSubmit =
    !working &&
    !transportPending &&
    pubkeyValid &&
    !fileTooLarge &&
    message.trim().length > 0;

  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!canSubmit) return;
      onSubmit(pubkey.trim(), message, file ?? undefined);
    },
    [canSubmit, file, message, onSubmit, pubkey],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0] ?? null;
      setFile(f);
    },
    [],
  );

  const clearFile = useCallback(() => {
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <Card className="shadow-[var(--shadow-brutal-xl)]">
        <CardHeader>
          <CardTitle className="font-heading text-2xl font-black uppercase tracking-tight">
            Anonymous source drop
          </CardTitle>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Encrypted in your browser to the newsroom&apos;s public key, uploaded
            via IPFS, and announced on three independent networks. The newsroom
            decrypts when they next sign in.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <label className="flex flex-col gap-2">
              <span className="font-mono text-[10px] font-bold uppercase tracking-widest">
                Newsroom public key
              </span>
              <Input
                type="text"
                spellCheck={false}
                autoComplete="off"
                inputMode="text"
                placeholder="64- or 66-char hex"
                value={pubkey}
                onChange={(e) => setPubkey(e.target.value)}
                disabled={working}
                className="h-12 font-mono text-base shadow-[var(--shadow-brutal)]"
                data-testid="crucible-newsroom-pubkey"
              />
              {pubkey.length > 0 && !pubkeyValid ? (
                <span className="font-mono text-[10px] uppercase tracking-widest">
                  Must be 64 or 66 hex chars.
                </span>
              ) : null}
            </label>

            <label className="flex flex-col gap-2">
              <span className="font-mono text-[10px] font-bold uppercase tracking-widest">
                Your message
              </span>
              <Textarea
                placeholder="Markdown is fine. Be specific about what you&apos;re sharing."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={working}
                rows={10}
                className="min-h-[200px] resize-y font-mono text-sm leading-relaxed shadow-[var(--shadow-brutal)]"
                data-testid="crucible-message"
              />
            </label>

            <div className="flex flex-col gap-2">
              <span className="font-mono text-[10px] font-bold uppercase tracking-widest">
                Attachment (optional) — up to {formatBytes(CRUCIBLE_MAX_ATTACHMENT_BYTES)}
              </span>
              <div className="flex flex-wrap items-center gap-3 border-2 border-dashed border-foreground p-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={handleFileChange}
                  disabled={working}
                  data-testid="crucible-file-input"
                />
                <Button
                  type="button"
                  variant="neutral"
                  size="lg"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={working}
                  className="shadow-[var(--shadow-brutal)]"
                >
                  <Upload className="size-4" strokeWidth={2.5} />
                  {file ? "Replace file" : "Choose file"}
                </Button>
                {file ? (
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <p className="min-w-0 flex-1 truncate font-mono text-xs">
                      {file.name} ({formatBytes(file.size)})
                    </p>
                    <Button
                      type="button"
                      variant="neutral"
                      size="sm"
                      onClick={clearFile}
                      disabled={working}
                    >
                      Remove
                    </Button>
                  </div>
                ) : (
                  <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
                    attachments up to {formatBytes(CRUCIBLE_MAX_ATTACHMENT_BYTES)} — files stay encrypted end-to-end
                  </p>
                )}
              </div>
              {fileTooLarge ? (
                <div
                  className="flex items-start gap-3 border-2 border-foreground bg-background p-3 shadow-[var(--shadow-brutal)]"
                  data-testid="crucible-attachment-too-large"
                >
                  <ShieldAlert
                    className="size-5 shrink-0"
                    strokeWidth={2.5}
                  />
                  <p className="font-mono text-xs leading-relaxed">
                    File exceeds the {formatBytes(CRUCIBLE_MAX_ATTACHMENT_BYTES)} cap
                    ({file ? formatBytes(file.size) : ""}). Remove it or choose
                    a smaller one to enable submit.
                  </p>
                </div>
              ) : null}
            </div>

            {error ? (
              <div className="flex items-start gap-3 border-2 border-foreground bg-background p-3 shadow-[var(--shadow-brutal)]">
                <ShieldAlert className="size-5 shrink-0" strokeWidth={2.5} />
                <p className="font-mono text-xs leading-relaxed">{error}</p>
              </div>
            ) : null}

            <Button
              type="submit"
              size="lg"
              disabled={!canSubmit}
              className="h-14 text-base shadow-[var(--shadow-brutal-lg)]"
              data-testid="crucible-submit"
            >
              {working
                ? "Sealing & broadcasting…"
                : transportPending
                  ? "Connecting…"
                  : "Submit drop"}
            </Button>
            <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
              your browser will mint a one-shot key, encrypt locally, then wipe it.
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

/** Compact size formatting (KB, MB, GB) for the attachment label. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
