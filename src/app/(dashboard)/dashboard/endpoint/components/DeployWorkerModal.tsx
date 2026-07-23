"use client";

import { useState } from "react";
import Button from "@/shared/components/Button";

interface DeployWorkerModalProps {
  onClose: () => void;
  onSuccess: (workerUrl: string, secret: string) => void;
}

type DeployMode = "button" | "api-token";

export default function DeployWorkerModal({ onClose, onSuccess }: DeployWorkerModalProps) {
  const [mode, setMode] = useState<DeployMode>("button");

  // API Token mode state
  const [accountId, setAccountId] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [workerName, setWorkerName] = useState("omniroute-cloud");
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Deploy Button mode state
  const [workerUrl, setWorkerUrl] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [buttonStep, setButtonStep] = useState(1); // 1=click deploy, 2=enter URL

  // ── Deploy Button mode ──
  const handleConnectButton = async () => {
    if (!workerUrl.trim()) {
      setError("Worker URL is required");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch("/api/sync/cloud/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workerUrl: workerUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.alreadyConfigured) {
          throw new Error(
            "Worker is already configured. If you don't have the secret, re-deploy the Worker (delete the KV key 'secret:cloud-sync' first)."
          );
        }
        throw new Error(data?.error || "Connection failed");
      }
      onSuccess(data.workerUrl, data.secret);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setConnecting(false);
    }
  };

  const openDeployButton = () => {
    window.open(
      "https://deploy.workers.cloudflare.com/?url=https://github.com/hooshidev3/OmniRoute/tree/main/cloud-worker",
      "_blank",
      "noopener,noreferrer"
    );
    setButtonStep(2);
  };

  // ── API Token mode ──
  const handleDeploy = async () => {
    if (!accountId.trim() || !apiToken.trim() || !workerName.trim()) {
      setError("All fields are required");
      return;
    }
    setDeploying(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/cloud-worker/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: accountId.trim(),
          apiToken: apiToken.trim(),
          workerName: workerName.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || "Deploy failed");
      }
      onSuccess(data.workerUrl, data.secret);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deploy failed");
    } finally {
      setDeploying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-96 max-w-full rounded-lg border border-border bg-surface p-6 shadow-lg">
        <h3 className="mb-1 text-sm font-semibold text-text-main">Deploy Cloud Worker</h3>

        {/* Mode tabs */}
        <div className="mb-4 flex gap-1 border-b border-border">
          <button
            onClick={() => { setMode("button"); setError(null); }}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              mode === "button"
                ? "border-b-2 border-primary text-primary"
                : "text-text-muted hover:text-text-main"
            }`}
          >
            Deploy Button (Recommended)
          </button>
          <button
            onClick={() => { setMode("api-token"); setError(null); }}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              mode === "api-token"
                ? "border-b-2 border-primary text-primary"
                : "text-text-muted hover:text-text-main"
            }`}
          >
            API Token (Advanced)
          </button>
        </div>

        {/* ── Deploy Button mode ── */}
        {mode === "button" && (
          <div className="space-y-3">
            {buttonStep === 1 && (
              <>
                <p className="text-xs text-text-muted">
                  Click the button below to deploy the Worker to your Cloudflare account.
                  You&apos;ll log in to Cloudflare, and it will automatically fork the repo,
                  provision KV, and deploy — no API token needed.
                </p>
                <button
                  onClick={openDeployButton}
                  className="flex w-full items-center justify-center gap-2 rounded-md bg-orange-500 px-4 py-2.5 text-xs font-medium text-white transition-colors hover:bg-orange-600"
                >
                  <span className="text-base">☁️</span>
                  Deploy to Cloudflare
                </button>
                <p className="text-[10px] text-text-muted">
                  A new tab will open. After deploy completes, come back here and enter
                  the Worker URL in the next step.
                </p>
              </>
            )}

            {buttonStep === 2 && (
              <>
                <p className="text-xs text-text-muted">
                  After the deploy completes, copy the Worker URL from the Cloudflare dashboard
                  and paste it below. OmniRoute will automatically configure the HMAC secret.
                </p>
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-muted">
                    Worker URL
                  </label>
                  <input
                    type="text"
                    value={workerUrl}
                    onChange={(e) => setWorkerUrl(e.target.value)}
                    placeholder="https://omniroute-cloud.your-subdomain.workers.dev"
                    className="w-full rounded-md border border-border bg-bg px-3 py-2 text-xs text-text-main focus:border-primary focus:outline-none"
                  />
                  <p className="mt-1 text-[10px] text-text-muted">
                    Cloudflare Dashboard → Workers & Pages → your worker → URL
                  </p>
                </div>
                <button
                  onClick={() => setButtonStep(1)}
                  className="text-[10px] text-text-muted underline hover:text-text-main"
                >
                  ← Back to deploy button
                </button>
              </>
            )}

            {error && (
              <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={onClose}
                className="rounded-md px-3 py-1.5 text-xs text-text-muted transition-colors hover:bg-black/5 hover:text-text-main dark:hover:bg-white/5"
              >
                Cancel
              </button>
              {buttonStep === 2 && (
                <Button
                  size="sm"
                  variant="primary"
                  icon="link"
                  onClick={handleConnectButton}
                  disabled={connecting}
                >
                  {connecting ? "Connecting..." : "Connect"}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* ── API Token mode ── */}
        {mode === "api-token" && (
          <div className="space-y-3">
            <p className="text-xs text-text-muted">
              Enter your Cloudflare credentials to automatically deploy the OmniRoute Cloud
              Worker. Your API token is used once for deployment and never stored.
            </p>

            <div>
              <label className="mb-1 block text-xs font-medium text-text-muted">
                Cloudflare Account ID
              </label>
              <input
                type="text"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder="e.g. abcd1234efgh5678..."
                className="w-full rounded-md border border-border bg-bg px-3 py-2 text-xs text-text-main focus:border-primary focus:outline-none"
              />
              <p className="mt-1 text-[10px] text-text-muted">
                Cloudflare Dashboard → right sidebar → Account ID
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-text-muted">
                Cloudflare API Token
              </label>
              <input
                type="password"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder="Token with Workers Scripts:Edit + KV:Edit"
                className="w-full rounded-md border border-border bg-bg px-3 py-2 text-xs text-text-main focus:border-primary focus:outline-none"
              />
              <p className="mt-1 text-[10px] text-text-muted">
                My Profile → API Tokens → Create Token → Custom token with:
                <br />
                Account → Workers Scripts → Edit
                <br />
                Account → Workers KV Storage → Edit
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-text-muted">Worker Name</label>
              <input
                type="text"
                value={workerName}
                onChange={(e) => setWorkerName(e.target.value)}
                placeholder="omniroute-cloud"
                className="w-full rounded-md border border-border bg-bg px-3 py-2 text-xs text-text-main focus:border-primary focus:outline-none"
              />
            </div>

            {error && (
              <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={onClose}
                className="rounded-md px-3 py-1.5 text-xs text-text-muted transition-colors hover:bg-black/5 hover:text-text-main dark:hover:bg-white/5"
              >
                Cancel
              </button>
              <Button
                size="sm"
                variant="primary"
                icon="rocket_launch"
                onClick={handleDeploy}
                disabled={deploying}
              >
                {deploying ? "Deploying..." : "Deploy"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
