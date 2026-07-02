import { redirect } from "next/navigation";

/**
 * Everyone — admin and user alike — lands on the Netflix Discover experience.
 * Management (the old dashboard, settings, system) now lives in the admin panel
 * under /settings.
 */
export default function HomePage() {
  redirect("/discover");
}
