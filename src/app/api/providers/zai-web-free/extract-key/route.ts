import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { logger } from "@omniroute/open-sse/utils/logger.ts";
import {
  extractAliyunKeys,
  verifyKeys,
} from "@omniroute/open-sse/executors/zai-web-free/key-extractor.ts";
import {
  updateSettings,
  initSettingsStore,
} from "@omniroute/open-sse/executors/zai-web-free/settings-store.ts";

const log = logger("ZAI-WEB-FREE-ADMIN");

/**
 * POST /api/providers/zai-web-free/extract-key
 *
 * Automatically extracts the Aliyun AccessKey and SecretKey from the
 * AliyunCaptcha.js bundle served by alicdn, then SAVES them to the
 * RouteChi SQLite database (key_value table, namespace='zai_web_free').
 *
 * After extraction, the keys are immediately available for captcha
 * verification — no manual "Save" button click required.
 *
 * Flow:
 *   1. Launch headless Chromium, load chat.z.ai
 *   2. Intercept InitCaptchaV3/VerifyCaptchaV3 requests
 *   3. Extract AccessKeyId from the POST body
 *   4. Verify the SecretKey by checking the HMAC-SHA1 signature
 *   5. SAVE both keys to the DB via updateSettings()
 *
 * Returns:
 *   200: { success: true, accessKey, secretKey, verified, saved, source, timestamp }
 *   500: { error: "Extraction failed: <message>" }
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const dataDir =
    process.env.OMNIROUTE_DATA_DIR || (process.env.HOME ? `${process.env.HOME}/.omniroute` : ".");
  initSettingsStore(`${dataDir}/omniroute.db`);

  log.info?.("extract_key.start");

  try {
    // Step 1: Extract keys via browser interception
    const result = await extractAliyunKeys();

    if (!result.accessKey) {
      log.warn?.("extract_key.not_found", { candidates: result.candidates });
      return NextResponse.json(
        {
          success: false,
          error: `Could not extract AccessKey from AliyunCaptcha.js (${result.candidates} candidates tried). The AES obfuscation constants may have changed.`,
          candidates: result.candidates,
        },
        { status: 500 }
      );
    }

    // Step 2: Verify the keys work
    let verified = false;
    if (result.secretKey) {
      log.info?.("extract_key.verifying", {
        accessKey: result.accessKey.slice(0, 8) + "...",
      });
      verified = await verifyKeys(result.accessKey, result.secretKey);
      log.info?.("extract_key.verified", { verified });
    }

    // Step 3: Auto-save the extracted keys to the database.
    // Only save if verification succeeded OR if we have no secretKey (still
    // save the accessKey — the user can manually set the secretKey later).
    // We always save the accessKey; secretKey is saved only if present.
    const updates: { accessKey: string; secretKey?: string } = {
      accessKey: result.accessKey,
    };
    if (result.secretKey) {
      updates.secretKey = result.secretKey;
    }

    const saved = updateSettings(updates);
    log.info?.("extract_key.saved", {
      accessKey: saved.accessKey.slice(0, 8) + "...",
      secretKey: saved.secretKey ? saved.secretKey.slice(0, 8) + "..." : "not set",
      verified,
    });

    log.info?.("extract_key.complete", {
      accessKey: result.accessKey.slice(0, 8) + "...",
      secretKey: result.secretKey ? result.secretKey.slice(0, 8) + "..." : "not found",
      verified,
      saved: true,
    });

    return NextResponse.json({
      success: true,
      accessKey: result.accessKey,
      secretKey: result.secretKey,
      verified,
      saved: true,
      source: result.source,
      timestamp: result.timestamp,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error?.("extract_key.failed", { error: message });
    return NextResponse.json({ error: `Extraction failed: ${message}` }, { status: 500 });
  }
}
