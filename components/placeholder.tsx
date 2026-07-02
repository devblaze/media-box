export function Placeholder({ title, phase }: { title: string; phase: string }) {
  return (
    <div>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-zinc-400">Coming in {phase}.</p>
    </div>
  );
}
