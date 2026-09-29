import crypto from "node:crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY");
}

const apiHeaders = {
  apikey: SUPABASE_SECRET_KEY,
  Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
  "Content-Type": "application/json"
};

const STATUS_PATTERNS = [
  "Decision in Process",
  "Required Reviews Completed",
  "Awaiting Editor Decision",
  "Awaiting Associate Editor Recommendation",
  "Awaiting Reviewer Scores",
  "Awaiting Reviewer Selection",
  "Reviewers Assigned",
  "Reviewer Invited",
  "Review Completed",
  "Reviews Completed",
  "Under Review",
  "With Editor",
  "Editor Assigned",
  "Technical Check",
  "Submitted to Journal",
  "Major Revision",
  "Minor Revision",
  "Accepted",
  "Rejected"
];

function normalizeHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractStatus(text) {
  const lower = text.toLowerCase();
  for (const status of STATUS_PATTERNS) {
    if (lower.includes(status.toLowerCase())) return status;
  }
  const reviewerCounts = text.match(/Reviewer(?:s)?\s+(Invited|Accepted|Completed)\s*[:：]?\s*(\d+)/i);
  if (reviewerCounts) return `${reviewerCounts[1]}: ${reviewerCounts[2]}`;
  return null;
}

function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function rest(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { ...apiHeaders, ...(options.headers || {}) }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function patchPaper(id, body) {
  return rest(`papers?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(body)
  });
}

async function addNotification(paper, oldStatus, newStatus, message) {
  return rest("review_notifications", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      owner_id: paper.owner_id,
      paper_id: paper.id,
      paper_title: paper.title,
      journal: paper.journal || "",
      old_status: oldStatus || null,
      new_status: newStatus || null,
      message
    })
  });
}

async function checkPaper(paper) {
  const now = new Date().toISOString();
  try {
    const res = await fetch(paper.link, {
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ResearchWorkbenchMonitor/1.0)",
        Accept: "text/html,application/xhtml+xml"
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const text = normalizeHtml(html).slice(0, 250000);
    if (!text) throw new Error("Empty page content");

    const newStatus = extractStatus(text);
    const newHash = hashText(text);
    const hasBaseline = !!paper.tracking_hash;
    let changed = false;

    if (hasBaseline) {
      if (newStatus && paper.tracking_status) changed = newStatus !== paper.tracking_status;
      else changed = newHash !== paper.tracking_hash;
    }

    if (changed) {
      const message = newStatus && paper.tracking_status
        ? `外审状态更新：${paper.tracking_status} → ${newStatus}`
        : "外审追踪页面内容发生变化";
      await addNotification(paper, paper.tracking_status, newStatus, message);
    }

    await patchPaper(paper.id, {
      tracking_hash: newHash,
      tracking_status: newStatus,
      tracking_checked_at: now,
      tracking_last_change_at: changed ? now : undefined,
      tracking_error: null
    });

    console.log(`${paper.title}: ${changed ? "changed" : hasBaseline ? "no change" : "baseline saved"}${newStatus ? ` (${newStatus})` : ""}`);
  } catch (err) {
    await patchPaper(paper.id, {
      tracking_checked_at: now,
      tracking_error: String(err.message || err).slice(0, 500)
    });
    console.error(`${paper.title}: ${err.message || err}`);
  }
}

const papers = await rest("papers?select=id,owner_id,title,journal,link,tracking_hash,tracking_status&monitor_enabled=eq.true&status=eq.review&link=not.is.null");
for (const paper of papers || []) {
  if (!paper.link) continue;
  await checkPaper(paper);
}