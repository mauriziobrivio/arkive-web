/* ============================================================
   ARKIVE Web Companion — shared client module (WS1)

   Supabase client + per-page auth guard + boot sequence +
   canonical backend constants (Phase 0 recon, adopted as spec
   by Decision #237). Placeholder modules at the bottom are
   filled in WS3 (items/media) and WS5 (delivery).

   The publishable key below is public-by-design — RLS is the
   security boundary, same as the iOS app. Service-role keys
   must never appear anywhere in this repo.
   ============================================================ */

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

export const SUPABASE_URL = "https://skrwdjxgvryodsxusqia.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_HfoE9g7rCsCTem3gas_CkA_fu31WK3W";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

/* ------------------------------------------------------------
   Canonical backend string values (Phase 0 §R2 — exact case is
   load-bearing; three iOS bugs shipped from case mismatches).
   ------------------------------------------------------------ */

export const MAILBOX = Object.freeze({
  myCapsules: "My Capsules",
  received: "Received",
});

export const STATUS = Object.freeze({
  draft: "Draft",
  scheduled: "Scheduled",
  delivered: "Delivered",
  opened: "Opened",
});

export const STATE = Object.freeze({
  draft: "draft",
  sealed: "sealed",
  delivered: "delivered",
  opened: "opened",
});

export const DIRECTION = Object.freeze({
  sent: "Sent",
  received: "Received",
});

export const DELIVERY_TYPE = Object.freeze({
  specificDate: "Specific Date",
  ageMilestone: "Age Milestone",
  whenTheyJoinArkive: "When They Join Arkive",
  manualDelivery: "Manual Delivery",
  openEnded: "Open-Ended",
});

export const DELIVERY_RULE = Object.freeze({
  date: "date",
  manual: "manual",
  onJoin: "on_join",
  openEnded: "open_ended",
});

export const DISPATCH_STATE = Object.freeze({
  pending: "Pending",
  ready: "Ready",
  sent: "Sent",
  failed: "Failed", // written by the Edge Function on send failure; manual retry only
  manual: "Manual",
});

export const DISPATCH_METHOD = Object.freeze({
  email: "Email",
  inApp: "In-App",
  manual: "Manual",
});

export const RECIPIENT_ROUTING_STATE = Object.freeze({
  localProfileOnly: "Local Profile Only",
  awaitingRecipientAccount: "Awaiting Recipient Account",
  linkedToRecipientAccount: "Linked To Recipient Account",
  routedToRecipientInbox: "Routed To Recipient Inbox",
});

export const CONTRIBUTOR_STATUS = Object.freeze({
  invited: "Invited",
  accepted: "Accepted",
  declined: "Declined",
  removed: "Removed",
});

export const CONTRIBUTOR_ROLE = Object.freeze({
  contributor: "Contributor",
});

export const ITEM_KIND = Object.freeze({
  photo: "Photo",
  video: "Video",
  audio: "Audio",
  letter: "Letter",
  textNote: "Text Note", // legacy render-only (Decision #229) — never write
  quickMoment: "Quick Moment",
});

export const BUCKET = Object.freeze({
  momentsMedia: "moments-media",        // inline capsule photos (primary)
  photos: "arkive-photos",              // covers ({uid}/covers/), avatars, legacy photos
  videos: "arkive-videos",              // item videos (mp4/quicktime only)
  audio: "arkive-audio",                // item audio (m4a)
  capsuleCovers: "arkive-capsule-covers", // cover video + poster
  profileSnapshots: "arkive-profile-snapshots",
});

/* ------------------------------------------------------------
   Freemium gate (Decision #237: is_comped + Free walls;
   web sells nothing).
   ------------------------------------------------------------ */

export const FREE_LIMITS = Object.freeze({
  maxSealedCapsules: 1,
  maxRevealHorizonYears: 2,
  maxNamedBeneficiaries: 0,
});

export const GATE_COPY = "Manage your plan in the Arkive app.";

const ENTITLEMENT_KEY = "arkive.isComped";

export function isComped() {
  return sessionStorage.getItem(ENTITLEMENT_KEY) === "true";
}

/* ------------------------------------------------------------
   Auth guard — every signed-in page calls requireSession() (or
   bootSession()) as its first act; index.html calls
   redirectIfSignedIn() instead.
   ------------------------------------------------------------ */

export async function requireSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.replace("./index.html");
    throw new Error("arkive: no session — redirecting to sign-in");
  }
  // Sign-out in this or another tab bounces every page to login.
  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") window.location.replace("./index.html");
  });
  document.body.removeAttribute("hidden");
  return session;
}

export async function redirectIfSignedIn() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) window.location.replace("./capsules.html");
}

export async function signOutAndRedirect() {
  try {
    await supabase.auth.signOut();
  } catch (err) {
    console.error("arkive: signOut failed", err);
  } finally {
    sessionStorage.removeItem(ENTITLEMENT_KEY);
    window.location.replace("./index.html");
  }
}

/* ------------------------------------------------------------
   Boot sequence (Phase 0 §R1 minimal boot, iOS parity):
   1. accounts row read (insert-if-missing, email-drift update)
   2. claim_my_pending_invitations() RPC (idempotent)
   3. stash entitlement (is_comped) for the gate helpers
   ------------------------------------------------------------ */

export async function bootSession() {
  const session = await requireSession();
  const account = await ensureAccount(session.user);
  await claimPendingInvitations();
  sessionStorage.setItem(ENTITLEMENT_KEY, String(account?.is_comped === true));
  return { session, user: session.user, account };
}

/** Mirrors iOS ensureAccountAndFetchDisplayName (ARKIVEApp.swift):
 *  select own accounts row; insert if missing; update email if it
 *  drifted. Never writes is_comped (server-protected column). */
async function ensureAccount(user) {
  try {
    const { data: row, error } = await supabase
      .from("accounts")
      .select("id, display_name, email, is_comped")
      .eq("id", user.id)
      .maybeSingle();
    if (error) throw error;

    if (!row) {
      // Normally created by the signup trigger; belt-and-suspenders parity.
      const displayName = (user.email ?? "").split("@")[0] || "You";
      const { data: inserted, error: insertError } = await supabase
        .from("accounts")
        .insert({ id: user.id, email: user.email, display_name: displayName })
        .select("id, display_name, email, is_comped")
        .single();
      if (insertError) throw insertError;
      return inserted;
    }

    if (user.email && row.email !== user.email) {
      await supabase.from("accounts").update({ email: user.email }).eq("id", user.id);
      row.email = user.email;
    }
    return row;
  } catch (err) {
    console.error("arkive: ensureAccount failed (continuing with session identity)", err);
    return null;
  }
}

/** SECURITY DEFINER RPC; claims 'Invited' contributor rows for the
 *  caller's email. Idempotent; failures are non-fatal at boot. */
async function claimPendingInvitations() {
  try {
    const { data, error } = await supabase.rpc("claim_my_pending_invitations");
    if (error) throw error;
    if (Array.isArray(data) && data.length > 0) {
      console.info(`arkive: claimed ${data.length} pending contributor invitation(s)`);
    }
  } catch (err) {
    console.error("arkive: claim_my_pending_invitations failed (non-fatal)", err);
  }
}

/* ------------------------------------------------------------
   Shell chrome wiring for signed-in pages.
   ------------------------------------------------------------ */

export function wireShell({ user, account }) {
  const name = account?.display_name || user?.email || "";
  document.querySelectorAll("[data-account-name]").forEach((el) => {
    el.textContent = name;
  });
  document.querySelectorAll("[data-account-email]").forEach((el) => {
    el.textContent = user?.email ?? "";
  });
  document.querySelectorAll("[data-sign-out]").forEach((el) => {
    el.addEventListener("click", () => signOutAndRedirect());
  });
}

/* ------------------------------------------------------------
   Capsule read model (WS2) — mirrors ArkiveCapsulesStore.
   ------------------------------------------------------------ */

/** The canonical select list the iOS store uses (ArkiveCapsulesStore
 *  canonicalCapsulesSelect) — keep web and iOS reading the same shape. */
export const CAPSULES_SELECT = [
  "id", "creator_user_id", "shared_capsule_id", "mailbox", "state", "status", "title",
  "sender_display_name_snapshot", "recipient_name", "delivery_type", "delivery_rule",
  "created_at", "sealed_at", "release_at", "opened_at", "recipient_age_target",
  "cover_image_name", "is_cover_spatial", "cover_storage_path",
  "cover_video_storage_path", "cover_video_thumbnail_path", "reveal_message",
  "letter_count", "moment_count", "items_json", "sender_profile_id", "recipient_profile_id",
  "recipient_relationship_snapshot", "recipient_account_id", "recipient_contact_hint",
  "guest_delivery_email", "recipient_name_snapshot",
  "recipient_delivery_email_snapshot", "recipient_avatar_snapshot_path",
  "recipient_routing_state", "dispatch_state", "dispatch_method",
  "delivery_prepared_at", "delivery_attempted_at", "delivery_completed_at",
  "delivery_failure_reason", "delivery_destination", "direction", "last_modified_at",
  "draft_step", "music_song_id", "music_song_title", "music_artist_name",
  "music_artwork_url", "is_collaborative", "contributor_count", "recipient_dismissed_at",
].join(", ");

/** The two canonical mailbox queries + the contributor fetch, exactly as iOS
 *  runs them (outgoing: creator + not-Received; incoming: recipient + Received;
 *  contributing: Accepted memberships → capsule rows via RLS). */
export async function fetchCapsuleRows(userId) {
  const [outgoing, incoming, contributing] = await Promise.all([
    supabase.from("capsules").select(CAPSULES_SELECT)
      .eq("creator_user_id", userId).neq("mailbox", MAILBOX.received)
      .order("created_at", { ascending: true }).limit(500),
    supabase.from("capsules").select(CAPSULES_SELECT)
      .eq("recipient_account_id", userId).eq("mailbox", MAILBOX.received)
      .order("created_at", { ascending: true }).limit(500),
    fetchContributingRows(userId),
  ]);
  if (outgoing.error) throw outgoing.error;
  if (incoming.error) throw incoming.error;
  return { outgoing: outgoing.data ?? [], incoming: incoming.data ?? [], contributing };
}

async function fetchContributingRows(userId) {
  try {
    const { data: memberships, error } = await supabase
      .from("capsule_contributors").select("capsule_id")
      .eq("user_id", userId).eq("status", CONTRIBUTOR_STATUS.accepted);
    if (error) throw error;
    const ids = (memberships ?? []).map((m) => m.capsule_id);
    if (ids.length === 0) return [];
    const { data, error: capsulesError } = await supabase
      .from("capsules").select(CAPSULES_SELECT)
      .in("id", ids).order("created_at", { ascending: true });
    if (capsulesError) throw capsulesError;
    return data ?? [];
  } catch (err) {
    console.error("arkive: contributing-capsules fetch failed (non-fatal)", err);
    return [];
  }
}

/** Client-side mailbox predicates (iOS CapsulesView/store parity):
 *  drafts = status 'Draft'; received filters recipient soft-dismiss
 *  (Decision #153); contributing = Accepted-membership rows not my own. */
export function splitMailboxes({ outgoing, incoming, contributing }) {
  const drafts = outgoing.filter((r) => r.status === STATUS.draft);
  const mine = outgoing.filter((r) => r.status !== STATUS.draft);
  const received = incoming.filter(
    (r) => (r.direction === DIRECTION.received || r.mailbox === MAILBOX.received)
      && r.recipient_dismissed_at == null,
  );
  const ownIds = new Set(outgoing.map((r) => r.id));
  const contributingOnly = contributing.filter((r) => !ownIds.has(r.id));
  return { drafts, mine, received, contributing: contributingOnly };
}

/** iOS default list order ("Opening Soon"): ascending by
 *  release_at ?? sealed_at ?? created_at. */
export function sortOpeningSoon(rows) {
  const key = (r) => new Date(r.release_at ?? r.sealed_at ?? r.created_at).getTime();
  return [...rows].sort((a, b) => key(a) - key(b));
}

export function fmtMedium(value) {
  if (!value) return "";
  return new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/* —— card copy, ported verbatim from CapsulesView.swift —— */

export function capsulePrimaryDateLine(row) {
  if (row.status === STATUS.opened && row.opened_at) return `Opened ${fmtMedium(row.opened_at)}`;
  if (row.status === STATUS.delivered) {
    if (row.delivery_completed_at) return `Delivered ${fmtMedium(row.delivery_completed_at)}`;
    if (row.release_at) return `Delivered ${fmtMedium(row.release_at)}`;
    return "Delivered";
  }
  switch (row.delivery_type) {
    case DELIVERY_TYPE.specificDate:
      return row.release_at ? `Opens ${fmtMedium(row.release_at)}` : "Specific date";
    case DELIVERY_TYPE.ageMilestone:
      if (row.recipient_age_target != null && row.release_at) {
        return `Opens at ${row.recipient_age_target} · ${fmtMedium(row.release_at)}`;
      }
      if (row.recipient_age_target != null) return `Opens at ${row.recipient_age_target}`;
      return "Age milestone";
    case DELIVERY_TYPE.whenTheyJoinArkive: return "Opens when they join Arkive";
    case DELIVERY_TYPE.manualDelivery: return "Manual delivery";
    case DELIVERY_TYPE.openEnded: return "Open-Ended";
    default: return "";
  }
}

export function capsuleRoutingLine(row) {
  if (row.status === STATUS.opened) return "";
  if (row.status === STATUS.delivered) {
    return row.direction === DIRECTION.received ? "Awaiting open" : "Delivered to recipient";
  }
  switch (row.delivery_type) {
    case DELIVERY_TYPE.whenTheyJoinArkive:
      return row.dispatch_state === DISPATCH_STATE.sent ? "Release condition met" : "Waiting for Arkive account";
    case DELIVERY_TYPE.specificDate:
    case DELIVERY_TYPE.ageMilestone:
      return "Scheduled for future release";
    case DELIVERY_TYPE.manualDelivery:
    case DELIVERY_TYPE.openEnded:
      return row.dispatch_state === DISPATCH_STATE.manual ? "Manually released" : "Manual release required";
    default: return "";
  }
}

export function capsuleContentSummary(row) {
  const lc = row.letter_count ?? 0;
  const mc = row.moment_count ?? 0;
  const letters = `${lc} ${lc === 1 ? "letter" : "letters"}`;
  const moments = `${mc} ${mc === 1 ? "moment" : "moments"}`;
  if (lc > 0 && mc > 0) return `${letters} • ${moments}`;
  if (mc > 0) return moments;
  return letters;
}

/** WS2 static cover: cover-video poster wins, then cover photo, else null
 *  (caller renders the monogram placeholder). */
export async function capsuleCoverUrl(row) {
  if (row.cover_video_thumbnail_path) {
    const url = await ArkiveStorageHelpers.download(BUCKET.capsuleCovers, row.cover_video_thumbnail_path);
    if (url) return url;
  }
  if (row.cover_storage_path) {
    const url = await ArkiveStorageHelpers.download(BUCKET.photos, row.cover_storage_path);
    if (url) return url;
  }
  return null;
}

/* ------------------------------------------------------------
   Placeholder modules — contracts documented in the Phase 0
   recon report; implementations land in later workstreams.
   ------------------------------------------------------------ */

/** items_json codec (WS3 read side). Keys are load-bearing in 13 storage
 *  RLS policies — read defensively, never reshape/rename on the way
 *  through. encode() lands in WS5 (create + seal; strips photoData,
 *  writes BOTH photoStoragePath and image_storage_path on photos). */
export const ArkiveItemsCodec = {
  /** Raw items_json array → normalized items, sorted by sort_index. */
  decode(itemsJson) {
    if (!Array.isArray(itemsJson)) return [];
    return itemsJson
      .map((raw, index) => ({
        id: raw.id ?? null,
        kind: raw.kind ?? "",
        title: raw.title ?? "",
        subtitle: raw.subtitle ?? "",
        caption: raw.caption ?? null,
        momentDate: raw.moment_date ?? null,
        sortIndex: typeof raw.sort_index === "number" ? raw.sort_index : index,
        isSpatial: raw.isSpatial === true,
        imageStoragePath: raw.image_storage_path ?? null,
        photoStoragePath: raw.photoStoragePath ?? null,
        photoData: raw.photoData ?? null,
        videoStoragePath: raw.videoStoragePath ?? null,
        videoFileName: raw.videoFileName ?? null,
        audioStoragePath: raw.audioStoragePath ?? null,
      }))
      .sort((a, b) => a.sortIndex - b.sortIndex);
  },
  encode() { throw new Error("ArkiveItemsCodec.encode arrives in WS5 (create + seal)"); },
};

/** Photo bytes, iOS resolution order (CapsulePhotoDetailView): inline
 *  photoData first (legacy base64, always renderable), then storage —
 *  moments-media, then arkive-photos (P1 fallback order). */
export async function itemPhotoUrl(item) {
  if (item.photoData) return `data:image/jpeg;base64,${item.photoData}`;
  const path = item.imageStoragePath ?? item.photoStoragePath;
  if (!path) return null;
  const fromMoments = await ArkiveStorageHelpers.download(BUCKET.momentsMedia, path);
  if (fromMoments) return fromMoments;
  return ArkiveStorageHelpers.download(BUCKET.photos, path);
}

/** Single-row fetch under RLS (detail renders from the canonical row —
 *  Phase-0: no extra fetch beyond the store shape). */
export async function fetchCapsuleById(id) {
  const { data, error } = await supabase
    .from("capsules").select(CAPSULES_SELECT).eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

/** List-card routing (WS3): drafts stay inert until web create (WS5);
 *  received-but-unopened goes to the ceremony page; everything else
 *  (owned, contributing, opened-received) goes to read-only detail. */
export function capsuleHrefFor(row) {
  if (row.status === STATUS.draft) return null;
  const isReceived = row.direction === DIRECTION.received || row.mailbox === MAILBOX.received;
  if (isReceived && row.status !== STATUS.opened) {
    return `./open.html?id=${encodeURIComponent(row.id)}`;
  }
  return `./capsule.html?id=${encodeURIComponent(row.id)}`;
}

/** Renderer fallback chain (Decision #115): display-only — never written. */
export function itemDisplayTitle(item) {
  if (item.title) return item.title;
  if (item.momentDate) {
    const noun = item.kind === ITEM_KIND.video ? "Video" : item.kind === ITEM_KIND.audio ? "Recording" : "Photo";
    return `${noun} from ${fmtMedium(item.momentDate)}`;
  }
  return "";
}

/* ------------------------------------------------------------
   Shared per-kind item renderers (capsule.html detail + open.html
   reveal). textContent everywhere — no HTML injection path.
   ------------------------------------------------------------ */

export function createEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Build DOM nodes for decoded items, in the given (sort_index) order. */
export function renderCapsuleItems(container, items) {
  for (const item of items) {
    switch (item.kind) {
      case ITEM_KIND.photo: container.appendChild(photoItemNode(item)); break;
      case ITEM_KIND.video: container.appendChild(videoItemNode(item)); break;
      case ITEM_KIND.audio: container.appendChild(audioItemNode(item)); break;
      case ITEM_KIND.letter: container.appendChild(letterItemNode(item, "Letter")); break;
      case ITEM_KIND.textNote: container.appendChild(letterItemNode(item, "Note")); break;
      default: container.appendChild(genericItemNode(item)); break;
    }
  }
}

function photoItemNode(item) {
  const figure = createEl("figure", "item-figure");
  const frame = createEl("div", "item-media-frame");
  figure.appendChild(frame);
  itemPhotoUrl(item).then((url) => {
    if (!url) { frame.replaceWith(unavailableCard("This photo isn’t available.")); return; }
    const img = document.createElement("img");
    img.alt = itemDisplayTitle(item);
    img.loading = "lazy";
    img.src = url;
    frame.appendChild(img);
  });
  appendItemMeta(figure, item);
  return figure;
}

function videoItemNode(item) {
  const figure = createEl("figure", "item-figure");
  if (!item.videoStoragePath) {
    // Legacy device-local era (videoFileName only) — bytes never reached
    // the server; a broken player would be undignified.
    figure.appendChild(unavailableCard("This video isn’t available on the web.", "It lives in the capsule on iOS."));
    appendItemMeta(figure, item);
    return figure;
  }
  const frame = createEl("div", "item-media-frame");
  figure.appendChild(frame);
  ArkiveStorageHelpers.signedVideoUrl(item.videoStoragePath).then((url) => {
    if (!url) { frame.replaceWith(unavailableCard("This video isn’t available right now.")); return; }
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    // #t=0.001 surfaces frame zero as the poster (no item thumbnails exist).
    video.src = `${url}#t=0.001`;
    // Stall watchdog: streaming is primary; if no metadata arrives in time,
    // self-heal via authenticated download → blob URL (≤100MB bucket cap).
    const fallback = setTimeout(async () => {
      const blobUrl = await ArkiveStorageHelpers.download(BUCKET.videos, item.videoStoragePath);
      if (blobUrl) {
        video.src = `${blobUrl}#t=0.001`;
      } else {
        frame.replaceWith(unavailableCard("This video isn’t available right now."));
      }
    }, 5000);
    video.addEventListener("loadedmetadata", () => clearTimeout(fallback), { once: true });
    frame.appendChild(video);
  });
  appendItemMeta(figure, item);
  return figure;
}

function audioItemNode(item) {
  const card = createEl("div", "card plain-card audio-card");
  card.appendChild(createEl("span", "micro-label", "Voice"));
  const title = itemDisplayTitle(item);
  if (title) card.appendChild(createEl("p", "item-caption-line", title));
  const audio = document.createElement("audio");
  audio.controls = true;
  audio.preload = "metadata";
  card.appendChild(audio);
  ArkiveStorageHelpers.download(BUCKET.audio, item.audioStoragePath).then((url) => {
    if (!url) { card.replaceWith(unavailableCard("This recording isn’t available right now.")); return; }
    audio.src = url;
  });
  appendItemCaptionAndDate(card, item);
  return card;
}

function letterItemNode(item, label) {
  const card = createEl("div", "letter-card");
  card.appendChild(createEl("span", "micro-label", label));
  if (item.title) card.appendChild(createEl("h2", "letter-title", item.title));
  // verbatim — no trimming/normalizing (sharp edge #7)
  card.appendChild(createEl("div", "letter-body", item.subtitle));
  appendItemCaptionAndDate(card, item);
  return card;
}

function genericItemNode(item) {
  const card = createEl("div", "card plain-card");
  if (item.kind) card.appendChild(createEl("span", "micro-label", item.kind));
  const title = itemDisplayTitle(item);
  if (title) card.appendChild(createEl("p", "item-caption-line", title));
  if (item.subtitle) card.appendChild(createEl("p", "item-side-thought", item.subtitle));
  return card;
}

function unavailableCard(message, hint) {
  const card = createEl("div", "card placeholder-card");
  card.appendChild(createEl("p", "empty-title", message));
  if (hint) card.appendChild(createEl("p", "empty-hint", hint));
  return card;
}

function appendItemMeta(node, item) {
  const title = itemDisplayTitle(item);
  if (title) node.appendChild(createEl("p", "item-caption-line", title));
  appendItemCaptionAndDate(node, item);
}

function appendItemCaptionAndDate(node, item) {
  if (item.caption) node.appendChild(createEl("p", "item-side-thought", item.caption));
  if (item.momentDate) node.appendChild(createEl("p", "item-date", fmtMedium(item.momentDate)));
}

/* ------------------------------------------------------------
   Ceremony writes (WS4) — recipient-side, COLUMN-ONLY updates.
   The enforce_capsule_column_authority trigger allows recipients
   exactly 7 columns; we touch 4. Never send a full row. The extra
   recipient_account_id filter makes a non-recipient call a no-op.
   ------------------------------------------------------------ */

export const ArkiveCeremonyWrites = {
  /** iOS onCeremonyEntered parity: every entry, first time and revisits. */
  async touchLastViewed(capsuleId, userId) {
    const { error } = await supabase.from("capsules")
      .update({ last_viewed_at: new Date().toISOString() })
      .eq("id", capsuleId).eq("recipient_account_id", userId);
    if (error) console.error("arkive: last_viewed_at write failed", error);
  },
  /** iOS onBeganOpening parity: first seal-contact; idempotent. */
  async markBeganOpening(capsuleId, userId) {
    const { error } = await supabase.from("capsules")
      .update({ has_began_opening: true })
      .eq("id", capsuleId).eq("recipient_account_id", userId);
    if (error) console.error("arkive: has_began_opening write failed", error);
  },
  /** iOS onMarkOpened parity: the PAIRED completion write — both columns
   *  in one update, exact 'Opened' literal. */
  async markOpened(capsuleId, userId) {
    const { error } = await supabase.from("capsules")
      .update({ opened_at: new Date().toISOString(), status: STATUS.opened })
      .eq("id", capsuleId).eq("recipient_account_id", userId);
    if (error) { console.error("arkive: opened_at/status paired write failed", error); return false; }
    return true;
  },
};

/** Storage helpers. download() is live (WS2 — covers); signed-URL video
 *  streaming lands in WS3 (Decision #237).
 *  Upload path templates for WS5 (uid lowercase, always): moments-media
 *  `{uid}/photos/{ts}_{suffix}.jpg` · arkive-videos `{uid}/videos/{ts}_{suffix}.mp4`
 *  · arkive-audio `{uid}/audio/{momentID}.m4a` · covers
 *  `{uid}/covers/{capsuleID}.jpg` (arkive-photos) · cover video
 *  `{uid}/{capsuleID}/video.mp4` + `poster.jpg` (arkive-capsule-covers). */
const objectUrlCache = new Map();

export const ArkiveStorageHelpers = {
  /** Authenticated download → object URL (cached per bucket/path).
   *  Returns null on miss/denial — callers render their fallback. */
  async download(bucket, path) {
    if (!path) return null;
    const key = `${bucket}/${path}`;
    if (objectUrlCache.has(key)) return objectUrlCache.get(key);
    try {
      const { data, error } = await supabase.storage.from(bucket).download(path);
      if (error) throw error;
      const url = URL.createObjectURL(data);
      objectUrlCache.set(key, url);
      return url;
    } catch (err) {
      console.warn(`arkive: storage download miss ${key}`, err?.message ?? err);
      return null;
    }
  },
  /** Short-TTL signed URL for video streaming (Decision #237) — same RLS
   *  boundary as download(); the sign requires SELECT on the object.
   *  Cached per path with a safety margin before expiry. */
  async signedVideoUrl(path, expiresInSeconds = 3600) {
    if (!path) return null;
    const cached = signedUrlCache.get(path);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.url;
    try {
      const { data, error } = await supabase.storage
        .from(BUCKET.videos).createSignedUrl(path, expiresInSeconds);
      if (error) throw error;
      signedUrlCache.set(path, {
        url: data.signedUrl,
        expiresAt: Date.now() + expiresInSeconds * 1000,
      });
      return data.signedUrl;
    } catch (err) {
      console.warn(`arkive: signed-url miss ${BUCKET.videos}/${path}`, err?.message ?? err);
      return null;
    }
  },
};

const signedUrlCache = new Map();

/** TODO(WS5) — delivery engine.
 *  Sender-side sweep (web runs it per Decision #237) + Deliver Now:
 *  sender row UPDATE (full delivery field set) → Received row INSERT
 *  (new UUID; mirror trigger backfills; 23505 = no-op) → invoke
 *  send-capsule-emails {capsule_id}, parse {success} strictly.
 *  email_notification_sent is server-set — never write it. */
export const ArkiveDeliveryEngine = {
  runSenderSweep() { throw new Error("ArkiveDeliveryEngine arrives in WS5"); },
  deliverNow() { throw new Error("ArkiveDeliveryEngine arrives in WS5"); },
};
