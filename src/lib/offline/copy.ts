/**
 * Lane-local copy for the offline console.
 *
 * `src/lib/i18n.ts` belongs to AGENT-2 alone (§4.1), and `MessageKey` is derived
 * from the `en` dictionary while `am` is typed `Record<MessageKey, string>` — so
 * a key added to `en` without its Amharic twin is a compile error I am not
 * allowed to fix in that file. Every triple below is filed verbatim in
 * `docs/requests/agent-4.md` (R3) and in
 * `docs/architecture/offline-pwa.md` §6 for A2 to fold in. This table must be
 * deleted at integration.
 *
 * Both languages are present for every string, always (§12.6). There is no
 * English fallback path that would silently render an Ethiopian treasurer an
 * untranslated screen.
 */

export const OFFLINE_COPY = {
  "offline.title": {
    en: "Offline ledger desk",
    am: "የመስመር መዝገብ ጠረጴዛ"
  },
  "offline.subtitle": {
    en: "Record contributions with no connection. Nothing here is in the ledger until it syncs.",
    am: "ያለ ግንኙነት ስጠታዎችን ይመዝግቡ። እስኪመልስ እስከም አንድም ነገር አልተካተለም።"
  },
  "offline.connectivity.online": {
    en: "Online",
    am: "ተገናኝቷል"
  },
  "offline.connectivity.offline": {
    en: "No connection",
    am: "ግንኙነት የለም"
  },
  "offline.connectivity.unknown": {
    en: "Connection unknown",
    am: "የግንኙነት ሁኔታ አውቅቷል"
  },
  "offline.storage.unavailable": {
    en: "This device cannot store anything offline, so nothing can be recorded here.",
    am: "ይህ መሣሪያ ከመስመር ላይ ምንም ማስቀመጥ አይችልም፤ ስለዚህ እነዚህ ላይ ምንም መመዝግብ አይቻልም።"
  },
  "offline.storage.full": {
    en: "This device is out of storage. Free space before recording more.",
    am: "የይህ መሣሪያ ቦታ አልቋል። ከበለጠ መመዝግብዎ በፊት ቦታ ያስቀምሩ።"
  },
  "offline.roster.title": {
    en: "Roster on this device",
    am: "በዚህ መሣሪያ ላይ ያለው የአባላት ዝርዝር"
  },
  "offline.roster.empty": {
    en: "No members are stored on this device yet. They arrive after the first sync.",
    am: "በዚህ መሣሪያ ላይ እስካሁን አባላት የለም። ከመጀመሪያው ማስመሳለያ በኋላ ይደርሳሉ።"
  },
  "offline.roster.onDeviceTotal": {
    en: "Recorded on this device, not in the ledger: {amount}",
    am: "በዚህ መሣሪያ ላይ የተመዘገበ፣ በመዝገቡ ውስጥ በስተቀር የለም፦ {amount}"
  },
  "offline.roster.memberCount": {
    en: "{count} members",
    am: "{count} አባላት"
  },
  "offline.notes.title": {
    en: "Spoken notes",
    am: "የተናገሩ ማስታወሻዎች"
  },
  "offline.notes.empty": {
    en: "No notes are stored on this device yet.",
    am: "በዚህ መሣሪያ ላይ እስካሁን ማስታወሻዎች የለም።"
  },
  "offline.notes.transcriptLabel": {
    en: "What was said",
    am: "ምን ተናገር"
  },
  "offline.notes.transcriptPlaceholder": {
    en: "Type or dictate the contribution as it was spoken",
    am: "በቃል እንደተናገረው ስጠታውን ይጻፉ ወይም ይጨምሩ"
  },
  "offline.notes.amountLabel": {
    en: "Amount in birr",
    am: "በብር የሚሆን መጠን"
  },
  "offline.notes.channelLabel": {
    en: "How it was paid",
    am: "እንዴት እንደተከፈለ"
  },
  "offline.notes.save": {
    en: "Save note on this device",
    am: "ማስታወሻውን በዚህ መሣሪያ ላይ አስቀምጥ"
  },
  "offline.notes.saved": {
    en: "Saved on this device. It has not been sent to the ledger.",
    am: "በዚህ መሣሪያ ላይ ተስቀምጧል። ወደ መዝገቡ አልተላከም።"
  },
  "offline.notes.source.humanTyped": {
    en: "Typed by hand",
    am: "በእጅ ተጻፍቷል"
  },
  "offline.notes.source.asr": {
    en: "Transcribed by speech recognition",
    am: "በድምፅ ማረጋገጫ ተቀርቧል"
  },
  "offline.notes.noHash": {
    en: "Integrity hashing is unavailable on this connection, so this note is not hashed.",
    am: "በዚህ ግንኙነት ላይ የታስተካከል አስተማርጠኛ ግንዙነት የለም፤ ስለዚህ ይህ ማስታወሻ አልተሰራም።"
  },
  "offline.notes.deleteBlocked": {
    en: "This note is still waiting to sync. It can only be deleted after it settles.",
    am: "ይህ ማስታወሻ እየጠበቀ ነው። ከተረጋጠነ በኋላ ብቻ ልለጸመር ይችላሉ።"
  },
  "offline.drafts.title": {
    en: "Draft ledger entries",
    am: "የማስከረዳ የመዝገብ መግቦች"
  },
  "offline.drafts.empty": {
    en: "No draft entries yet. Compose one below.",
    am: "እስካሁን የማስከረዳ መግቦች የለም። ከታች አንድ ይምረጡ።"
  },
  "offline.drafts.draftOnly": {
    en: "Draft — not sent",
    am: "ማስከረዳ — አልተላክም"
  },
  "offline.drafts.amountLabel": {
    en: "Amount in birr",
    am: "በብር የሚሆን መጠን"
  },
  "offline.drafts.entryTypeLabel": {
    en: "Entry kind",
    am: "የመዝገቡ ዓይነት"
  },
  "offline.drafts.cashAccountLabel": {
    en: "Cash account",
    am: "የጥሬ ሂሳብ"
  },
  "offline.drafts.incomeAccountLabel": {
    en: "Contribution income account",
    am: "የስጠታ ገቢ ሂሳብ"
  },
  "offline.drafts.occurredAtLabel": {
    en: "When it happened",
    am: "የተከሳተው ጊዜ"
  },
  "offline.drafts.save": {
    en: "Save as draft",
    am: "እንደማስከረዳ አስቀምጥ"
  },
  "offline.drafts.saved": {
    en: "Draft saved on this device. It has not been queued.",
    am: "የማስከረዳ መዝገቡ በዚህ መሣሪያ ላይ ተስቀምጧል። ወደ ወረፋ አልተላከም።"
  },
  "offline.drafts.queuedSaved": {
    en: "Queued on this device. It will be sent when there is a connection.",
    am: "በዚህ መሣሪያ ላይ ተሮምሯል። ግንኙነት ሲኖር ይላካል።"
  },
  "offline.drafts.queue": {
    en: "Queue for sync",
    am: "ለማስመሳለያ ወረፋ ላይ አስገባ"
  },
  "offline.drafts.queued": {
    en: "Queued — waiting to sync",
    am: "በወረፋ ላይ — ማስመሳለያን እየጠበቀ ነው"
  },
  "offline.drafts.unbalanced": {
    en: "A ledger entry must balance: the debits and credits must be equal.",
    am: "የመዝገብ መግቢያ ማመጣጠኝ ካለበለድ፦ ብርሃዎችና ክሬዲቶች እኩል መሆናቸው አለበት።"
  },
  "offline.drafts.invalidAmount": {
    en: "That amount is not a valid birr value.",
    am: "ያ መጠን ትክክል የብር እሴት አይደለም።"
  },
  "offline.queue.title": {
    en: "Sync queue",
    am: "የማስመሳለያ ወረፋ"
  },
  "offline.queue.empty": {
    en: "Nothing is waiting to sync.",
    am: "ለማስመሳለያ የሚጠብቅ ምንም የለም።"
  },
  "offline.queue.oldest": {
    en: "Oldest waiting since {date}",
    am: "ከመጀመሪያው ጀምሮ {date} ጀምሮ የሚጠብቅ"
  },
  "offline.mirror.empty": {
    en: "This device has no confirmed entries yet. A chain head appears after the first successful pull.",
    am: "ይህ መሣሪያ ገና የምንም የተረጋገጠ መግቢያ የለም። ከመጀመሪያው የተሳካ ገባ በኋላ የተከታታይ ርዕስ ይታያል።"
  },
  "offline.mirror.entries": {
    en: "Confirmed entries on this device: {count}",
    am: "በዚህ መሣሪያ ላይ የተረጋገጡ መግቦች፦ {count}"
  },
  "offline.integrity.sequenceValue": {
    en: "Sequence {sequence}",
    am: "ተከታታይ {sequence}"
  },
  "offline.notes.delete": {
    en: "Delete this note",
    am: "ይህን ማስታወሻ አጥፋ"
  },
  "offline.queue.synced": {
    en: "Synced",
    am: "ተመሳልቷል"
  },
  "offline.queue.syncedBody": {
    en: "The server accepted this and returned entry {entry}.",
    am: "አገልጋይው ይህን ተቀብሏል ከመዝገብ {entry} ጋር መልሷል።"
  },
  "offline.queue.pending": {
    en: "Waiting to sync",
    am: "ለማስመሳለያ ይጠብቃል"
  },
  "offline.queue.retrying": {
    en: "Will retry",
    am: "እንደገና ይሞክራል"
  },
  "offline.queue.rejected": {
    en: "Rejected by the server",
    am: "በአገልጋዩ ውድቅ ተደርጓል"
  },
  "offline.queue.blocked": {
    en: "Needs a person",
    am: "ሰው ያስፈልጋል"
  },
  "offline.sync.title": {
    en: "Sync",
    am: "ማስመሳለያ"
  },
  "offline.sync.notConfigured": {
    en: "The sync service is not configured yet, so queued work stays on this device.",
    am: "የማስመሳለያ አገልግሎቱ ገና አልቋቀረም፤ በወረፋ ላይ ያለው ሥራ በዚህ መሣሪያ ላይ ይቀራል።"
  },
  "offline.sync.pull": {
    en: "Pull from server",
    am: "ከአገልጋይ ገባ"
  },
  "offline.sync.push": {
    en: "Send queued work",
    am: "የወረፋ ላይ ያለውን ሥራ ላክ"
  },
  "offline.sync.needsToken": {
    en: "Sign in before syncing. No credential is stored on this device.",
    am: "ከመማስመሳለያ በፊት ይግቡ። በዚህ መሣሪያ ላይ ምንም ምልክት አይቀምጠም።"
  },
  "offline.sync.drained": {
    en: "Sent {sent} of {total}.",
    am: "ከ{total} ውስጥ {sent} ተልኳል።"
  },
  "offline.sync.nothingQueued": {
    en: "There was nothing queued to send.",
    am: "ለማስተላከት ምንም በወረፋ ላይ አልነበረም።"
  },
  "offline.sync.ahead": {
    en: "This device is {count} entries behind the server. Nothing conflicts.",
    am: "ይህ መሣሪያ ከአገልጋዩ {count} መግቦች ወደኋላ ነው። ምንም ግጭት የለም።"
  },
  "offline.sync.identical": {
    en: "This device and the server agree on the whole chain.",
    am: "ይህ መሣሪያና አገልጋዩ ስለ ሙሉ የመስክ ተስማምተዋል።"
  },
  "offline.divergence.title": {
    en: "Ledger histories have split",
    am: "የመዝገብ ታሪኮች ተዋግደዋል"
  },
  "offline.divergence.explain": {
    en: "Two devices recorded different entries for the same position in the chain. Sened cannot merge them, because an append-only chain has no merge. Nothing was deleted or rewritten — a person has to decide what the group actually agreed.",
    am: "ሁለት መሣሪያዎች በተከታታይ መስፍ ላይ የተያያዙ ልዩ መግቦች አስቀምጠዋል። Sened አንድም ያለ አይዋልቃል፤ ምክንያቱም በአካል የሚጨምር የመስክ ያለው መፃሙ የለም። ምንም አልተጠፋረቀም ወይም አልተቀየረም — ቡዙኑ ምን ስምምተቋቸው ይሆን አስፈልጋል።"
  },
  "offline.divergence.forkAt": {
    en: "They agree through sequence {prefix}, then differ at sequence {fork}.",
    am: "እስከ ተከታታይ {prefix} ድረስ ተስማምተዋል፤ ከዚያ በተከታታይ {fork} ላይ ይለያሉ።"
  },
  "offline.divergence.localBroken": {
    en: "The copy on this device is damaged. It has not been repaired or deleted.",
    am: "በዚህ መሣሪያ ላይ ያለው ቅጂ ተጎዳል። አልተጠረገረም ወይም አልተጠፋረቀም።"
  },
  "offline.divergence.acceptServer": {
    en: "Treat the server's chain as the record",
    am: "የአገልጋዩን ተከታታይ እንደ መዝገብ ተቀበል"
  },
  "offline.divergence.escalate": {
    en: "Keep both and escalate to the group",
    am: "ሁለቱንም ያስቀምጥና ወደ ቡዙኑ አላስተላለፍ"
  },
  "offline.divergence.resolved": {
    en: "A person recorded a decision on {date}.",
    am: "በ{date} ሰው ውሳኔ አስቀምጧል።"
  },
  "offline.a11y.state": {
    en: "Sync state",
    am: "የማስመሳለያ ሁኔታ"
  },
  "offline.a11y.hashUnavailable": {
    en: "Integrity hash unavailable",
    am: "የታስተካከል አስተማርጠኛ ግንዙነት የለም"
  }
} as const;

export type OfflineCopyKey = keyof typeof OFFLINE_COPY;

export type OfflineLocale = "en" | "am";

/**
 * Resolve a lane-local string.
 *
 * Throws on an unknown key rather than returning the key itself. A missing
 * translation must be a loud failure in development, not an Ethiopian treasurer
 * reading a raw key on a Sunday.
 */
export function offlineCopy(
  locale: OfflineLocale,
  key: OfflineCopyKey,
  variables: Readonly<Record<string, string | number>> = {}
): string {
  const entry = OFFLINE_COPY[key];
  if (!entry) {
    throw new Error(`Unknown offline copy key: ${String(key)}`);
  }
  return entry[locale].replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = variables[name];
    return value === undefined ? placeholder : String(value);
  });
}
