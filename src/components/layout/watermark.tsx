/**
 * Whole-page watermark: faint diagonal repeating text behind every page.
 * Sits between the body background and the page content via z-0 / main:z-10.
 */
const PHRASE = "End-to-end encrypted · Zero-knowledge · Decentralized";
const ROWS = 14;
const REPEATS_PER_ROW = 5;

export function Watermark() {
  const lineText = Array.from({ length: REPEATS_PER_ROW }, () => PHRASE).join(
    "  ·  ",
  );

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden select-none"
    >
      <div className="text-foreground/[0.11] dark:text-foreground/[0.08] absolute -inset-x-[15%] -inset-y-[10%] flex -rotate-[18deg] flex-col justify-center gap-7">
        {Array.from({ length: ROWS }).map((_, i) => (
          <div
            key={i}
            className="text-5xl font-black tracking-tighter whitespace-nowrap uppercase sm:text-6xl"
          >
            {lineText}
          </div>
        ))}
      </div>
    </div>
  );
}
