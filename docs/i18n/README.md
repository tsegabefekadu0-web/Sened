# Amharic review kit

Many Amharic strings in `src/lib/i18n.ts` were written by non-native authors.
Nothing here asserts that any translation is correct. This kit only makes a
native-speaker review fast and safe.

## Files

| File | What it is |
| --- | --- |
| `amharic-review.csv` | One row per UI string (the sheet you fill in). UTF-8 with BOM, opens correctly in Excel. |
| `amharic-hardcoded.csv` | Ethiopic text found outside `i18n.ts` (`file`, `line`, `text`). Not covered by the sheet; check these separately. |

Regenerate both with `npm run i18n:review`. Regenerating overwrites the sheet, so
finish and apply a review round before regenerating.

## Filling the sheet

Do not edit `key`, `area`, `english`, `amharic`, `placeholders`, `status`, `notes`.
Fill only the last three columns:

- `reviewer_amharic`: your replacement text. Leave empty to keep the current text.
- `reviewer_ok`: put `yes` if the current text is fine as it is (informational only, not applied).
- `reviewer_comment`: anything the developers should know (context needed, wrong English, etc.).

Columns for reading:

- `area`: the key prefix (for example `drawLive`, `governance`), to review one screen at a time.
- `placeholders`: `{name}` tokens that the app fills in at runtime. Your text must contain
  every one of them, spelled exactly the same, and no others. Their order can change to fit Amharic grammar.
  Attach suffixes directly, as the current text does (`{round}ን`).
- `status`: `new` = the key was added, or its Amharic changed, since commit `951e66f`; `existing` = unchanged since then.
  Review `new` rows first (they are sorted to the top).
- `notes`: mechanical flags only, they are not judgments of quality:

| Flag | Meaning | What to do |
| --- | --- | --- |
| `placeholder-missing:` / `placeholder-extra:` | Amharic and English use different `{tokens}` | A bug. Fix it (the importer refuses rows with mismatches). |
| `am-empty` | No Amharic text | Provide it. |
| `am-identical-to-en` | Amharic equals English | Often fine (numbers, `ETB`, the language name); change it if it should be translated. |
| `no-ethiopic` | No Ge'ez characters at all | Same as above. |
| `latin-words:` | Latin-script words other than the allowed brands (Telebirr, CBE, Awash, Links.et, Voxide, ScholarXIV, Sened, ETB, PWA) | Technical terms (`arXiv`, `bps`, `Chrome`) may be intentional; replace or confirm. |
| `length-ratio-short:` / `length-ratio-long:` | Amharic is under 0.3x or over 3x the English length (graphemes) | Amharic is naturally shorter, so short single words are often fine; look for omitted meaning. |

Keep punctuation conventions consistent with the current text (`።` full stop, `፦`, `፤`, `፣`).

## Terms to keep consistent

These are the recurring Amharic terms **as currently written, please confirm** (taken from the dictionary, not endorsed).
Where the dictionary is itself inconsistent, both forms are listed so you can choose one.

| Concept | Currently written | Notes |
| --- | --- | --- |
| Equb | ዕቁብ | `governance.option.equb` |
| Iddir | ዕድር | `governance.option.iddir` |
| draw | እጣ (also እጣው) | most common word for the draw |
| pot | ድምር (`drawLive.cyclePot`: የዙር ድምር); ቀሪ ሂሳብ in `audio.script.potBalance` | two forms in use |
| treasurer | ገንዘብ ያዥ (ያዡ) | |
| member | አባል / አባላት | |
| contribution | መዋጮ (የመዋጮ) | |
| verified | የተረጋገጠ | bank-verified is `በባንክ`, treasurer-recorded is `በገንዘብ ያዥ የተመዘገበ` |
| ledger | መዝገብ (most common), ደብተር (`ደብተሩ`, `የደብተር መዝገብ`) | both in use, e.g. `ledger entry` = `የደብተር መዝገብ` |
| guarantor | ዋስ (ዋሱ); guarantee = ዋስትና | |
| reserve | ክምችት (ክምችቱ); መጠባበቂያ also appears | two forms in use |
| round | ዙር (ዙሮች) | |
| cycle | ዑደት | |
| nonce | ቁጥር / ምስጢር ቁጥር (`drawLive.disagree.nonceDigest`); release = መልቀቅ | |
| seal | ማሸጊያ (ማሸጊያዎቹ); sealed = ዘግቷል / ሲዘጉ | |
| commitment | መቆለፊያ (መቆለፊያው); commit = ቆልፍ | |

## Applying a reviewed sheet

```
npm run i18n:apply-review -- path/to/reviewed.csv           # dry run: prints a diff, writes nothing
npm run i18n:apply-review -- path/to/reviewed.csv --apply   # writes src/lib/i18n.ts
```

- Only rows with a non-empty `reviewer_amharic` are used. The default CSV is `docs/i18n/amharic-review.csv`.
- Rows are refused (and listed, exit code 1) if the key is unknown, the `{placeholders}` differ from English,
  the key appears twice, or the text contains a line break. Other rows still apply.
- Only the Amharic value for that key is rewritten. `en` and all other text are untouched; the diff stays small.
- Afterwards run `npx tsc --noEmit`, `npm run lint`, `npx vitest run`, then review `git diff` before committing.

`test/i18n.amharic-integrity.test.ts` fails if any Amharic value is empty or its placeholders differ from English.
