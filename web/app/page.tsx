"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { parseFrontmatter } from "@/lib/frontmatter";
import { parseChatRef, type ChatRef } from "@/lib/chat";
import { taskSlug } from "@/lib/tasks";
import { TaskDialog, type TaskTarget } from "@/components/TaskDialog";
import { ChatLaunch } from "@/components/ChatLaunch";

// The workspace this board renders. Matches `workspace` in ../hitch.config.json
// (the daemon pushes files under this id). Hard-coded for now; later this comes
// from routing / a workspace picker.
const WORKSPACE = "will-default";

// Columns the board shows, in order. Any task whose `status` frontmatter
// doesn't match one of these falls into "todo".
const COLUMNS = ["todo", "in-progress", "blocked", "done"] as const;
type Column = (typeof COLUMNS)[number];

function columnFor(status: string | undefined): Column {
  const s = (status ?? "").toLowerCase();
  return (COLUMNS as readonly string[]).includes(s) ? (s as Column) : "todo";
}

interface Card {
  id: string; // `${source}/tasks/${slug}` — the task folder
  slug: string;
  title: string;
  owner?: string;
  source: string;
  path: string; // tasks/<slug>/task.md — what the dialog writes back
  content: string; // raw file text
  chat: ChatRef | null; // the coding-agent chat driving this task, if linked
  column: Column;
  updatedAt: number;
}

export default function Board() {
  const files = useQuery(api.files.listFiles, { workspace: WORKSPACE });
  const [selected, setSelected] = useState<Card | null>(null);

  if (files === undefined) {
    return (
      <main className="flex flex-1 items-center justify-center text-muted-foreground">
        Connecting to Convex…
      </main>
    );
  }

  // A card is a task body (tasks/<slug>/task.md). Drop tombstones and any file
  // that isn't a canonical task body; parse frontmatter; bucket by status.
  const cards = files
    .filter((f) => !f.deleted)
    .flatMap((f): Card[] => {
      const slug = taskSlug(f.path);
      if (slug === null) return [];
      const { frontmatter } = parseFrontmatter(f.content);
      return [
        {
          id: `${f.source}/tasks/${slug}`,
          slug,
          title: frontmatter.title || slug,
          owner: frontmatter.owner,
          source: f.source,
          path: f.path,
          content: f.content,
          chat: parseChatRef(frontmatter),
          column: columnFor(frontmatter.status),
          updatedAt: f.updatedAt,
        },
      ];
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const byColumn = Object.fromEntries(
    COLUMNS.map((c) => [c, cards.filter((card) => card.column === c)]),
  ) as Record<Column, Card[]>;

  const target: TaskTarget | null = selected && {
    workspace: WORKSPACE,
    source: selected.source,
    path: selected.path,
    title: selected.title,
    content: selected.content,
  };

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="flex items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Hitch</h1>
        <span className="text-sm text-muted-foreground">
          {cards.length} task{cards.length === 1 ? "" : "s"} · live
        </span>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {COLUMNS.map((col) => (
          <section
            key={col}
            className="flex flex-col gap-3 rounded-xl bg-muted p-3"
          >
            <h2 className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {col} · {byColumn[col].length}
            </h2>
            {byColumn[col].map((card) => (
              <div
                key={card.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelected(card)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelected(card);
                  }
                }}
                className="cursor-pointer rounded-lg bg-card p-3 text-left shadow-sm ring-1 ring-border transition-shadow hover:ring-foreground/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <p className="text-sm font-medium text-card-foreground">
                  {card.title}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {card.owner ? `${card.owner} · ` : ""}
                  {card.source}
                </p>
                {card.chat && (
                  <div className="mt-2">
                    <ChatLaunch chat={card.chat} size="xs" stopPropagation />
                  </div>
                )}
              </div>
            ))}
            {byColumn[col].length === 0 && (
              <p className="px-1 text-xs text-muted-foreground/70">—</p>
            )}
          </section>
        ))}
      </div>

      <TaskDialog
        task={target}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </main>
  );
}
