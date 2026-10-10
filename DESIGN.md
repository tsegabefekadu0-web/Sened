---
name: Sened (ሰነድ)
description: A shared ledger for equb and iddir, in Amharic first.
colors:
  brand-green: "#1F6B4A"
  brand-green-dark: "#2C7455"
  ink: "#1C1A17"
  ink-dark: "#F3EEE4"
  body-text: "#4A443C"
  body-text-dark: "#D6CEC0"
  muted-text: "#615A50"
  muted-text-dark: "#B9AFA0"
  page: "#F6F5F2"
  page-dark: "#16130F"
  surface: "#FFFFFF"
  surface-dark: "#201B16"
  hairline: "#E2DED6"
  hairline-dark: "#2E2721"
  hairline-alt: "#EDEAE3"
  hairline-alt-dark: "#2A241E"
  danger: "#8F3A2E"
  danger-dark: "#F4A59C"
  field: "#FFFFFF"
  field-dark: "#1A1612"
  primary-fill: "#1C1A17"
  primary-fill-dark: "#F3EEE4"
  primary-fill-ink: "#FFFFFF"
  primary-fill-ink-dark: "#16130F"
  tibeb-cream: "#F7F0DE"
  tibeb-red: "#A92B22"
  tibeb-green: "#23703F"
  tibeb-gold: "#E3B23C"
  paid: "#2A6B47"
  paid-dark: "#58A178"
  draft: "#E7AE3A"
  draft-dark: "#E3B23C"
  due: "#D8BC88"
  due-dark: "#C6AC7E"
typography:
  display:
    fontFamily: "Bricolage Grotesque, Atkinson Hyperlegible, sans-serif"
    fontSize: "clamp(56px, 8vw, 96px)"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Noto Serif Ethiopic, Abyssinica SIL, serif"
    fontSize: "32px"
    fontWeight: 700
    lineHeight: 1.2
  title:
    fontFamily: "Noto Serif Ethiopic, Abyssinica SIL, serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "Atkinson Hyperlegible, Noto Sans Ethiopic, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Bricolage Grotesque, Atkinson Hyperlegible, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    letterSpacing: "0"
rounded:
  sharp: "14px"
  control: "18px"
  card: "22px"
  sheet: "28px"
  hero: "36px"
  pill: "29px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "22px"
  section: "80px"
  section-desktop: "112px"
components:
  button-primary:
    backgroundColor: "{colors.primary-fill}"
    textColor: "{colors.primary-fill-ink}"
    rounded: "{rounded.pill}"
    padding: "0 32px"
    height: "58px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 32px"
    height: "58px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "20px"
  status-pill:
    backgroundColor: "{colors.hairline-alt}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"
    padding: "0 12px"
    height: "28px"
---

# Design System: Sened

## Overview

**Creative North Star: "The Shared Mesob"**

The mesob — the woven basket table that holds the coffee cups during a ceremony — is the organising metaphor for this entire system. It is an object that holds what a community shares, it is woven by hand from reed and colour, and it sits at the centre of a room so everyone can see into it. Sened's interface is that basket made digital: a warm, low-sided vessel of cream and green that everyone around it can read. The tibeb ribbon that edges the hero and every app header is literally the woven pattern of the mesob's rim, and the `BasketRing` progress ring on the home screen is the same object, drawn as a chart.

The system is **warm, patient, and precise**. Warm: cream paper and hand-woven motifs, never clinical white. Patient: type is generous, controls are large, motion is unhurried and never decorative for its own sake. Precise: because the product's promise is an auditable ledger, numbers are exact, status is unambiguous, and the append-only record is visible rather than hidden. Where those two pull against each other — a treasurer in their seventies, and a cryptographic audit trail — precision wins in the data, warmth wins in the chrome.

**Key Characteristics:**
- One accent, used sparingly: Ethiopian green, on warm cream paper. No second hue competes with it.
- Amharic is the default language; English is the switch. Every screen is designed Amharic-first.
- Tibeb weave (`--tibeb-red`/`--tibeb-gold`/`--tibeb-green`/`--tibeb-cream`) is the signature texture, appearing as ribbon edges, avatar rings, and the BasketRing.
- Numerals render in Geez script (`geez()`) wherever a number is a thing the community reads together — rounds, months, years.
- Dark mode is a full token swap, not a filter. Light and dark were designed separately.
- Motion exists to explain state, never to decorate. 30 keyframes, four durations, three easings.

## Colors

A warm paper base with a single deep green accent, plus the four-colour tibeb weave reserved for ornamental texture and state.

### Primary
- **Brand Green** (`#1F6B4A` light / `#2C7455` dark): the hero band, every app header, the primary filled button, and the "mine" chat bubble. This is the identity colour; it covers large areas and is the reason the app reads as Ethiopian rather than generic.
- **Ink** (`#1C1A17` light / `#F3EEE4` dark): body text and the primary inverted fill. Not pure black — a warm near-black that sits on cream without a harsh edge.

### Secondary
- **Brand Red** (`#A92B22`): one of the four tibeb threads. Used in the woven ribbon and as the accent thread inside identity rings. Never used as a status colour — status has its own vocabulary below.
- **Brand Gold** (`#E3B23C`): the second tibeb thread. Marks the winning basket-ring segment, the scroll-progress hairline, and the winner card's glow. It means *this one is chosen*.
- **Brand Cream** (`#F7F0DE`): the ground of the tibeb weave itself.

### Neutral
- **Page** (`#F6F5F2` light / `#16130F` dark): the app background, overlaid with a faint 1px grain (two repeating linear-gradients at 1.3% opacity) so it reads as paper, not screen.
- **Surface** (`#FFFFFF` light / `#201B16` dark): cards, chat bubbles, list rows.
- **Hairline** (`#E2DED6` light / `#2E2721` dark): borders and dividers.
- **Hairline Alt** (`#EDEAE3` light / `#2A241E` dark): the alternating section band on the landing page (the trust and chat sections).
- **Body Text** (`#4A443C` light / `#D6CEC0` dark): secondary copy, `text-soft`.
- **Muted** (`#615A50` light / `#B9AFA0` dark): captions and metadata.
- **Danger** (`#8F3A2E` light / `#F4A59C` dark): destructive and error only.
- **Paid / Draft / Due** (`#2A6B47`, `#E7AE3A`, `#D8BC88`): the round-progress legend, tokenised so both themes can tune them. They are state, not decoration.

### Named Rules
**The One Accent Rule.** Green is the only accent. Gold and red are tibeb threads — ornamental and state-marking — and never become a third functional colour. If a new feature seems to need a new hue, it needs a new state word instead.

**The Paper Rule.** No pure `#FFFFFF` background and no pure `#000000` ink. Surfaces are tinted (cream, warm grey, or warm near-black) so the whole thing feels like an object rather than a screen.

## Typography

**Display Font:** Bricolage Grotesque (with Atkinson Hyperlegible fallback) — a variable grotesque with unusual width, used for Latin and for all numerals.
**Body Font:** Atkinson Hyperlegible (with Noto Sans Ethiopic fallback) — chosen for maximum legibility at small sizes and for older readers.
**Serif / Amharic Font:** Noto Serif Ethiopic (with Abyssinica SIL) — every Amharic heading and label.
All five families are self-hosted at build time via `next/font`; no runtime request goes to Google.

**Character:** A high-legibility sans for reading, a serif with real Ethiopic lineage for anything spoken or titled, and a quirky grotesque for numbers so that figures feel deliberate rather than incidental.

### Hierarchy
- **Display** (800, `clamp(56px, 8vw, 96px)`, 1.05): the hero wordmark ሰነድ only. Nothing else is this large.
- **Headline** (700, 32px, 1.2 → 44px on desktop): section titles, always `font-serif`, and Amharic-first.
- **Title** (700, 19px, 1.3): card titles and list row headers, `font-serif`.
- **Body** (400, 16px, 1.65): body copy in `text-soft`.
- **Label** (600, 15px): `font-display` for utility text, captions, glosses.

### Named Rules
**The Geez Rule.** Numbers the community reads together — round numbers, month and day names, the 404 code — render in Geez script via `geez()`, not Latin digits. Latin digits are for reference IDs, phone numbers and hashes, where the user is transcribing rather than reading.

**The Two-Font Rule.** Amharic text always uses the serif (`font-serif`); Latin and numerals use display or body. Never mix the two within one heading.

## Layout

Mobile-first, single column, capped at **480px** (`Screen`). The app is a phone layout that grows up, not a desktop layout that shrinks down.

At **1024px and up** the phone column widens to a **1200px** reading measure, a **232px** side rail replaces the bottom bar, and long-form screens (`snd-narrow`) hold a **~760px** column. The app shell has exactly **one** functional breakpoint — 1024px — and it is a hard switch, not a gradual reflow: the side rail and the two-column layouts appear there and nowhere else.

The landing page is a separate, wider system that uses Tailwind's full scale: a **1120px** container with `px-5 md:px-8`, full-bleed coloured bands, and an alternating section rhythm (`py-20 md:py-28`, with the trust and chat sections tinted `hairline-alt`). It reflows at `sm` (640), `md` (768) and `lg` (1024).

Spacing is a loose scale — Tailwind steps of 6, 8, 10, 14, 16, 20, 24 and 40px, used as gaps. The gap between sibling blocks is 3.5 or 4 more often than anything else.

### Named Rules
**The Neighbourhood Rule.** Nothing important sits within 22px of a screen edge. The 480px column and the 1120px landing container both enforce this; new surfaces must too.

## Elevation & Depth

A hybrid: surfaces are flat at rest and gain a single soft shadow only when they need to separate from the page. There is exactly one shadow token per theme.

### Shadow Vocabulary
- **Lift** (`0 12px 28px -14px rgba(28,26,23,0.45)` light / `0 14px 30px -14px rgba(0,0,0,0.75)` dark): cards, and the primary button. Ambient, offset downward, tinted toward the background hue rather than neutral black.
- **Cotton texture** (no shadow; a 1px crosshatch via `--grain2` at 1%): the default card fill. Most cards use this rather than a shadow — depth from texture, not darkness.

### Named Rules
**The Flat-By-Default Rule.** A surface is flat unless it floats. Shadows are structural (card separation, the primary CTA), never decorative. If a card needs a shadow to be noticed, it needs a border instead.

## Shapes

Generous radii, scaled to element size so that inner elements are tighter than their containers.

- **14px** — the brand mark (the ሰ tile).
- **18px** — small controls (language switch track, small tiles).
- **22px** — cards, the BasketRing card, the community card (the workhorse).
- **28px** — the voice sheet on desktop; the draw showpiece panel.
- **36px** — the hero band's bottom corners.
- **29px** — pills, matched to a 58px button height so the ends are true semicircles.
- **9999px** — avatars, status dots, the voice dock's circular cut-out.

Chat bubbles are deliberately asymmetric: `18px 6px 18px 18px` and its mirror, so the tail corner points at the speaker. That asymmetry is the only place corners vary within a component.

### Named Rules
**The Tail Rule.** Only chat bubbles have asymmetric corners. Everything else is uniformly rounded; the exception exists because it carries meaning (who spoke).

## Components

### Buttons
- **Shape:** full pill, 58px tall, `29px` radius, `0 32px` horizontal padding.
- **Primary:** `--prim` fill (ink) with `--primt` text, plus the `lift` shadow. On the green hero it inverts to white-on-green via `bg-white text-[#1C1A17]`.
- **Secondary:** `--card` fill with a `1.5px` `--chipb` border and `--ink` text. Used for the landing page's "See a sample".
- **Tertiary:** a plain text link in `text-soft`, no fill (the "way home" link on `SimpleScreen`).
- **Press:** `scale(0.96)` + `brightness(0.94)` in 40ms — fast enough to feel like a physical touch, not a fade. Mounted globally by `PressFeedback`, which also draws a radial bloom from the touch point.
- **Async:** the primary button runs loading → success → error with a two-arc spinner, a drawn checkmark (`stroke-dashoffset`), and a red shake.

### Cards / Containers
- **Corner:** 22px.
- **Background:** `--card` with the `snd-cotton` grain, `--hair` border.
- **Shadow:** `--lift`, except the very small ones which use text inset for their dots instead.
- **Padding:** 20–22px. Cards overlap the green header with a negative top margin (`-30px` to `-34px`) so the header reads as a band, not a block.

### Status Pills
- **Shape:** full pill, 28px tall, 7px indicator dot.
- **Colors:** set per-instance through `--pc`/`--pb` (light) and `--pcd`/`--pbd` (dark), so each kind can retune independently. Six kinds: paid, draft, due, saved, fixed, void.

### Inputs / Fields
- **Shape:** 18px radius, 52px tall, `1.5px` `--chipb` stroke on `--field`.
- **Text:** 17px — larger than the 16px body default, because these are typed by older users.
- **Focus:** the global 2px `--ink` outline at 3px offset (`:focus-visible`), consistent for every interactive element on the site.

### Navigation
- **Phone:** a 5-column bottom bar with a masked circular cut-out for the central voice dock. The active tab fills with a tinted pill that fades in at 120ms, the accent layer at 220ms, and the icon pops once.
- **Desktop:** a 232px left rail with the wordmark and full-width tab rows; the bottom bar disappears at 1024px.
- **Tab strip:** a woven marker slides from the previous tab to the new one over 320ms, direction computed from the session-stored index.

### Signature Components
- **Tibeb Ribbon:** the woven edge — seven strips (green/gold/red/cream/red/gold/green) with yarn texture and a directional sheen. Weaves in left-to-right on mount via `clip-path`. Horizontal at hero and card bottoms, vertical on the receipt draft.
- **BasketRing:** a pure-SVG progress ring where each member is one coiled arc segment, dyed by payment state, animating in with a delay. This is the mesob as a data display.
- **CoffeeSteps / SiniCup:** the three-ceremony explainer. Cups fill via a `scale` transition; used on both the landing page and the draw.
- **Woven Avatars / Rings:** `snd-conic` repeating-conic tibeb borders around portraits, with a spin-in entrance.
- **Skeleton system:** a `snd-loading` class on a screen root turns every text node into a shimmering bone via `:where()`/`:not()`, and masks paragraphs to line-height so they look like text lines. No JS required.

## Do's and Don'ts

### Do:
- **Do** use `--shop` green for large identity areas (hero, app header) and `--prim` ink for the primary button. They are the two fills.
- **Do** render community-facing numbers in Geez script via `geez()`; reserve Latin digits for IDs, phone numbers and hashes.
- **Do** keep the tibeb weave ornamental — ribbon edges, rings, the BasketRing. It is texture, never a status signal.
- **Do** respect the four motion tiers: `--snd-d1` = 120ms, `--snd-d2` = 200ms, `--snd-d3` = 320ms, `--snd-d4` = 600ms. Every duration in the system is one of these four, paired with one of three easings (`--snd-ease`, `--snd-emph`, `--snd-spring`).
- **Do** write new copy through the typed i18n table (`src/lib/i18n.ts`), English first, then mirrored Amharic. A missing Amharic key is a TypeScript error by design.
- **Do** test new surfaces at both 390px and 1280px. There is one breakpoint, and both layouts must hold.

### Don't:
- **Don't** introduce a second accent hue. Gold and red are tibeb threads; a new functional colour means a new state word, not a new colour.
- **Don't** use pure white or pure black. Surfaces are tinted.
- **Don't** animate `top`, `left`, `width` or `height`. Every animation in the system uses `transform`, `opacity`, `clip-path` or `stroke-dashoffset`.
- **Don't** add motion to the bottom nav or anything triggered 100+ times a day. Keyboard-initiated and high-frequency actions must stay instant.
- **Don't** hardcode a state colour. Paid/draft/due are tokens (`--paid`, `--draft`, `--due`) with separate dark values.
- **Don't** reach for `lucide-react` (it is installed but unused). The 25-icon set in `icons-data.ts` is the icon language: 24px grid, 1.75 stroke, tibeb accents.
- **Don't** ship a surface without checking it in the browser. A screen that compiles can still render as a blank green block.
