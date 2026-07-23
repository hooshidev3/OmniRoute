/**
 * POST /api/settings/cloud-worker/deploy
 *
 * Auto-deploys the OmniRoute Cloud Worker to Cloudflare.
 * Receives accountId + apiToken from the user (one-shot, never stored),
 * creates a KV namespace, deploys the worker script, sets the secret,
 * and saves the resulting worker URL to settings DB.
 */

import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { buildWorkerScript } from "@/lib/cloudWorker/deployScript";
import { updateSettings } from "@/lib/localDb";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let body: { accountId?: string; apiToken?: string; workerName?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { accountId, apiToken, workerName } = body;
  if (!accountId || !apiToken || !workerName) {
    return NextResponse.json(
      { error: "Missing required fields: accountId, apiToken, workerName" },
      { status: 400 }
    );
  }

  const scriptName = workerName.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const cfHeaders = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };

  try {
    // ── Step 1: Create KV namespace ──
    const kvRes = await fetch(
      `${CLOUDFLARE_API_BASE}/accounts/${accountId}/storage/kv/namespaces`,
      {
        method: "POST",
        headers: cfHeaders,
        body: JSON.stringify({ title: `omniroute-bundles-${scriptName}` }),
      }
    );
    if (!kvRes.ok) {
      const errText = await kvRes.text();
      return NextResponse.json(
        { error: `KV namespace creation failed: ${errText.slice(0, 200)}` },
        { status: 502 }
      );
    }
    const kvData = await kvRes.json();
    const kvNamespaceId = kvData?.result?.id;
    if (!kvNamespaceId) {
      return NextResponse.json({ error: "KV namespace created but ID not found" }, { status: 502 });
    }

    // ── Step 2: Generate HMAC secret ──
    const cloudSecret = randomBytes(32).toString("hex");

    // ── Step 3: Build worker script ──
    const workerScript = buildWorkerScript(kvNamespaceId, cloudSecret);

    // ── Step 4: Deploy worker script (ES module format) ──
    const deployUrl = `${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/scripts/${scriptName}`;
    const metadata = {
      main_module: "index.js",
      compatibility_date: "2024-09-01",
      bindings: [{ type: "kv_namespace", name: "BUNDLES", namespace_id: kvNamespaceId }],
    };

    // Build multipart form data manually (same pattern as cloudflare-deploy/route.ts)
    const boundary = "----FormBoundary" + randomBytes(16).toString("hex");
    const metadataPart =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="metadata"\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n`;
    const scriptPart =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="index.js"; filename="index.js"\r\n` +
      `Content-Type: application/javascript+module\r\n\r\n` +
      `${workerScript}\r\n` +
      `--${boundary}--\r\n`;

    const multipartBody = metadataPart + scriptPart;

    const uploadRes = await fetch(deployUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: multipartBody,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      // Clean up KV namespace on failure
      await fetch(
        `${CLOUDFLARE_API_BASE}/accounts/${accountId}/storage/kv/namespaces/${kvNamespaceId}`,
        { method: "DELETE", headers: cfHeaders }
      ).catch(() => {});
      return NextResponse.json(
        { error: `Worker deploy failed: ${errText.slice(0, 300)}` },
        { status: 502 }
      );
    }

    // ── Step 5: Enable workers.dev subdomain ──
    await fetch(`${deployUrl}/subdomain`, {
      method: "POST",
      headers: cfHeaders,
      body: JSON.stringify({ enabled: true }),
    }).catch(() => {});

    // ── Step 6: Get workers.dev subdomain ──
    const subdomainRes = await fetch(
      `${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/subdomain`,
      { method: "GET", headers: cfHeaders }
    );

    let workerUrl = "";
    if (subdomainRes.ok) {
      const subData = await subdomainRes.json();
      const sub = subData?.result?.subdomain;
      if (typeof sub === "string" && sub) {
        workerUrl = `https://${scriptName}.${sub}.workers.dev`;
      }
    }

    if (!workerUrl) {
      return NextResponse.json(
        {
          error:
            "Worker deployed but could not retrieve workers.dev subdomain. Enable it in Cloudflare dashboard.",
        },
        { status: 400 }
      );
    }

    // ── Step 7: Set CLOUD_SYNC_SECRET as a worker secret ──
    await fetch(`${deployUrl}/secrets`, {
      method: "PUT",
      headers: cfHeaders,
      body: JSON.stringify({
        name: "CLOUD_SYNC_SECRET",
        text: cloudSecret,
        type: "secret_text",
      }),
    }).catch(() => {});

    // ── Step 8: Save worker URL + cloud sync secret to settings DB ──
    // Both cloudUrl AND cloudSyncSecret are stored in the DB so the local
    // OmniRoute instance can use them without requiring manual .env edits.
    // cloudSync.ts reads the secret from env first, then falls back to DB.
    await updateSettings({
      cloudUrl: workerUrl,
      cloudSyncSecret: cloudSecret,
    });

    return NextResponse.json({
      success: true,
      workerUrl,
      kvNamespaceId,
      secret: cloudSecret, // also saved to DB — returned for transparency
      message:
        "Worker deployed successfully. Cloud sync secret saved to database — HMAC verification is active. No manual .env edit required.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Deploy failed: ${message}` }, { status: 500 });
  }
}
