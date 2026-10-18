# ⚠️ TARGETING & DM FLOW CONTRACT — DO NOT MODIFY

> **This document defines the critical targeting and DM engagement flow.**
> **Any future changes MUST NOT break these contracts.**

---

## 🔒 Protected Functions (instagram/content.js)

### 1. `getHashtagResultPostLinks()`
- MUST return links for BOTH `/p/` AND `/reel/` posts
- MUST NOT filter out reels — Instagram hashtag pages are mostly reels
- Selectors MUST include: `a[href*="/p/"]` AND `a[href*="/reel/"]`

### 2. `isInstagramHashtagRoute()`
- MUST detect classic `/explore/tags/` paths
- MUST detect search-based `/explore/search/keyword/?q=%23tag` paths
- Both routes are valid hashtag pages — never reject either

### 3. `engageNextHashtagPost()`
- MUST attempt thumbnail username extraction first (fast-path)
- MUST fall back to modal extraction if thumbnail fails
- MUST save username to `chrome.storage.local` key `futnor_hashtag_target_username`
- MUST support both `/p/` and `/reel/` post types

### 4. `extractUsernameFromThumbnail(postLink)`
- Extracts username from post grid without opening modal
- Critical for speed and reliability

### 5. DM Engagement Sequence
- Open profile → Find Message button → Open DM thread → Check for existing messages → Send if new → Return to grid
- MUST use scoring-based button detection (`findOptionsButton`)
- MUST handle `/direct/new/` redirect by typing username
- MUST check for existing outgoing messages before sending
- MUST NOT send to accounts already in DM history

---

## 🔒 Protected Functions (background.js)

### 1. Hashtag username polling loop
- MUST poll `futnor_hashtag_target_username` from `chrome.storage.local`
- MUST use at least 40 iterations (20 seconds) — never reduce
- Located in the hashtag targeting branch of `runSession()`

### 2. Pre-navigation skip check
- MUST check DM history before navigating to profile
- MUST check processed accounts cache

### 3. Session action dispatch
- `sendActionToTab()` MUST handle all action types: scroll, like, follow, dm, dm_skipped
- MUST support reconnect recovery

---

## 🔒 Targeting Modes (ALL must work independently)

| Mode | Navigation | Extraction |
|------|-----------|------------|
| `hashtags` | `/explore/tags/{tag}` or search route | Grid → thumbnail/modal → username |
| `location` | Location page URL | Grid → post → username |
| `followers` | `/{username}/followers/` | Follower list → usernames |
| `following` | `/{username}/following/` | Following list → usernames |
| `likers` | Post → likers dialog | Liker list → usernames |
| `commenters` | Post → comments | Comment authors → usernames |
| `custom` | Direct profile navigation | From custom username list |

### Rules
- Targeting modes are **mutually exclusive** (single-element array)
- Each mode has its own navigation and extraction logic
- NEVER share extraction logic between modes in ways that could break one when fixing another
- Custom username lists are platform-specific

---

## ⛔ NEVER DO

1. Never filter out `/reel/` links from hashtag grid results
2. Never reduce the polling timeout below 20 seconds (40 iterations)
3. Never remove the thumbnail fast-path extraction
4. Never skip the DM history deduplication check
5. Never change the `futnor_hashtag_target_username` storage key
6. Never make hashtag route detection reject search-based URLs
7. Never modify DM send logic without verifying existing-message detection still works
8. Never combine targeting mode logic in ways that create cross-mode dependencies

---

## ✅ SAFE TO CHANGE

- UI styling and labels
- Adding new targeting modes (as long as existing ones aren't touched)
- Adding new stats/logging
- Changing delay values (within reason)
- Adding new filters that are additive (not replacing existing ones)
