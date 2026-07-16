import { TrafficInspectorPageClient } from "./TrafficInspectorPageClient";

export const metadata = {
  title: "Traffic Inspector — RouteChi",
  description: "Monitor LLM calls + debug any application's HTTPS traffic",
};

export default function TrafficInspectorPage() {
  return <TrafficInspectorPageClient />;
}
