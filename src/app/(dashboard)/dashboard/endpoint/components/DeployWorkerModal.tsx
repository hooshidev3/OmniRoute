"use client";

import { useState } from "react";
import Button from "@/shared/components/Button";

interface DeployWorkerModalProps {
  onClose: () => void;
  onSuccess: (workerUrl: string, secret: string) => void;
}

export default function DeployWorkerModal({ onClose, onSuccess }: DeployWorkerModalProps) {
  const [accountId, setAccountId] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [workerName, setWorkerName] = useState("routechi-cloud");
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <h3 className="mb-1 text-sm font-semibold text-text-main">
          Auto-Deploy Cloud Worker
        </h3>
        <p className="mb-4 text-xs text-text-muted">
          Enter your Cloudflare credentials to automatically deploy the RouteChi Cloud Worker.
          Your API token is used once for deployment and never stored.
        </p>

        <div className="space-y-3">
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
            <label className="mb-1 block text-xs font-medium text-text-muted">
              Worker Name
            </label>
            <input
              type="text"
              value={workerName}
              onChange={(e) => setWorkerName(e.target.value)}
              placeholder="routechi-cloud"
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
      </div>
    </div>
  );
}
