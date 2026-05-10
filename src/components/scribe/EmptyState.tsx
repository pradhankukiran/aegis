"use client";

/**
 * Empty-state hero for the Scribe page when no notes exist yet. Renders in
 * the center column (the editor slot) and offers a single CTA to mint the
 * first note.
 */

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function EmptyState({
  onCreate,
  creating,
}: {
  onCreate: () => void;
  creating: boolean;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-6 sm:p-12">
      <Card className="w-full max-w-xl shadow-[var(--shadow-brutal-xl)]">
        <CardHeader>
          <CardTitle className="font-heading text-2xl font-black uppercase tracking-tight">
            No notes yet
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed">
            Scribe stores every note encrypted at rest in this browser.
            Sharing a note creates a Matrix room scaffold so collaborators
            can join later — the body stays sealed until you decide to share.
          </p>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Press the button to write your first note.
          </p>
          <Button
            type="button"
            onClick={onCreate}
            disabled={creating}
            className="shadow-[var(--shadow-brutal-lg)]"
          >
            {creating ? "Creating…" : "Create note"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
