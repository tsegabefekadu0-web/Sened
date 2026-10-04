export const en = {
  "a.one": "Hello",
  "a.count": "{count} members in round {round}",
  "a.quote": "Say \"hi\"",
  "b.one": "Keep me"
} as const;

export type MessageKey = keyof typeof en;

const am: Record<MessageKey, string> = {
  "a.one": "ሰላም",
  "a.count": "{count} አባላት በዙር {round}",
  "a.quote": "ሰላም",
  "b.one": "ተው"
};
