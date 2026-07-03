import { cn } from "@/lib/cn";

export function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      {/* min-w keeps columns readable on phones: the wrapper scrolls instead of squishing. */}
      <table className={cn("w-full min-w-[560px] border-collapse text-sm", className)} {...props} />
    </div>
  );
}

export function THead({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead className={cn("bg-zinc-900/70 text-left text-xs uppercase tracking-wide text-zinc-500", className)} {...props} />;
}

export function TBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody className={cn("divide-y divide-zinc-800", className)} {...props} />;
}

export function TR({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr className={cn("hover:bg-zinc-900/40", className)} {...props} />;
}

export function TH({ className, ...props }: React.ComponentProps<"th">) {
  return <th className={cn("whitespace-nowrap px-3 py-2 font-medium", className)} {...props} />;
}

export function TD({ className, ...props }: React.ComponentProps<"td">) {
  return <td className={cn("px-3 py-2 text-zinc-300", className)} {...props} />;
}
