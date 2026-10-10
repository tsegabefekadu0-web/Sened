export interface UserProfile {
  readonly id: string;
  readonly name: string;
  readonly phone: string;
  readonly photo: string | null;
  readonly preferredLocale: "am" | "en" | "om";
  readonly preferredTheme: "system" | "light" | "dark";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProfileUpdateInput {
  readonly name?: string;
  readonly phone?: string;
  readonly photo?: string | null;
  readonly preferredLocale?: "am" | "en" | "om";
  readonly preferredTheme?: "system" | "light" | "dark";
}
