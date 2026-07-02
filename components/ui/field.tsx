import { cn } from "@/lib/cn";

export type FieldProps = {
  label?: React.ReactNode;
  htmlFor?: string;
  description?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
};

/** Label + control + description/error wrapper. Keeps forms consistent + accessible. */
export function Field({ label, htmlFor, description, error, required, className, children }: FieldProps) {
  return (
    <div className={cn("space-y-1.5", className)}>
      {label && (
        <label htmlFor={htmlFor} className="block text-sm font-medium text-zinc-300">
          {label}
          {required && <span className="ml-0.5 text-amber-400">*</span>}
        </label>
      )}
      {children}
      {description && !error && <p className="text-xs text-zinc-500">{description}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
