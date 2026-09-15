import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  fetchBulkCreation,
  fetchCodePage,
  fetchCodesCount,
  generateCodes,
  normalizePrefix,
  readConfig,
  startRedeemCodeBulkAdd,
  writeConfig,
} from "../utils/bulkDiscountCodes.server";

const CODES_PER_REQUEST = 250;

function newLockId() {
  return `lock-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function donePayload(liveCount, config, extra = {}) {
  return {
    batch: true,
    done: true,
    added: 0,
    codesCount: liveCount,
    codesGenerated: liveCount,
    codesSubmitted: Math.max(config.codesSubmitted ?? 0, liveCount),
    targetCount: config.targetCount ?? liveCount,
    ...extra,
  };
}

async function adminFromRequest(request) {
  try {
    const { admin } = await authenticate.admin(request);
    return admin;
  } catch (e) {
    if (e instanceof Response) {
      throw json(
        { error: "Session expired. Refresh the page and click Resume generation." },
        { status: 401 }
      );
    }
    throw json({ error: e.message || "Authentication failed." }, { status: 401 });
  }
}

export const loader = async () => {
  return json({ error: "Use POST." }, { status: 405 });
};

export const action = async ({ request }) => {
  const admin = await adminFromRequest(request);
  const formData = await request.formData();
  const intent = formData.get("action");

  try {
    if (intent === "exportCodes") {
      const nodeId = formData.get("nodeId");
      const cursor = formData.get("cursor") || null;
      const query = formData.get("query") || "";
      const first = formData.get("first") || "";
      if (!nodeId) return json({ error: "Missing discount id." });
      const page = await fetchCodePage(admin, nodeId, cursor, { query, first });
      return json({ export: true, ...page });
    }

    if (intent === "generateBatch") {
      const nodeId = formData.get("nodeId");
      const prefix = normalizePrefix(formData.get("prefix") || "");
      if (!nodeId || !prefix) return json({ error: "Missing discount or prefix." });

      const config = await readConfig(admin, nodeId);
      const targetCount = config.targetCount ?? 0;
      const live = await fetchCodesCount(admin, nodeId);
      const submittedCount = Math.max(live.count, config.codesSubmitted ?? 0);

      if (targetCount && submittedCount >= targetCount) {
        config.codesGenerated = live.count;
        config.codesSubmitted = submittedCount;
        config.pendingBulkJobId = null;
        config.generationLock = null;
        await writeConfig(admin, nodeId, config);
        return json(donePayload(live.count, config));
      }

      if (config.pendingBulkJobId) {
        const existing = await fetchBulkCreation(admin, config.pendingBulkJobId);
        if (existing && !existing.done) {
          return json({
            batch: true,
            pending: true,
            jobId: existing.id,
            added: 0,
            submitted: 0,
            codesCount: live.count,
            codesGenerated: live.count,
            codesSubmitted: submittedCount,
            targetCount,
          });
        }
        if (!existing) {
          return json({
            batch: true,
            pending: true,
            lostRace: true,
            added: 0,
            codesCount: live.count,
            codesGenerated: live.count,
            codesSubmitted: submittedCount,
            targetCount,
          });
        }
        config.pendingBulkJobId = null;
        config.generationLock = null;
      }

      const lockId = newLockId();
      config.generationLock = lockId;
      config.pendingBulkJobId = lockId;
      await writeConfig(admin, nodeId, config);

      const verify = await readConfig(admin, nodeId);
      if (verify.generationLock !== lockId || verify.pendingBulkJobId !== lockId) {
        return json({
          batch: true,
          pending: true,
          lostRace: true,
          jobId: verify.pendingBulkJobId?.startsWith("gid://") ? verify.pendingBulkJobId : null,
          codesCount: live.count,
          codesGenerated: live.count,
          codesSubmitted: Math.max(verify.codesSubmitted ?? 0, live.count),
          targetCount,
        });
      }

      const remaining = targetCount ? Math.max(0, targetCount - submittedCount) : 0;
      if (!remaining) {
        verify.codesGenerated = live.count;
        verify.codesSubmitted = submittedCount;
        verify.pendingBulkJobId = null;
        verify.generationLock = null;
        await writeConfig(admin, nodeId, verify);
        return json(donePayload(live.count, verify));
      }

      const codes = generateCodes(prefix, Math.min(CODES_PER_REQUEST, remaining));
      const jobId = await startRedeemCodeBulkAdd(admin, nodeId, codes);

      const latest = await readConfig(admin, nodeId);
      latest.pendingBulkJobId = jobId;
      latest.generationLock = lockId;
      latest.codesGenerated = live.count;
      latest.codesSubmitted = submittedCount + codes.length;
      await writeConfig(admin, nodeId, latest);

      return json({
        batch: true,
        pending: true,
        jobId,
        added: 0,
        submitted: codes.length,
        codesCount: live.count,
        codesGenerated: live.count,
        codesSubmitted: latest.codesSubmitted,
        targetCount,
      });
    }

    if (intent === "jobStatus") {
      const nodeId = formData.get("nodeId");
      const jobId = formData.get("jobId");
      if (!nodeId || !jobId) return json({ error: "Missing discount or job id." });

      const [job, live, config] = await Promise.all([
        fetchBulkCreation(admin, jobId),
        fetchCodesCount(admin, nodeId),
        readConfig(admin, nodeId),
      ]);
      if (!job) return json({ error: "Bulk code job was not found." });

      if (job.done) {
        config.pendingBulkJobId = null;
        config.generationLock = null;
        config.codesGenerated = live.count;
        config.codesSubmitted = Math.max(config.codesSubmitted ?? 0, live.count);
        await writeConfig(admin, nodeId, config);
      }

      return json({
        status: true,
        done: !!job.done,
        imported: job.importedCount ?? 0,
        failed: job.failedCount ?? 0,
        codesCount: live.count,
        codesGenerated: live.count,
        codesSubmitted: Math.max(config.codesSubmitted ?? 0, live.count),
        targetCount: config.targetCount ?? live.count,
      });
    }

    return json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    if (err instanceof Response) throw err;
    return json({ error: err.message || "Request failed." }, { status: 500 });
  }
};
