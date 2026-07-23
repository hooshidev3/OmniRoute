import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { updateSettings } from "@/lib/localDb";

/**
 * POST /api/sync/cloud/setup
 *
 * Called by the dashboard after the user deploys the Cloud Worker via the
 * Cloudflare "Deploy to Workers" button. This route:
 *   1. Calls GET <workerUrl>/setup on the deployed Worker.
 *   2. The Worker generates a random HMAC secret, stores it in KV, and
 *      returns it once.
 *   3. This route saves the secret + workerUrl to the settings DB so the
 *      local OmniRoute instance can verify future HMAC signatures.
 *
 * Request body:
 *   { "workerUrl": "https://<worker-name>.<subdomain>.workers.dev" }
 *
 * Response (200):
 *   {
 *     "success": true,
 *     "workerUrl": "https://...",
 *     "secret": "a1b2c3...",
 *     "message": "Worker configured. Cloud Sync is ready."
 *   }
 *
 * Response (409):
 *   { "error": "Worker is already configured..." }
 *
 * Response (502):
 *   { "error": "Failed to reach worker: ..." }
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let body: { workerUrl?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { workerUrl } = body;
  if (!workerUrl || typeof workerUrl !== "string" || !workerUrl.trim()) {
    return NextResponse.json(
      { error: "Missing required field: workerUrl" },
      { status: 400 }
    );
  }

  // Normalize URL — strip trailing slash
  const normalizedUrl = workerUrl.trim().replace(/\/+$/, "");

  // Validate URL format
  try {
    const parsed = new URL(normalizedUrl);
    if (!parsed.protocol.startsWith("http")) {
      throw new Error("URL must use http or https protocol");
    }
  } catch {
    return NextResponse.json(
      { error: "Invalid workerUrl format — must be a valid HTTP(S) URL" },
      { status: 400 }
    );
  }

  // Call the Worker's /setup endpoint
  const setupUrl = `${normalizedUrl}/setup`;
  try {
    const response = await fetch(setupUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      let errorMessage = `Worker returned ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error) errorMessage = errorJson.error;
      } catch {
        if (errorText) errorMessage = errorText.slice(0, 200);
      }

      // 409 = already configured — return as-is so the dashboard can guide
      // the user to use the existing secret or re-deploy
      if (response.status === 409) {
        return NextResponse.json(
          {
            error: errorMessage,
            alreadyConfigured: true,
          },
          { status: 409 }
        );
      }

      return NextResponse.json(
        { error: `Worker /setup failed: ${errorMessage}` },
        { status: 502 }
      );
    }

    const data = await response.json();
    if (!data.secret) {
      return NextResponse.json(
        { error: "Worker /setup response missing 'secret' field" },
        { status: 502 }
      );
    }

    // Save both workerUrl and secret to settings DB
    await updateSettings({
      cloudUrl: normalizedUrl,
      cloudSyncSecret: data.secret,
    });

    return NextResponse.json({
      success: true,
      workerUrl: normalizedUrl,
      secret: data.secret,
      message:
        "Worker configured successfully. Cloud Sync secret saved to database. You can now enable Cloud Sync.",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = message.includes("timeout") || message.includes("abort");
    return NextResponse.json(
      {
        error: isTimeout
          ? `Timed out reaching worker at ${setupUrl}. Check the URL and try again.`
          : `Failed to reach worker: ${sanitizeErrorMessage(message)}`,
      },
      { status: 502 }
    );
  }
}
