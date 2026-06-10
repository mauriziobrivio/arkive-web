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
  /** Normalized items → the EXACT raw shape iOS writes. Keys are
   *  load-bearing in 13 storage RLS policies. Photos carry BOTH path
   *  keys; photoData/base64 is stripped by construction
   *  (itemsStrippingBinaryData parity); letters are inline-only. */
  encode(items) {
    return items.map((item, index) => {
      const base = {
        id: item.id,
        kind: item.kind,
        title: item.title ?? "",
        subtitle: item.subtitle ?? "",
        sort_index: index,
      };
      if (item.momentDate) base.moment_date = item.momentDate;
      switch (item.kind) {
        case ITEM_KIND.photo:
          return {
            ...base,
            photoStoragePath: item.photoStoragePath ?? item.imageStoragePath,
            image_storage_path: item.imageStoragePath ?? item.photoStoragePath,
          };
        case ITEM_KIND.video:
          return { ...base, videoStoragePath: item.videoStoragePath };
        case ITEM_KIND.audio:
          return { ...base, audioStoragePath: item.audioStoragePath };
        default:
          return base; // Letter (+ tolerated kinds): inline content only
      }
    });
  },
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

/* ------------------------------------------------------------
   WS5 — create + seal + deliver.
   ------------------------------------------------------------ */

/* —— freemium create-walls (client-authoritative; #237/#239) —— */

export function sealGate({ sealedCount, releaseDate, now = new Date() }) {
  if (isComped()) return { allowed: true };
  if (sealedCount >= FREE_LIMITS.maxSealedCapsules) {
    return { allowed: false, reason: `Your free capsule is sealed. ${GATE_COPY}` };
  }
  if (releaseDate) {
    const cap = new Date(now);
    cap.setFullYear(cap.getFullYear() + FREE_LIMITS.maxRevealHorizonYears);
    if (releaseDate > cap) {
      return { allowed: false, reason: `Free capsules open within two years. ${GATE_COPY}` };
    }
  }
  return { allowed: true };
}

export async function countOwnSealedCapsules(userId) {
  const { count, error } = await supabase
    .from("capsules").select("id", { count: "exact", head: true })
    .eq("creator_user_id", userId).neq("mailbox", MAILBOX.received).neq("status", STATUS.draft);
  if (error) throw error;
  return count ?? 0;
}

/* —— uploads (private buckets; uid prefix stays lowercase) —— */

export const VIDEO_LIMIT_BYTES = Object.freeze({
  free: 300 * 1024 * 1024,   // Decision #239
  paid: 1024 * 1024 * 1024,  // = the bucket's hard cap
});
const AUDIO_LIMIT_BYTES = 25 * 1024 * 1024; // bucket cap

let uploadsInFlight = 0;
export function uploadsPending() { return uploadsInFlight > 0; }

/** Keep-tab-open guard while uploads run (web analog of iOS fix #7 —
 *  no background-session rescue exists in a browser either). */
export function wireUploadGuard() {
  window.addEventListener("beforeunload", (event) => {
    if (uploadsInFlight > 0) { event.preventDefault(); event.returnValue = ""; }
  });
}

async function uploadToBucket(bucket, path, blob, { contentType, cacheControl, upsert = false }) {
  uploadsInFlight += 1;
  try {
    const { error } = await supabase.storage.from(bucket).upload(path, blob, {
      contentType, upsert, ...(cacheControl ? { cacheControl } : {}),
    });
    if (error) throw error;
    return path;
  } finally {
    uploadsInFlight -= 1;
  }
}

async function recompressImage(file, { maxDimension = null, quality = 0.85 } = {}) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  let { width, height } = bitmap;
  if (maxDimension && Math.max(width, height) > maxDimension) {
    const scale = maxDimension / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("image encode failed"))), "image/jpeg", quality);
  });
}

const randomSuffix = () => Math.random().toString(16).slice(2, 10);
const fileExtension = (name) => (name.split(".").pop() ?? "").toLowerCase();
const fileMomentDate = (file) => new Date(file.lastModified || Date.now()).toISOString();

export const ArkiveUploads = {
  /** Photo → moments-media, JPEG q0.85 + 480px thumb q0.75 (iOS parity). */
  async photo(file, userId) {
    const itemId = crypto.randomUUID();
    const stem = `${userId}/photos/${Date.now()}_${randomSuffix()}`;
    const main = await recompressImage(file, { quality: 0.85 });
    const thumb = await recompressImage(file, { maxDimension: 480, quality: 0.75 });
    const storagePath = await uploadToBucket(BUCKET.momentsMedia, `${stem}.jpg`, main, { contentType: "image/jpeg" });
    const thumbnailPath = await uploadToBucket(BUCKET.momentsMedia, `${stem}_thumb.jpg`, thumb, { contentType: "image/jpeg" });
    return { itemId, storagePath, thumbnailPath, mimeType: "image/jpeg", fileSizeBytes: main.size, momentDate: fileMomentDate(file) };
  },

  /** Video → arkive-videos, tier-gated (Free 300MB / Paid 1GB, #239),
   *  mp4/quicktime only — the bucket rejects everything else. No
   *  transcode on web; HEVC ships with an honest note (brief default). */
  async video(file, userId, { isPaid }) {
    const ext = fileExtension(file.name);
    const contentType = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime" }[ext];
    if (!contentType) throw new Error("Videos must be .mp4 or .mov — other formats can’t be stored.");
    const limit = isPaid ? VIDEO_LIMIT_BYTES.paid : VIDEO_LIMIT_BYTES.free;
    if (file.size > limit) {
      const mb = Math.round(limit / 1048576);
      throw new Error(`This video is over the ${mb >= 1024 ? "1 GB" : `${mb} MB`} limit. Try a shorter clip or a smaller export.`);
    }
    const itemId = crypto.randomUUID();
    const storagePath = await uploadToBucket(
      BUCKET.videos,
      `${userId}/videos/${Date.now()}_${randomSuffix()}.${ext === "m4v" ? "mp4" : ext}`,
      file, { contentType },
    );
    return { itemId, storagePath, mimeType: contentType, fileSizeBytes: file.size, momentDate: fileMomentDate(file), quicktime: contentType === "video/quicktime" };
  },

  /** Audio → arkive-audio, m4a/mp3 FILE UPLOAD ONLY (no web recording —
   *  #237 Q5; MediaRecorder yields formats the bucket rejects). */
  async audio(file, userId) {
    const ext = fileExtension(file.name);
    const contentType = { m4a: "audio/m4a", mp3: "audio/mpeg" }[ext];
    if (!contentType) throw new Error("Recordings must be .m4a or .mp3 files.");
    if (file.size > AUDIO_LIMIT_BYTES) throw new Error("This recording is over the 25 MB limit.");
    const itemId = crypto.randomUUID();
    const storagePath = await uploadToBucket(BUCKET.audio, `${userId}/audio/${itemId}.${ext}`, file, { contentType });
    return { itemId, storagePath, mimeType: contentType, fileSizeBytes: file.size, momentDate: fileMomentDate(file) };
  },

  /** Cover photo → arkive-photos {uid}/covers/{capsuleID}.jpg (re-pick replaces). */
  async cover(file, userId, capsuleId) {
    const blob = await recompressImage(file, { quality: 0.85 });
    return uploadToBucket(BUCKET.photos, `${userId}/covers/${capsuleId}.jpg`, blob, {
      contentType: "image/jpeg", cacheControl: "31536000", upsert: true,
    });
  },
};

/** moments row for a direct upload (source='direct_upload') — keeps the
 *  iOS Arkive tab coherent with web-created capsules (#237 Q12).
 *  moments.id === the items_json item id (iOS seal-backfill contract).
 *  title '' is canonical (Decision #149); never NULL. */
export async function insertDirectUploadMoment({ itemId, userId, mediaType, storagePath, thumbnailPath = null, mimeType, fileSizeBytes, momentDate, durationSeconds = null }) {
  try {
    const { error } = await supabase.from("moments").insert({
      id: itemId,
      account_id: userId,
      media_type: mediaType,
      title: "",
      moment_date: momentDate ?? new Date().toISOString(),
      date_source: "metadata",
      storage_path: storagePath,
      thumbnail_path: thumbnailPath,
      mime_type: mimeType,
      file_size_bytes: fileSizeBytes,
      duration_seconds: durationSeconds,
      source: "direct_upload",
      has_server_bytes: true,
    });
    if (error) throw error;
  } catch (err) {
    console.error("arkive: moments insert failed (non-fatal — items_json is authoritative)", err);
  }
}

/* —— draft / seal writer (sender row; Phase-0 §R4 contract) ——
   Never written: sender_account_id (phantom), email_notification_sent
   (server-set), contributor_count, recipient *_snapshot columns. —— */

export const ArkiveCapsuleWriter = {
  buildDraftPayload(draft, userId) {
    return {
      id: draft.id,
      shared_capsule_id: draft.id,
      creator_user_id: userId,
      mailbox: MAILBOX.myCapsules,
      direction: DIRECTION.sent,
      state: STATE.draft,
      status: STATUS.draft,
      dispatch_state: DISPATCH_STATE.pending,
      title: draft.title ?? "",
      reveal_message: draft.revealMessage ?? null,
      recipient_name: draft.recipientName ?? null,
      recipient_profile_id: draft.recipientProfileId ?? null,
      recipient_relationship_snapshot: draft.recipientRelationship ?? null,
      recipient_contact_hint: draft.recipientEmail ?? null,
      guest_delivery_email: draft.guestEmail ?? null,
      recipient_routing_state: draft.recipientProfileId
        ? RECIPIENT_ROUTING_STATE.localProfileOnly
        : RECIPIENT_ROUTING_STATE.awaitingRecipientAccount,
      cover_storage_path: draft.coverStoragePath ?? null,
      items_json: ArkiveItemsCodec.encode(draft.items ?? []),
      letter_count: (draft.items ?? []).filter((i) => i.kind === ITEM_KIND.letter).length,
      moment_count: (draft.items ?? []).filter((i) => i.kind !== ITEM_KIND.letter).length,
      draft_step: draft.draftStep ?? 1,
      last_modified_at: new Date().toISOString(),
    };
  },

  async saveDraft(draft, userId, { isNew }) {
    const payload = this.buildDraftPayload(draft, userId);
    if (isNew) {
      const { error } = await supabase.from("capsules").insert(payload);
      if (error) throw error;
    } else {
      const { id, creator_user_id, ...updatable } = payload;
      const { error } = await supabase.from("capsules")
        .update(updatable).eq("id", draft.id).eq("creator_user_id", userId);
      if (error) throw error;
    }
    return payload;
  },

  /** Draft → sealed. Resolves the recipient account via the
   *  find_account_by_email RPC (Phase-0 §R4) at seal time. */
  async seal(draft, userId, { deliveryType, releaseAtISO, senderDisplayName, senderProfileId }) {
    const email = draft.recipientEmail ?? draft.guestEmail ?? null;
    let recipientAccountId = null;
    if (email) {
      try {
        const { data, error } = await supabase.rpc("find_account_by_email", { input_email: email });
        if (error) throw error;
        recipientAccountId = data?.[0]?.account_id ?? null;
      } catch (err) {
        console.warn("arkive: recipient resolution failed (sealing unlinked)", err);
      }
    }
    const deliveryRule = deliveryType === DELIVERY_TYPE.manualDelivery ? DELIVERY_RULE.manual : DELIVERY_RULE.date;
    const routing = recipientAccountId
      ? RECIPIENT_ROUTING_STATE.linkedToRecipientAccount
      : (draft.guestEmail ? RECIPIENT_ROUTING_STATE.awaitingRecipientAccount : RECIPIENT_ROUTING_STATE.localProfileOnly);
    const sealPatch = {
      state: STATE.sealed,
      status: STATUS.scheduled,
      sealed_at: new Date().toISOString(),
      release_at: releaseAtISO,
      delivery_type: deliveryType,
      delivery_rule: deliveryRule,
      draft_step: null,
      title: draft.title ?? "",
      reveal_message: draft.revealMessage ?? null,
      items_json: ArkiveItemsCodec.encode(draft.items ?? []),
      letter_count: (draft.items ?? []).filter((i) => i.kind === ITEM_KIND.letter).length,
      moment_count: (draft.items ?? []).filter((i) => i.kind !== ITEM_KIND.letter).length,
      cover_storage_path: draft.coverStoragePath ?? null,
      recipient_account_id: recipientAccountId,
      recipient_routing_state: routing,
      recipient_contact_hint: email,
      sender_display_name_snapshot: senderDisplayName ?? null,
      sender_profile_id: senderProfileId ?? null,
      last_modified_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from("capsules")
      .update(sealPatch).eq("id", draft.id).eq("creator_user_id", userId)
      .select(CAPSULES_SELECT).single();
    if (error) throw error;
    return data;
  },
};

/* —— delivery engine (Phase-0 §R4; #240 at-seal parity) —— */

export const ArkiveDeliveryEngine = {
  /** The three-step sequence: sender UPDATE (full field-set, sharp edge
   *  #5) → Received-row INSERT (mirror trigger backfills content;
   *  23505 = already delivered, no-op) → send-capsule-emails invoke
   *  with STRICT {success} parsing. email_notification_sent is never
   *  written — the Edge Function flips it after Resend confirms. */
  async deliver(row, userId) {
    const nowISO = new Date().toISOString();
    const email = row.recipient_contact_hint || row.guest_delivery_email || null;
    const senderPatch = {
      state: STATE.delivered,
      status: STATUS.delivered,
      dispatch_state: DISPATCH_STATE.sent,
      dispatch_method: email ? DISPATCH_METHOD.email : DISPATCH_METHOD.inApp,
      delivery_prepared_at: nowISO,
      delivery_attempted_at: nowISO,
      delivery_completed_at: nowISO,
      delivery_destination: email ?? "Arkive Inbox",
      last_modified_at: nowISO,
      ...(row.release_at && new Date(row.release_at) > new Date() ? { release_at: nowISO } : {}),
    };
    const { error: senderError } = await supabase.from("capsules")
      .update(senderPatch).eq("id", row.id).eq("creator_user_id", userId);
    if (senderError) throw senderError;

    if (row.recipient_account_id) {
      const { error: insertError } = await supabase.from("capsules").insert({
        id: crypto.randomUUID(),
        shared_capsule_id: row.id,
        creator_user_id: userId,
        recipient_account_id: row.recipient_account_id,
        recipient_profile_id: row.recipient_profile_id ?? null,
        recipient_name: row.recipient_name ?? null,
        recipient_relationship_snapshot: row.recipient_relationship_snapshot ?? null,
        recipient_contact_hint: row.recipient_contact_hint ?? null,
        mailbox: MAILBOX.received,
        direction: DIRECTION.received,
        state: STATE.delivered,
        status: STATUS.delivered,
        recipient_routing_state: RECIPIENT_ROUTING_STATE.routedToRecipientInbox,
        delivery_type: row.delivery_type,
        delivery_rule: row.delivery_rule,
        release_at: row.release_at ?? nowISO,
        sealed_at: row.sealed_at,
        dispatch_state: DISPATCH_STATE.sent,
        dispatch_method: email ? DISPATCH_METHOD.email : DISPATCH_METHOD.inApp,
        delivery_completed_at: nowISO,
        // title/items_json/counts/cover/reveal_message/sender snapshot:
        // intentionally omitted — mirror_sender_columns_to_recipient_row
        // backfills them from this sender row (runs before validation).
      });
      if (insertError && insertError.code !== "23505") throw insertError;
    }

    if (email) {
      try {
        const parsed = await this.invokeDeliveryEmail(row.id);
        if (parsed.success) {
          console.info("arkive: delivery email sent", parsed.email_id ?? "");
        } else {
          console.warn("arkive: delivery email not sent —", parsed.error ?? "unknown", "(daily cron is the backstop)");
        }
      } catch (err) {
        console.error("arkive: send-capsule-emails invoke failed (cron backstop applies)", err);
      }
    }
  },

  /** Raw-fetch invoke, deliberately NOT supabase-js functions.invoke:
   *  the SDK adds an x-client-info header, which the function's CORS
   *  allow-list (Authorization, Content-Type) doesn't include — the
   *  preflight fails and the POST never leaves the browser. Sending
   *  exactly those two headers fits the deployed v35 contract.
   *  Strict {success} parsing (the pre-W80 assume-success bug class). */
  async invokeDeliveryEmail(capsuleId) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("no session for delivery-email invoke");
    const response = await fetch(`${SUPABASE_URL}/functions/v1/send-capsule-emails`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ capsule_id: capsuleId }),
    });
    const parsed = await response.json().catch(() => null);
    if (typeof parsed?.success !== "boolean") {
      throw new Error(`unexpected send-capsule-emails response shape (HTTP ${response.status})`);
    }
    return parsed;
  },

  /** Sender-side sweep (web runs it on capsules load, #237): deliver
   *  due scheduled capsules, then reconcile sender 'Opened' from the
   *  recipient twins (client-side on iOS too — no DB trigger). Returns
   *  the number of rows it changed so callers can re-render. */
  async runSenderSweep(userId, outgoingRows) {
    let changed = 0;
    const now = new Date();
    const due = outgoingRows.filter((r) =>
      r.status === STATUS.scheduled && r.delivery_rule === DELIVERY_RULE.date
      && r.release_at && new Date(r.release_at) <= now);
    for (const row of due) {
      try { await this.deliver(row, userId); changed += 1; }
      catch (err) { console.error("arkive: sweep delivery failed", row.id, err); }
    }

    const deliveredIds = outgoingRows
      .filter((r) => r.status === STATUS.delivered)
      .map((r) => r.id);
    if (deliveredIds.length > 0) {
      try {
        const { data: twins, error } = await supabase.from("capsules")
          .select("shared_capsule_id, opened_at")
          .in("shared_capsule_id", deliveredIds)
          .eq("mailbox", MAILBOX.received)
          .not("opened_at", "is", null);
        if (error) throw error;
        for (const twin of twins ?? []) {
          const { error: reconcileError } = await supabase.from("capsules")
            .update({ status: STATUS.opened, opened_at: twin.opened_at, last_modified_at: new Date().toISOString() })
            .eq("id", twin.shared_capsule_id).eq("creator_user_id", userId);
          if (reconcileError) console.error("arkive: opened reconciliation failed", reconcileError);
          else changed += 1;
        }
      } catch (err) {
        console.error("arkive: opened reconciliation query failed", err);
      }
    }
    return changed;
  },
};

/* (WS5 filled the former ArkiveDeliveryEngine placeholder — the live
   engine now lives in the WS5 section above.) */
