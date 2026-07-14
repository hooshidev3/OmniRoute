"use client";

import { PageLoading } from "@/shared/components/Loading";
import { APP_CONFIG } from "@/shared/constants/appConfig";

export default function AppLoading() {
  return <PageLoading message={`Loading ${APP_CONFIG.name}...`} />;
}
