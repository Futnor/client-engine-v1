import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Download, Package, ShieldCheck, RefreshCw, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';

/**
 * ExtensionBuildsTab — admin-only download list for the packaged Chrome
 * extension zips that live in /public.
 *
 * Note: the zips are technically reachable by URL (they're static files in
 * the deployed dashboard) — this tab is a UI restriction rather than a
 * cryptographic gate. The Admin page itself already redirects non-admins
 * away, so links are never exposed in the public-facing dashboard.
 */

// Maintain newest-first. Add new versions to the TOP of the array when
// you build a new zip.
const EXTENSION_BUILDS: Array<{
  version: string;
  /** Filename slug used in /public, e.g. "v2-4-95" */
  slug: string;
  /** What changed in this version, shown as a small caption */
  notes?: string;
  /** Mark only the latest build with this so non-admin recovery flows
   *  (if any) know which one to fetch). */
  latest?: boolean;
}> = [
    { version: '2.4.149', slug: 'v2-4-149', latest: true,
    notes: 'Action Delay slider now actually waits. Three iteration sites in background.js (commenter loop ~L4101, hashtag loop ~L3737, location loop ~L4448) hardcoded a 2-4 second pause between accounts and never waited on the user-configured getRandomDelay(config) value — the slider only affected accounting, not real pacing. So users who set the slider to e.g. 30-60 seconds still saw DMs going every 2-4 seconds. Fixed: each site now does `const delay2 = getRandomDelay(config); await waitMs(delay2);` so minActionDelay/maxActionDelay slider values are honored across all targeting modes.' },
  { version: '2.4.148', slug: 'v2-4-148',
    notes: 'Issue 5 (session stops early) + Issue 6 (DM opening reliability) focused build. (1) waitForDMOpen rebuilt with MutationObserver + popstate + 250ms polling backup (was 1000ms polling only). Now detects the DM thread / minichat dialog / floating widget within ~100-250ms of appearance instead of waiting up to a full second between checks. User log showed Message-button click → 15× 1s polls → timeout → 3-dots fallback, even though the DM widget had likely opened between polls. New impl races three signals: DOM mutations (instant), popstate (instant for IG\'s SPA navigations), and 250ms polling (catches anything the first two miss). Cleans up observers and listeners on resolve. (2) Commenter pagination patience boosted for high-volume posts: STALE_LIMIT 5→10 (up to 70s of "no new commenters" headroom before giving up vs prior 35s) and MAX_SCROLL_ROUNDS 60→120. Background-pagination cap BG_MAX 50→200. User reported the bot stopping on 400+ commenter posts — the prior caps weren\'t leaving enough room for IG\'s lazy-loader pauses on deep pagination. (3) Note about user\'s shared log: that log shows a one-shot profileDM action for @chefsoda (not a commenter flow). The bot opened DM, found chefsoda in history, returned false correctly, then the session transitioned to sales-agent inbox-scan mode. That\'s expected behavior for the "DM specific username" task — not a premature stop. The v2.4.148 commenter pagination fixes are the layer that\'d address the user\'s 400+ commenter scenario when it next runs that flow.' },
  { version: '2.4.147', slug: 'v2-4-147',
    notes: 'FOUR targeted fixes from activity log (9): (1) "Hey Link" personalization bug — user reported DMs starting with "Hey Link, just a quick note..." because IG renders link-in-bio anchors with text/aria-label "Link" and the display-name extraction picked it up. Two layers: expanded uiTexts blocklist (link, links, bio, website, view profile, see profile, tagged, subscribe, etc.) so the per-extraction filters reject the source text, AND added a FINAL isBogusName() sanity check in personalizeAndFormatDM so even if a UI word slips past every extraction path, it never reaches the DM. Falls through to deriveNameFromUsername → "there". (2) Message button → 3-dots fallback firing unnecessarily — log shows the bot found the Message button, clicked it, timed out waiting 15s for DM to open, then fell back to 3-dots (which surfaces Block/Restrict/Report items). The 3-dots fallback often eventually worked, but it looks unnatural. Now: humanClick + raw .click() in parallel for redundancy (synthetic events are isTrusted:false; some IG layouts ignore one or the other), 8s wait, re-find the message button and re-click if still not open, then another 12s wait. Only THEN fall back to 3-dots. Total Message-button budget went from 15s → 21s with a re-click in the middle. (3) 30-DAY COOLDOWN dedup layer — new bgDMHistoryDatesCache stores {[username]: epochMs} alongside the existing binary dm_history Set. Commenter loop now checks wasDMdRecently() in addition to isInBgDMHistory(). User reported the bot DMing accounts contacted 3 days prior — this can happen if a real DM was mis-labelled as failed (never written to binary history) or if storage was wiped between sessions. Cooldown is a parallel layer that catches those cases. Log: "⏭️ @user DM\'d Xd ago — within 30-day cooldown, skipping". (4) Kept all v2.4.146 anti-suspension + labelling pieces (action-blocked modal hard-stop, hourly+daily caps, pacing, wasOurMessageDelivered escape hatches, _futnorOutgoingBubblePresent root-textContent fallback, threadContainsExpectedMessage Path B grid scan, executeValidatedDMFlow safety-net thread scans with action_blocked_modal carving). Version bumped to 2.4.147.' },
  { version: '2.4.146', slug: 'v2-4-146',
    notes: 'Hybrid build: keep all anti-suspension hardening from v2.4.144 (account-blocked modal detection, hourly + daily caps, between-DM pacing, burst pause, demographics fail-open, real action-blocked verdict still hard-stops the session), but rebuild the labelling pipeline so successful sends are correctly marked. Three labelling-focused changes vs v2.4.145: (1) _futnorOutgoingBubblePresent gets back the always-on thread-root textContent fallback (v2.4.131 logic) — IG re-keys virtualized message rows when the thread updates, so a just-sent bubble may briefly exist WITHOUT the role="row" wrapper. Without this fallback the verifier missed those bubbles and falsely returned ghost_send. The scan stays scoped to getDMThreadRoot (NOT the whole page) so unrelated UI text cannot match. (2) verifyDMDeliveryAndSignal regains the wasOurMessageDelivered escape hatches around BOTH the modal-detect and the in-thread-failure detect (v2.4.142 logic), plus the innocent-until-proven-guilty fail-open at the end of the poll window (v2.4.138). Critically: this does NOT weaken account safety — detectDMRateLimitModal still fires hard on real action-blocked / temporarily-blocked dialogs, which are the only modals that signal a real suspension risk. The escape only triggers when the modal text appears AND our message is visibly delivered (stale-toast pattern). (3) executeValidatedDMFlow regains its safety-net thread scans on verdict.failed (first attempt + retry + final fall-through) — but now skip the override when verdict.reason === "action_blocked_modal", so a real action-block still stops the session and protects the account. threadContainsExpectedMessage also regains Path B (direct grid-text prefix scan) so the safety nets actually match re-keyed bubbles. Kept from v2.4.145: performProfileDM\'s 8000ms/stableChecks:3 freshness threshold and the v2.4.93-style pre-send guard.' },
  { version: '2.4.145', slug: 'v2-4-145',
    notes: 'Interim revert to v2.4.93 send/verify pipeline. Superseded by v2.4.146 which keeps the labelling-accuracy pieces (bubble-detect fallback, stale-toast escape hatches, safety-net thread scans) but with action_blocked_modal carving so account safety is preserved.' },
  { version: '2.4.144', slug: 'v2-4-144',
    notes: 'Final-thread scan added to verdict.failed branches + daily-goal check inside commenter flow + indirect duplicate-DM fix.' },
  { version: '2.4.143', slug: 'v2-4-143',
    notes: 'FINAL safety-net for successful-DM detection. Added a last-line scan inside executeValidatedDMFlow: if all earlier checks (sendCustomMessage messageSent, confirmSendAfterFailure, verifyDMDeliveryAndSignal, send-retry) all say the send failed, AND yet the message text is actually in the thread, we count as delivered. Four layers total now: (1) send-click confirmation from sendCustomMessage, (2) confirmSendAfterFailure with v2.4.131 direct-text fallback, (3) verifyDMDeliveryAndSignal with v2.4.142 indicator-double-check + v2.4.138 fail-open + v2.4.141 generic-phrase removal, (4) NEW final-safety scan if all above failed. The success path now logs the existing "📨 DM sent to @username!" line; the bot SHOULD be able to mark every actually-delivered DM as sent regardless of which transient toast or stale modal IG renders around the send.' },
  { version: '2.4.142', slug: 'v2-4-142',
    notes: 'Failure indicators are now double-checked against actual delivery. User clarified: "Something went wrong" appears BEFORE the bot types, the bot proceeds and sends, the DM lands in IG inbox, but the verifier still trips on the residual toast/modal. Both detectDMRateLimitModal and detectDMDeliveryFailureInThread now re-check whether our message text is already in the thread when they fire — if YES, the indicator is stale chrome from before the send, not a real block, and we count as delivered. Only when an indicator fires AND the message is NOT in the thread do we trust the failure verdict. Combined with the v2.4.139 / v2.4.141 phrase tightening (removed bare "try again" / "try again later"), this should eliminate the false-failed-DM problem completely.' },
  { version: '2.4.141', slug: 'v2-4-141',
    notes: 'Removed "try again later" from the rate-limit modal phrase list. Instagram shows a generic transient "Something went wrong. Please try again later." toast/dialog on perfectly-successful sends — that toast text contained "try again later" which was matching our detectDMRateLimitModal scan, returning action_blocked_modal verdict, and the verifier flagged the send as failed. Bot logged "DM could not be sent" while the DM had actually landed in IG. User reported this across multiple sessions ("Bot is still not marking successfully sent dms as sent, Instagram still says something went wrong"). Each remaining phrase in DM_RATE_LIMIT_MODAL_PHRASES is now unique to IG\'s actual bot-restriction modals — "We restrict certain activity", "Action blocked", "temporarily blocked", etc — none of these appear in transient successful-send toasts. v2.4.139\'s DM_DELIVERY_FAILURE_PHRASES tightening (removed bare "try again") complements this from the in-thread direction; both surfaces are now clean.' },
  { version: '2.4.140', slug: 'v2-4-140',
    notes: 'Commenter-flow completion summary. User said: "Comments were 31, it should DM all that qualify and mention it completed not just shut down without saying anything." Added per-outcome accounting in the commenter-network loop — every skip path (already-DM\'d, inaccessible, filter mismatch, DM-send failed, runtime error) now increments a counter. At the end of the flow the bot emits a single session_end summary like "📊 Commenter flow complete — 31 found, 1 DM\'d, 30 skipped (28 already-DM\'d, 2 inaccessible)" so the user can see exactly what happened to every commenter. The flow itself was already attempting every commenter in the list — the issue was the user couldn\'t tell why most didn\'t convert.' },
  { version: '2.4.139', slug: 'v2-4-139',
    notes: 'TWO concrete fixes (personalisation locked, no changes there): (1) DM_DELIVERY_FAILURE_PHRASES tightened. The previous entry "try again" was too generic — matched real user messages ("let\'s try again tomorrow", etc) AND IG\'s transient "Something went wrong, try again" toast that appears on perfectly-successful sends. User reported "Bot said something went wrong, bot continued to successfully send DM but is failing to mark DM as sent successfully" — that bare "try again" was the source. Replaced with "tap to try again" (unambiguous error UI). The rate-limit modal list still keeps "try again later" because modal-scope matches don\'t false-fire on user typed text. (2) commenterNetworkLoop default flipped from false → true. User reported "bot aborts session after it sends DM" — after processing the original post\'s commenters, the bot was hitting "Commenters from target post processed (network loop disabled)" and ending the session with only 1 DM sent. With loop ON, after exhausting the initial commenter list the bot expands to commenters of DM\'d users\' posts → sustained throughput per session.' },
  { version: '2.4.138', slug: 'v2-4-138',
    notes: 'TWO fixes from user report. (1) DM verifier now innocent-until-proven-guilty. User reported DMs being logged as "could not be sent" even when actually delivered (visible in IG inbox afterwards). Previous verifyDMDeliveryAndSignal flagged "ghost_send" when text-fragment matcher AND hasOutgoingMessages snapshot both failed, even with no rate-limit modal and no "Not delivered" indicator. Now after the full 13s poll, if no failure signal was seen, count the DM as delivered (the upstream send code already waited for the composer to clear). The action-block / Not-delivered detectors still fire as hard fails when triggered. (2) Business-name personalisation. Display-name extraction was returning JUST the first word — "The Good Mood Foods" became "The". New pickDisplayNameVariant helper returns the FULL multi-word name when the text looks like a business (leading article like "The"/"A"/"My", contains a business word like "Inc"/"LLC"/"Foods"/"Shop"/"Studio"/"Brand"/etc, or has 3+ words). Personal names ("John Smith") still return the first word. Applied in all 4 extraction paths (h1/h2 heading, span, link, document.title).' },
  { version: '2.4.137', slug: 'v2-4-137',
    notes: 'Demographics filter is now fail-OPEN when extraction can\'t read the value. User reported a qualifying account (15k followers, well inside their 50–50,000 filter) being skipped with "follower count not visible" because IG\'s profile-stats DOM rendered too slowly. Previous behaviour was "fail closed" (skip on unknown) — the comment literally said "we\'d rather miss a target than DM the wrong person". User\'s explicit ask reversed: skipping qualifying targets is worse than occasionally DMing a target outside the filter. All four filter checks (follower count, post count, gender, age) now log a warning and continue when the value is unknown, rather than skipping. Filter still skips when the extracted value is clearly out of range. Also extended demographics retry window from 4s (8 × 500ms) to 8s (16 × 500ms) so slow IG profile renders have more time to populate stats before we declare unknown.' },
  { version: '2.4.136', slug: 'v2-4-136',
    notes: 'Three follow-ups: (1) Path 0 (document.title) display-name extraction now also rejects numeric-only first-words — defends against an edge case where the title parse extracts the wrong substring. (2) recallProfileDisplayName rejects cached numeric values — clears any "1,887" or similar that an older session may have cached before v2.4.132. Next extraction attempt runs fresh against the current DOM. (3) Content-script load log now includes the version: "Content script v2.4.136 loaded and message listener registered ✓". Quick way to verify which build is actually running on the Instagram tab — if it doesn\'t say v2.4.136, the page needs a refresh after sideloading.' },
  { version: '2.4.135', slug: 'v2-4-135',
    notes: 'Restored /liked_by/ URL navigation. Click-based popup widget consistently returns only 2 likers because IG\'s lazy-loader is gated on isTrusted=true scroll events — JS-dispatched scrolls (any source: extension content script, MAIN-world script, etc) have isTrusted=false and IG\'s pagination handler ignores them. No amount of scroll-trigger tuning, PointerEvent dispatching, or sentinel-targeting fixes this; it\'s an isTrusted check on IG\'s server. Direct /p/<id>/liked_by/ navigation pre-loads ~30 likers in the initial server response, giving ~15× more DMs per session (2 → 30+). The full-page UI is the cost; the user gets real volume back. (engageFromModal\'s dual-mode handling already supports full-page mode, so picking liker rows works the same way.)' },
  { version: '2.4.134', slug: 'v2-4-134',
    notes: 'TWO fixes targeting the "popup widget only shows 2 likers" problem: (1) humanClick now dispatches POINTER events alongside mouse events, with proper screen/client coordinates, detail:1, composed:true, buttons:1. Modern Instagram uses PointerEvents and React\'s SyntheticEvent branches based on these properties; the previous bare MouseEvents lacked detail and screen coords which may be how IG was returning only the cached-preview state with 2 rows. (2) Scroll-trigger target switched from the last <a> profile link (already visible when only 2 rows exist — so IntersectionObserver never fires) to whichever comes first: a loading-spinner element, OR the literal LAST DESCENDANT of the scroll container (typically IG\'s sentinel div placed AFTER the rendered rows). Scrolling THAT into view wakes IG\'s lazy loader even when only 2 rows have rendered.' },
  { version: '2.4.133', slug: 'v2-4-133',
    notes: 'Mini popup widget restored. User explicitly asked for the small popup widget like a manual click, not the full /liked_by/ page. Reverted v2.4.129\'s pushState navigation back to humanClick on findLikersOpener(). Click-based opening produces the popup widget — same as a manual click. Wait after click bumped to 3.5s (was 2s) so IG\'s popup has time to populate before scroll triggers run; scrolling too early can trigger IG\'s degraded "preview" state with only 2 rows. engageFromModal\'s dual-mode handling (v2.4.130) is kept as a SAFETY FALLBACK — if the click somehow lands on /liked_by/ full page instead of the popup overlay, the bot still works via <main>. v2.4.132\'s patience boost (MAX_ROUNDS 150, STALE_LIMIT 25) and numeric-firstWord reject for personalisation both stay in place.' },
  { version: '2.4.132', slug: 'v2-4-132',
    notes: 'TWO fixes from user report. (1) PERSONALISATION used "1,887" (the followers count) as the name. extractFirstNameFrom{Heading,Spans,Links} rejected text that was purely numeric (e.g. "1,887") but didn\'t reject FIRST-WORDS that were numeric when the rest of the text wasn\'t (e.g. "1,887 followers" → firstWord "1,887"). Added a `!/[a-z]/i.test(firstWord)` reject in all three helpers — a real first name must contain at least one alphabetic character. (2) FULL-PAGE LIKERS PAGINATION giving up on big lists. User reported 3k-like post only loaded ~30 likers. Changed window scroll from incremental `scrollBy(400–800)` to absolute `scrollTo(0, documentElement.scrollHeight)` — single jump to bottom is more reliable for very long lists than incremental scrolls. Bumped MAX_ROUNDS 80→150 and STALE_LIMIT 14→25 so pagination has ~40s of patience before declaring the list exhausted. Total cap still bounded at ~4 minutes.' },
  { version: '2.4.131', slug: 'v2-4-131',
    notes: 'CRITICAL FIX: duplicate DM sends. User screenshot showed bot sending the exact same script TWICE to @aelopez14. Root cause: after the first send succeeded ("message confirmed as sent"), verifyDMDeliveryAndSignal failed to find the outgoing bubble and flagged ghost_send. profileDM returned false. Background dispatched sendDMMessage recovery, whose duplicate-send guard (threadContainsExpectedMessage) ALSO missed the just-sent bubble (analyzeDMConversation\'s aria-label-only filter from v2.4.122 doesn\'t see fresh outgoing rows without explicit aria-labels) — so the recovery RE-TYPED and RE-SENT the same script. Two fixes: (1) threadContainsExpectedMessage now has a direct thread-root text scan as a fallback when the aria-label path misses — if our 24-char prefix appears anywhere in the message grid text, we know it landed. (2) _futnorOutgoingBubblePresent always scans the full thread text in addition to per-row, so the verifier no longer flags real sends as ghost. The recovery path can still fire when an actual delivery failure occurs, but a successful first send will never trigger a duplicate.' },
  { version: '2.4.130', slug: 'v2-4-130',
    notes: 'Full-page /liked_by/ detection + window-scroll pagination. v2.4.129 navigated to /liked_by/ via pushState which DOES load the full liker list, but IG renders that URL as a FULL PAGE (no role="dialog") when reached by direct navigation — engageFromModal\'s `document.querySelector("[role=\\"dialog\\"]")` returned null, "No accounts found, scrolling more..." 3x then session ended. Now navigatePost detects the full-page mode when the URL ends in /liked_by/ and 3+ profile-link rows are in <main>, uses <main> as the modal container, fires window.scrollBy() instead of contained scrollTop, bounces with window.scrollBy(-400) on stale rounds. engageFromModal applies the same dual-mode logic: tries [role="dialog"] first, falls back to <main> when on /liked_by/. Window-scroll wakes IG\'s IntersectionObserver-backed pagination just like manual scrolling.' },
  { version: '2.4.129', slug: 'v2-4-129',
    notes: 'CRITICAL FIX: bot now skips the synthetic-click-to-open-modal path and navigates DIRECTLY to /p/<shortcode>/liked_by/ via SPA history.pushState + popstate. User confirmed manual click on the likes count loads the full 630-liker list while the bot consistently sees only 2 likers in an unscrollable modal — clear sign IG\'s click handler treats isTrusted=false events as a degraded path that returns a preview modal (~2 likers, no lazy-load). Direct URL navigation bypasses the click entirely: IG\'s router fetches the full list the same way it does for a manual URL visit. No click, no isTrusted check, no degraded modal. The classic click-on-likes-count path remains as a fallback when shortcode extraction fails. Once the full modal renders, v2.4.128\'s gentle scroll triggers paginate through the entire list.' },
  { version: '2.4.128', slug: 'v2-4-128',
    notes: 'Scroll triggers were COLLAPSING the likers modal. User reported manual click opens the full 630-liker list, but the bot consistently sees "initial 2 unique profiles, scrollH=399 → scrollH=0 by round 10" — i.e. the modal shrinks under the bot\'s own actions. The v2.4.123 "aggressive multi-target" triggers were the cause: WheelEvent on the dialog/modal interpreted as swipe-to-dismiss on touch-aware DOM, KeyboardEvent("PageDown") on the modal triggering IG\'s global navigation handlers, multi-target wheel events cascading into outside listeners. Replaced with minimal, gentle, single-pass triggers: scrollTop = scrollHeight on the container, a synthetic scroll event, scrollIntoView on the last profile-link row. That last call is what actually wakes IG\'s IntersectionObserver-backed pagination. No wheel events, no keyboard events, no broad targets — same path a human scrolling with the wheel produces, just done with DOM API instead of OS-level input.' },
  { version: '2.4.127', slug: 'v2-4-127',
    notes: 'ROOT-CAUSE FIX: header regex was matching the lightbox\'s like-COUNT text. Previous regex `/^(likes?|liked by|\\d[\\d.,]*\\s*likes?)$/i` accepted "630 likes" — and the IG post lightbox renders that exact text in a <span> inside its <header> near the heart button. The header selector also included `header span, header div`, so the lightbox\'s like-count span matched and the bot accepted the wrong dialog. Result: log showed "initial 2 unique profiles, scrollH=399" on every post (the 2 profiles being the post owner + tagged user shown in the lightbox header). Now the regex matches ONLY the exact "Likes" or "Liked by" title that the real likers modal uses (no number-prefixed alternative), and the selector is restricted to actual heading elements (h1/h2/h3/[role="heading"]) — never the lightbox\'s caption/count spans. The lightbox cannot pass: its title is the post owner\'s username or post caption, never "Likes" or "Liked by".' },
  { version: '2.4.126', slug: 'v2-4-126',
    notes: 'Tightened likers-dialog match to require explicit "Likes"/"Liked by"/"N likes" header text. v2.4.124\'s alternative positive signal (≥3 Follow buttons) was accepting the post lightbox — modern IG renders a "Suggested for you" sidebar inside the lightbox with several Follow buttons, which crossed the threshold. Result: bot "found" a dialog with only 2 visible profile links (post owner + tagged user), couldn\'t scroll (clientH===scrollH=399), gave up. Now ONLY accepts dialogs whose header matches the regex — that text is unique to the likers modal, the lightbox never has it. Also extended wait window to 25×400ms (10s) for slow header hydration, and added a diagnostic log that prints the header text of every dialog found when no match — so if IG localised the header (German "Gefällt mir-Angaben" etc) the next failure log will show us exactly what to add to the regex.' },
  { version: '2.4.125', slug: 'v2-4-125',
    notes: 'Display-name personalisation hardened. User reported DM sent to @journalwithace was personalised as "Hope you\'re having a good one, Journalwithace!" when the actual display name is "Ace". Three compounding causes: (1) extractProfileDisplayName retry window was 2.4s — sometimes too short for document.title/SSR or h1 hydration. Extended to 6s (12 × 500ms). (2) Search scope was just `header section` — IG ships layouts where display name lives in <main> instead. Now scans 6 candidate roots in order: header section, header, main header, main [role="main"], main section, main. (3) deriveNameFromUsername was the fallback that returned the WHOLE handle title-cased when no separators existed ("journalwithace" → "Journalwithace"). It now bails out (returns empty) when the handle has no ._- separators and is >8 chars long — so personalisation falls back to "there" instead of an ugly mashed-together word. Better generic than wrong-and-obviously-bot.' },
  { version: '2.4.124', slug: 'v2-4-124',
    notes: 'Likers-dialog match rewritten with combined POSITIVE + NEGATIVE signals. v2.4.123 fixed the scroll-container picker but the bot was still grabbing the POST LIGHTBOX as the dialog itself (different post each time: previously DXtgU6Fikuh, now DXoltOejjtN — log shows initial 1 unique profile, scrollH=clientH=399). The old detection only required links.length>=2 which any lightbox passes. New isLikersModal: REJECT if dialog contains a media <img> (naturalWidth or clientWidth > 200) or <video> or <article> — eliminates every variant of the post lightbox. ACCEPT only if at least one positive signal hits: (1) header text matches "Likes"/"Liked by"/"N likes" pattern, OR (2) ≥3 buttons with text "Follow"/"Following"/"Requested" (one per liker row — the lightbox never has these). Applied in both navigatePost branches: the existing-modal-reuse check at the top, and the freshly-clicked modal-wait below. Wait window extended from 16×400ms to 20×400ms (~8s) for slow IG hydration. v2.4.123\'s scroll-container improvements remain intact for when the real likers modal is found.' },
  { version: '2.4.123', slug: 'v2-4-123',
    notes: 'Smarter likers scroll-container picker + aggressive multi-target scroll triggers. User reported a 630-like post loaded only 2 profiles ("clientH=356, scrollH=356, initial 2 unique, pagination round 10: 2 unique"). Previous picker walked up from the first profile link and grabbed the FIRST ancestor with overflow-y:auto — which was an outer wrapper with no actual content overflow, so scroll triggers fired against it never woke IG\'s loader. Three changes: (1) Picker now prefers containers that ALREADY overflow (scrollH > clientH+20) over the parent-walk heuristic. (2) Scroll triggers fire wheel/scroll events at ALL scrollable elements under the modal (not just one), plus scrollIntoView on the last row + PageDown keydown — at least one wakes IG\'s IntersectionObserver. (3) After each round we re-check whether a better scroll container has appeared (IG hydrates the inner list lazily — for the first second only the outer wrapper is "scrollable", then the inner list starts overflowing). Bot switches to the proper target as soon as it shows up.' },
  { version: '2.4.122', slug: 'v2-4-122',
    notes: 'Existing-thread detection now uses ONLY message-bubble aria-labels — the strongest possible signal. Latest log showed @chronicles_of_vb (a fresh thread per the user) being skipped because looksLikeExistingConversation matched something in the profile preview / system text (likely bio text containing "sent" or status timestamps). Removed the heuristic check from both threadHasExistingMessages and confirmThreadFreshness. The aria-label scan ("Message from <user>", "You sent", "Sent at HH:MM", etc) only fires on real message rows IG explicitly labels — no false positives possible from profile previews or chrome text. The alreadySentOurScript duplicate-send guard upstream is preserved, so the bot still cannot double-send the same script. confirmThreadFreshness timeout verdict flipped from "unknown" (skip) to "empty" (send) so a slow-loading page doesn\'t cost a real send.' },
  { version: '2.4.121', slug: 'v2-4-121',
    notes: 'ROOT CAUSE for "randomly scrolling picking likers": the persistent processedAccounts list was being written on every CLICK of a liker — even when the DM never sent (skipped existing chat, Message button failed, etc). After a few sessions, hasVisitedAccount returned true for almost every liker in a busy modal, leaving 1–2 "fresh" candidates buried mid-list. Bot dutifully picked the topmost-fresh, which looked like "scrolling to a random row" to the user. Latest log proved it: `(1 fresh, topN=1)` from a 22-liker modal. TWO changes: (1) engageSimilar now uses persistProcessed=false so liker clicks are in-session only; permanent record only happens via DM history after a successful send. (2) hasVisitedAccount no longer consults isInProcessedAccounts, so existing accumulated junk in storage stops blocking liker selection immediately — no migration needed. The bot now picks strictly top-to-bottom from the very first liker that has never received a DM.' },
  { version: '2.4.120', slug: 'v2-4-120',
    notes: 'Bot now reliably returns to the likers list after a successful DM via floating chat widget. Log showed @itsbookgains DM landed, "Closing floating chat panel..." → timeout warning → no further action. Root cause: after the DM, the page was still on the liker\'s profile URL (e.g. /itsbookgains/). The next iteration\'s navigatePost would trigger window.location.href = postUrl — a HARD reload that kills the content script mid-call and breaks the message channel. Fix: at the end of performProfileDM on the non-/direct/ widget path, call window.history.back() to SPA-navigate back to the post URL with the modal still open. No reload, no content-script reset. The next iteration\'s navigatePost sees onPostUrlAlready=true, reuses the modal, picks the next topmost liker — fast and reliable.' },
  { version: '2.4.119', slug: 'v2-4-119',
    notes: 'CRITICAL: threadHasExistingMessages had a false-positive fallback that fired on EVERY fresh thread. The third signal `analysis.hasRows && !detectEmptyThreadPlaceholder()` treated ANY row in the thread as evidence of existing messages — but on fresh threads IG renders a profile-preview card (avatar, display name, follower count, bio, "View profile" button) that surfaces as role="row"/<li>/<article> elements. With Allow Existing Chats OFF, the bot was therefore skipping every single send. User confirmed: "@oliver_vesely had NO existing chats yet bot said there are existing chats." Fallback removed. The two remaining signals are sufficient: (1) explicit message-bubble aria-labels via hasAnyMessages, (2) heuristic check for HH:MM timestamps + "seen"/"delivered"/"sent" markers via looksLikeExistingConversation — both of which only ever appear on real conversations.' },
  { version: '2.4.118', slug: 'v2-4-118',
    notes: 'Inter-iteration delay is now activity-aware. DM SENT → full configured action delay (45–180s default, humanlike pacing so back-to-back DMs don\'t look robotic). DM SKIPPED → 3–6s only, so the bot quickly advances to the next target instead of appearing frozen on a profile it just skipped. User reported the bot looked stuck on @oliver_vesely after the v2.4.117 "Allow Existing Chats OFF" skip fired correctly — the skip was working, but the 45–180s wait before the next iteration made it feel hung. Verified from log: display name extraction working ("Oliver" from thread header), strict top-to-bottom likers working (candidates[0] = @oliver_vesely), existing-conversation skip working in both performProfileDM and sendDMMessage. Only remaining symptom was the long post-skip delay; this fix eliminates it.' },
  { version: '2.4.117', slug: 'v2-4-117',
    notes: 'Existing-thread skip restored, gated on the "Allow Existing Chats" toggle. When the toggle is OFF, the bot detects threads with prior messages and skips them (returns false so the loop moves to the next target). When ON (default), the bot sends regardless. CRITICAL: the skip path no longer calls addToDMHistory — that was the recovery-poisoning bug that left the bot stuck on the profile in v2.4.115 and earlier. Applied in both performProfileDM and sendDMMessage. The alreadySentOurScript duplicate-send guard still fires unconditionally to protect against true double-sends.' },
  { version: '2.4.116', slug: 'v2-4-116',
    notes: 'THREE concrete fixes diagnosed from the latest user log:\n(1) DM ON /direct/inbox/ FULL-PAGE — root cause was the "Thread already has existing messages — skipping" hard-skip in performProfileDM. confirmThreadFreshness returns "existing" for ANY prior message in the thread (stale message-requests, brief one-message conversations, etc), so the bot was skipping virtually every target the user had ever interacted with. Worse, the skip path called addToDMHistory which then poisoned the recovery path: sendDMMessage saw the username in DM history and also skipped, leaving the bot stuck on the profile until the loop timed out. Both hard-skips are now removed — the bot SENDS regardless of prior history. The alreadySentOurScript duplicate-send guard (which only fires when our exact message is already visible) is kept to prevent true double-sends.\n(2) STRICT TOP-TO-BOTTOM LIKERS — engageFromModal now scrolls the modal\'s overflow container to scrollTop=0 BEFORE reading candidates. After preload pagination, the modal was left at the bottom; clicking candidates[0] meant clicking a row that\'s offscreen, and IG\'s virtualised list may have detached its event handlers. Scrolling back to 0 ensures liker #1 is visible and hit-testable.\n(3) DEFAULTS — botEngine.ts targeting now defaults allowExistingChats=true. New users get sane behaviour out of the box; existing users get the same outcome from the content.js change above regardless of their stored config.' },
  { version: '2.4.115', slug: 'v2-4-115',
    notes: 'Cooldown is now activity-gated. recordSessionEnd no longer writes futnor_last_session_end when the session ended with zero DMs sent — so if you click Start, spot a problem, and click Stop before any DM lands, you can immediately start again instead of being forced to wait 30 minutes. The cooldown only fires when there\'s real automation activity to space out from. Block-detected stops still force the cooldown via the new { force: true } option, because a block is a real safety signal regardless of how many DMs landed.' },
  { version: '2.4.114', slug: 'v2-4-114',
    notes: 'Display-name extraction now reads document.title FIRST. Instagram sets the tab title on every profile page to "<DisplayName> (@<handle>) • Instagram photos and videos" — that string is populated by SSR before any React hydration and is the single most reliable source of the real display name across every profile-layout redesign. User reported @urs.jstn was being personalised as "Urs" (derived from the first dot-segment) when the actual display name is "Justin"; the header-scan was missing it because IG\'s current profile DOM doesn\'t put "Justin" anywhere the previous selectors matched in time. The title-based extractor anchors on the (@<handle>) substring so it can only match the right profile\'s title — it won\'t accidentally pick up "Notifications" or "Explore" from the tab title on a wrong page.' },
  { version: '2.4.113', slug: 'v2-4-113',
    notes: 'TWO grounded fixes from user log diagnosis:\n(1) STRICT TOP-TO-BOTTOM LIKERS ORDER — engageFromModal\'s topN=1 path was picking pool[0] where pool was "candidates filtered to viewport-visible". After modal scrolled during pagination, the topmost-visible row was an arbitrary mid-list account, not the next-up liker. User reported "not DMing likers in order, just randomly DMing random liker". Now topN=1 picks candidates[0] directly (topmost in DOM order across all unvisited rows) and scrollIntoView pulls the chosen row into view before clicking. topN>1 (followers/following) still picks from top-N visible to keep humanlike variation.\n(2) STUCK AFTER ONE DM — log showed last entry "Closing floating chat panel..." with no further progress; performProfileDM was hanging inside the panel-close path (humanClick on the chat close button), so the IIFE never reached sendResponse and background\'s sendActionToTab await blocked forever. Wrapped the entire close logic in Promise.race with a 3s ceiling — even a hung click can no longer block the loop. Bot now reliably proceeds to the next liker.' },
  { version: '2.4.112', slug: 'v2-4-112',
    notes: 'POPUP START NOW WORKS WITHOUT DASHBOARD FIRST: background fetches DM scripts directly from Supabase (outreach_profiles via REST) using the auth credentials the dashboard bridge already mirrors into chrome.storage. Mirrors the dashboard\'s startSession query order (per-account script-bulk first, then legacy dm-scripts fallback). The popup\'s "DM scripts not loaded" error now only appears when there\'s genuinely no active bulk in Supabase — not just because the SW state was empty. Plus: AI commenting (postCommentAfterDM) is now PERMANENTLY DISABLED — function returns false immediately regardless of any flag, so call sites in the loop still compile but no comments are ever posted. User explicitly requested AI commenting be removed; this guarantees it can never re-engage even if a stale config flag flips.' },
  { version: '2.4.111', slug: 'v2-4-111',
    notes: 'REVERT to working DM/targeting/comment flows. All v2.4.108–v2.4.110 changes to instagram/content.js are reverted to the v2.4.103-era state where DMs/targeting/comments worked correctly. Specifically reverted: the likers-modal "improvements" that broke detection, the duplicate-send guard tweak that broke /direct/inbox sending, and the popup auto-redirect that opened the dashboard instead of starting a session. KEPT (safety + account health, untouched in this revert): START_SESSION race fix (v2.4.104), Daily Session Goal with local-midnight reset (v2.4.107), session cooldown default 240→30min + 60min cap (v2.4.109), block detection, hourly caps, conservative defaults. Popup now shows the actual rejection reason in the popup itself instead of opening a new tab.' },
  { version: '2.4.110', slug: 'v2-4-110',
    notes: 'THREE concrete fixes after user reported all prior attempts failed:\n(1) LIKERS — switched from the click-the-likers-link + match-the-right-modal approach (which kept matching the post lightbox instead of the likers modal on /p/<id>/?img_index=1 URLs) to direct /p/<id>/liked_by/ navigation via window.history.pushState + popstate. No more modal-vs-lightbox ambiguity, no virtualized-scroller detection, no race conditions. The bot now navigates straight to the likers list URL and engageFromModal scrapes it from the resulting dialog.\n(2) DM ON /direct/inbox/ FULL-PAGE — the duplicate-send guard (which catches profileDM-recovery double-sends) was firing on the inbox-flow path too, aborting every send to anyone with prior conversation history. Added a fromInboxFlow flag passed through sendActionToTab → sendDMMessage; the existingConversation skip now only fires on the profileDM-recovery path where prior history really does mean the script likely landed.\n(3) POPUP START BUTTON — was always showing the generic "Extension is connected but failed to start session" toast. Rewritten to show the actual reason from the background: scripts-not-loaded (with dashboard link), cooldown (with countdown message), goal-met, missing targeting, etc. Plus added popupInitiated: true to the START_SESSION message so future telemetry can distinguish popup-vs-dashboard starts.' },
  { version: '2.4.108', slug: 'v2-4-108',
    notes: 'CRITICAL FIX (superseded by 2.4.109): likers modal detection picked the wrong dialog. The post lightbox is itself a `role="dialog"` and has neither <article> nor <video> as a direct descendant on current Instagram, so the old `links.length >= 2` filter accepted it. Fix attempted ≥3 distinct profile usernames + reject ≥200px imgs; threshold too strict — see 2.4.109.' },
  { version: '2.4.107', slug: 'v2-4-107',
    notes: 'Daily Session Goal resets at the USER\'s LOCAL midnight (whatever timezone the device is set to), not UTC and not a rolling 24h window. Same source of truth in extension and dashboard: both compute today\'s start with `new Date(y, m, d).getTime()` which uses local time. Goal-met rejection now reports time-until-local-midnight (e.g. "wait 5h 12m until midnight resets the count").' },
  { version: '2.4.106', slug: 'v2-4-106',
    notes: 'Reverted to local-midnight in 2.4.107 — was a rolling 24h window. Use 2.4.107 instead.' },
  { version: '2.4.105', slug: 'v2-4-105',
    notes: 'Daily Session Goal: the goal now accumulates DMs across every session run today (local-midnight rollover) instead of resetting per session. A user with goal=20 who sent 12 in session A and 8 in session B now hits the goal at the end of B, not after sending 20 in B alone. Backed by the existing futnor_dm_timestamps ledger (retention extended from 1h to 26h). UI labels renamed "Session DM Goal" → "Daily Session DM Goal", progress bar in AccountHealthScore now reads from the ledger so it shows true daily progress. New start_rejected reason "daily_goal_met" prevents starting a session once today\'s goal is already reached.' },
  { version: '2.4.104', slug: 'v2-4-104',
    notes: 'CRITICAL FIX: race condition where DM scripts loaded by START_SESSION were silently wiped before runSession ran. Trigger: IG content script\'s first-detection write to chrome.storage.local.futnor_active_account fires the SW\'s onChanged listener, which called loadState() — resetting sessionState (incl. dmTemplates) and reading the pre-session row from storage before the session-start saveState() persisted the new templates. Symptom: bot starts but logs "⚠️ No DM scripts found — DMs will be skipped" / "ERROR: DM script is empty or not loaded", scrolls once, idles. Fix: skip loadState in onChanged when pendingSessionStart is in flight + preserve dmTemplates across loadState\'s resetSessionState call as belt-and-suspenders.' },
  { version: '2.4.103', slug: 'v2-4-103',
    notes: 'CRITICAL FIX: removed v2.4.102 explicit navigatePost after DM that caused "Waiting for action" stall. window.location.href from /direct/t/<id>/ triggers a hard page reload which kills the content script mid-function, hanging the background\'s await. Loop iteration\'s natural navigatePost handles return-to-post safely.' },
  { version: '2.4.102', slug: 'v2-4-102',
    notes: 'BROKEN — explicit post-DM navigatePost causes "Waiting for action" stall (hard reload kills in-flight message channel). Use 2.4.103 instead.' },
  { version: '2.4.101', slug: 'v2-4-101',
    notes: 'Audit + refinement of all targeting flows. engageFromModal now takes topN option — likers pick strictly topmost (1), followers/following pick from top 3 for slight variation. No regressions in hashtag/location/commenter/custom flows.' },
  { version: '2.4.100', slug: 'v2-4-100',
    notes: 'CRITICAL FIX: removes v2.4.99 force-navigate loop that caused infinite page reloads + "Reconnecting to extension..." spam. Likers iteration now only navigates when not already on post URL, and reuses an already-open modal instead of re-clicking.' },
  { version: '2.4.99', slug: 'v2-4-99',
    notes: 'BROKEN — caused infinite page-reload loop in likers targeting. Use 2.4.100 instead.' },
  { version: '2.4.98', slug: 'v2-4-98',
    notes: 'Robust likes-link finder: 6 strategies (direct link, aria-label, "X likes" text, "and N others" footer, "View all likes", bare-number near heart icon). Fixes likers targeting on current Instagram DOM where the previous narrow text-match was missing the click target.' },
  { version: '2.4.97', slug: 'v2-4-97',
    notes: 'Legacy targeting flow: never DMs post owner. performEngageSimilarAccount filters owners + opens likers dialog from post page. engageFromModal also filters owners. Hardened post-DM comment kill switch (global storage flag).' },
  { version: '2.4.96', slug: 'v2-4-96',
    notes: 'Personalisation: derived first-name fallback before "there". Likers (engagement monitor): post owner filtered at harvest + first-link safeguard when owner detection returns nothing.' },
  { version: '2.4.95', slug: 'v2-4-95',
    notes: 'Engagement monitor: persistent dedup, fast mode (ads), action-block detection, scan-all-posts, no post-DM commenting' },
  { version: '2.4.94', slug: 'v2-4-94',
    notes: 'Internal — superseded by 2.4.95' },
  { version: '2.4.93', slug: 'v2-4-93',
    notes: 'Chrome Web Store description-length fix' },
  { version: '2.4.91', slug: 'v2-4-91',
    notes: 'Account health score recalibrated' },
  { version: '2.4.90', slug: 'v2-4-90',
    notes: 'Account-protection safety net + warmup overhaul + retry-safe processing' },
  { version: '2.4.89', slug: 'v2-4-89',
    notes: 'Earlier Lovable build' },
  { version: '2.4.65', slug: 'v2-4-65',
    notes: 'Pre-safety-net build (kept for rollback)' },
  { version: '2.4.64', slug: 'v2-4-64' },
  { version: '2.4.63', slug: 'v2-4-63' },
  { version: '2.4.62', slug: 'v2-4-62' },
];

type BuildStatus = {
  exists: boolean;
  bytes?: number;
  lastModified?: string;
  error?: string;
};

function formatBytes(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '—';
  }
}

export function ExtensionBuildsTab() {
  const [statuses, setStatuses] = useState<Record<string, BuildStatus>>({});
  const [refreshing, setRefreshing] = useState(false);

  // HEAD-probe each zip to verify it exists + get size + last-modified.
  // Public files are served by the static host so HEAD is essentially free.
  const probeBuilds = async () => {
    setRefreshing(true);
    const out: Record<string, BuildStatus> = {};
    await Promise.all(
      EXTENSION_BUILDS.map(async (b) => {
        try {
          const res = await fetch(`/futnor-extension-${b.slug}.zip`, { method: 'HEAD', cache: 'no-store' });
          if (!res.ok) {
            out[b.slug] = { exists: false, error: `${res.status} ${res.statusText}` };
            return;
          }
          const lengthHeader = res.headers.get('content-length');
          const bytes = lengthHeader ? Number(lengthHeader) : undefined;
          const lastModified = res.headers.get('last-modified') || undefined;
          out[b.slug] = { exists: true, bytes: Number.isFinite(bytes) ? bytes : undefined, lastModified };
        } catch (e) {
          out[b.slug] = { exists: false, error: (e as Error)?.message || 'fetch failed' };
        }
      }),
    );
    setStatuses(out);
    setRefreshing(false);
  };

  useEffect(() => {
    probeBuilds();
    // Re-probe every 60s so newly published builds appear without a manual
    // refresh while the admin is on the tab.
    const id = window.setInterval(probeBuilds, 60_000);
    return () => window.clearInterval(id);
  }, []);

  const handleDownload = async (slug: string, version: string) => {
    const url = `/futnor-extension-${slug}.zip?t=${Date.now()}`;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `client-engine-extension-v${version}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      toast.success(`Downloaded v${version}`);
    } catch (e) {
      toast.error(`Download failed: ${(e as Error)?.message || 'unknown error'}`);
    }
  };

  const latest = EXTENSION_BUILDS.find((b) => b.latest) || EXTENSION_BUILDS[0];
  const latestStatus = statuses[latest.slug];

  return (
    <div className="space-y-6">
      {/* Latest build callout */}
      <Card className="border-primary/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Package className="w-4 h-4 text-primary" />
            Latest Build — v{latest.version}
            <Badge className="bg-success/20 text-success border-0 text-[10px]">Current</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {latest.notes && (
            <p className="text-sm text-muted-foreground">{latest.notes}</p>
          )}
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span>{formatBytes(latestStatus?.bytes)}</span>
            <span>•</span>
            <span>Built {formatDate(latestStatus?.lastModified)}</span>
            <span>•</span>
            <span className="font-mono">/futnor-extension-{latest.slug}.zip</span>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              size="sm"
              onClick={() => handleDownload(latest.slug, latest.version)}
              disabled={!latestStatus?.exists}
              className="gap-2"
            >
              <Download className="w-4 h-4" />
              Download v{latest.version}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={probeBuilds}
              disabled={refreshing}
              className="gap-2"
            >
              <RefreshCw className={refreshing ? 'w-4 h-4 animate-spin' : 'w-4 h-4'} />
              Refresh
            </Button>
            <a
              href="https://chrome.google.com/webstore/devconsole"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex"
            >
              <Button size="sm" variant="outline" className="gap-2">
                <ShieldCheck className="w-4 h-4" />
                Open Web Store Console
              </Button>
            </a>
          </div>
          {latestStatus && !latestStatus.exists && (
            <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md p-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                File not reachable at <code className="font-mono">/futnor-extension-{latest.slug}.zip</code>
                {latestStatus.error ? ` — ${latestStatus.error}` : ''}.
                Verify the build was committed to <code className="font-mono">public/</code> and Lovable has redeployed.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* All builds — for rollback / archive */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Package className="w-4 h-4" />
            All Builds
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead>Built</TableHead>
                <TableHead className="text-right">Download</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {EXTENSION_BUILDS.map((b) => {
                const s = statuses[b.slug];
                return (
                  <TableRow key={b.slug}>
                    <TableCell className="font-mono">
                      <span className="font-semibold">v{b.version}</span>
                      {b.latest && (
                        <Badge className="ml-2 bg-success/20 text-success border-0 text-[10px]">
                          latest
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-md">
                      {b.notes || <span className="text-muted-foreground/50">—</span>}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {s ? (s.exists ? formatBytes(s.bytes) : '✗ missing') : '…'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(s?.lastModified)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleDownload(b.slug, b.version)}
                        disabled={!s?.exists}
                        className="gap-1.5"
                      >
                        <Download className="w-3 h-3" />
                        zip
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Hint footer */}
      <div className="text-xs text-muted-foreground space-y-1 px-1">
        <p>
          ▸ These zips are rendered <strong>only on this admin page</strong> — non-admins are
          redirected away from /admin so they never see this list.
        </p>
        <p>
          ▸ Files live under <code className="font-mono">public/</code> in the repo and are served
          as static assets by the deployed dashboard.
        </p>
        <p>
          ▸ When you commit a new <code className="font-mono">futnor-extension-vX-Y-Z.zip</code>,
          add a matching entry to <code className="font-mono">EXTENSION_BUILDS</code> at the top of
          this component.
        </p>
      </div>
    </div>
  );
}
