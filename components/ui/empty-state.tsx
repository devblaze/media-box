import { cn } from "@/lib/cn";

export type EmptyStateProps = {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
};

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-zinc-800 px-6 py-12 text-center",
        className
      )}
    >
      {icon && <div className="text-zinc-600">{icon}</div>}
      <div className="space-y-1">
        <p className="text-sm font-medium text-zinc-200">{title}</p>
        {description && <p className="mx-auto max-w-sm text-sm text-zinc-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}
