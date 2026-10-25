import type { LucideIcon } from "lucide-react";
import { PageHeader } from "../ui/PageHeader";
import { EmptyState } from "../ui/StateView";

interface PlaceholderPageProps {
  title: string;
  icon: LucideIcon;
  summary: string;
}

// Stands in for an area until its feature ticket builds the real page.
export function PlaceholderPage({
  title,
  icon,
  summary,
}: PlaceholderPageProps) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState icon={icon} title="Not built yet" description={summary} />
    </>
  );
}
