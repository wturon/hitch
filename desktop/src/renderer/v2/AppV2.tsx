import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { generateKeyBetween } from "fractional-indexing";

import { Button } from "@/components/ui/button";
import { useHitchServer } from "@/lib/server/HitchServerProvider";
import type { HitchClient } from "@/lib/server/client";

// Deliberately minimal V2 shell (M2 PR 1): a sign-in/sign-up form and a
// projects proof-of-life that exercises the full data path — typed hc reads,
// a write, and WS-invalidation-driven refetch. Replaced by real views in PR 2.

const inputClass =
  "h-9 w-full min-w-0 rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

function WindowDragRegion() {
  return <div className="window-drag-region" aria-hidden />;
}

function SignInScreen() {
  const { signIn, signUp } = useHitchServer();
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result =
      mode === "sign-in"
        ? await signIn({ email, password })
        : await signUp({ email, password, name: name || email });
    if (!result.ok) {
      setError(result.error);
      setPending(false);
    }
  }

  return (
    <>
      <WindowDragRegion />
      <main className="flex min-h-screen items-center justify-center p-8 pt-14">
        <section className="flex w-full max-w-sm flex-col gap-4 rounded-lg border bg-card p-5 shadow-sm">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {mode === "sign-in" ? "Sign in to Hitch" : "Create your Hitch account"}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Email and password for your Hitch server.
            </p>
          </div>
          <form className="flex flex-col gap-3" onSubmit={submit}>
            {mode === "sign-up" && (
              <input
                className={inputClass}
                type="text"
                placeholder="Name"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
            <input
              className={inputClass}
              type="email"
              placeholder="Email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <input
              className={inputClass}
              type="password"
              placeholder="Password"
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button type="submit" disabled={pending}>
              {pending
                ? "Working..."
                : mode === "sign-in"
                  ? "Sign in"
                  : "Sign up"}
            </Button>
          </form>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <button
            type="button"
            className="self-start text-sm text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => {
              setMode(mode === "sign-in" ? "sign-up" : "sign-in");
              setError(null);
            }}
          >
            {mode === "sign-in"
              ? "New here? Create an account"
              : "Already have an account? Sign in"}
          </button>
        </section>
      </main>
    </>
  );
}

function ProjectsProofOfLife({ client }: { client: HitchClient }) {
  const { serverUrl, signOut } = useHitchServer();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: async () => {
      const response = await client.projects.$get();
      if (!response.ok) throw new Error(`Failed to list projects (${response.status})`);
      return await response.json();
    },
  });

  const createProject = useMutation({
    mutationFn: async (projectName: string) => {
      const rows = projects.data ?? [];
      const sortOrder = generateKeyBetween(rows.at(-1)?.sortOrder ?? null, null);
      const response = await client.projects.$post({
        json: { name: projectName, sortOrder },
      });
      if (!response.ok) throw new Error(`Failed to create project (${response.status})`);
      return await response.json();
    },
    onSuccess: () => {
      setDraft("");
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const projectName = draft.trim();
    if (projectName && !createProject.isPending) createProject.mutate(projectName);
  }

  return (
    <>
      <WindowDragRegion />
      <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-4 p-8 pt-14">
        <header className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              V2 proof of life · {serverUrl}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
        </header>
        <form className="flex gap-2" onSubmit={submit}>
          <input
            className={inputClass}
            type="text"
            placeholder="New project"
            aria-label="New project name"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" disabled={createProject.isPending || !draft.trim()}>
            Add
          </Button>
        </form>
        {projects.isPending && (
          <p className="text-sm text-muted-foreground">Loading projects…</p>
        )}
        {projects.isError && (
          <p className="text-sm text-destructive">{String(projects.error)}</p>
        )}
        {projects.data && projects.data.length === 0 && (
          <p className="text-sm text-muted-foreground">No projects yet.</p>
        )}
        {projects.data && projects.data.length > 0 && (
          <ul className="flex flex-col divide-y rounded-lg border" data-testid="v2-projects">
            {projects.data.map((project) => (
              <li key={project.id} className="px-3 py-2 text-sm">
                {project.name}
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}

export default function AppV2() {
  const { authReady, client } = useHitchServer();
  if (!authReady) return null;
  if (!client) return <SignInScreen />;
  return <ProjectsProofOfLife client={client} />;
}
