import React from "react";

/** A sini cup on a saucer; the coffee fills (scales in) when `filled`. */
export function SiniCup({ filled, id }: { readonly filled: boolean; readonly id?: string }) {
  return (
    <span aria-hidden="true" className="relative shrink-0" style={{ width: 58, height: 46 }}>
      <span className="absolute" style={{ left: 6, right: 6, bottom: 0, height: 8, borderRadius: "50%", background: "radial-gradient(ellipse at center, rgba(60,40,20,0.38), transparent 70%)" }} />
      <span className="absolute" style={{ left: 21, width: 16, bottom: 2, height: 5, borderRadius: 2, background: "#CFC8B8" }} />
      <span
        className="absolute overflow-hidden"
        style={{
          left: 10,
          width: 38,
          bottom: 5,
          height: 24,
          borderRadius: "0 0 19px 19px / 0 0 24px 24px",
          background: "linear-gradient(90deg, #D6D0C2, #FFFFFF 36%, #EEE9DE 68%, #CBC4B3)",
          boxShadow: "inset 0 -4px 5px rgba(60,40,20,0.14)"
        }}
      >
        <span className="absolute left-0 right-0" style={{ top: 10, height: 1.5, background: "#E3B23C" }} />
        <span className="absolute left-0 right-0" style={{ top: 14, height: 3, background: "repeating-linear-gradient(90deg, #A92B22 0 2px, transparent 2px 5px)", opacity: 0.85 }} />
        <span className="absolute left-0 right-0" style={{ top: 19, height: 1, background: "#23703F", opacity: 0.8 }} />
      </span>
      <span className="absolute" style={{ left: 8, width: 42, bottom: 21, height: 16, borderRadius: "50%", background: "linear-gradient(180deg, #FFFFFF, #E4DED1)", boxShadow: "0 1px 0 rgba(60,40,20,0.22)" }}>
        <span className="absolute" style={{ inset: 2, borderRadius: "50%", background: "#EFE8DA", boxShadow: "inset 0 2px 3px rgba(60,40,20,0.35)" }}>
          <span
            id={id}
            data-filled={filled}
            className="absolute"
            style={{
              left: "50%",
              top: "50%",
              width: "100%",
              height: "100%",
              transform: `translate(-50%, -50%) scale(${filled ? 1 : 0.2})`,
              opacity: filled ? 1 : 0,
              transition: "transform 700ms var(--snd-emph), opacity 240ms var(--snd-ease)",
              borderRadius: "50%",
              background: "radial-gradient(circle at 38% 30%, #7A4A2A, #2E170A 70%)",
              boxShadow: "0 0 0 1px rgba(46,23,10,0.4)"
            }}
          />
        </span>
      </span>
    </span>
  );
}

/**
 * The three coffee-ceremony steps (abol, tona, baraka), each a sini cup that
 * fills as the step is reached. Used by the draw and the landing page.
 */
export function CoffeeSteps({
  steps,
  filled,
  label
}: {
  readonly steps: ReadonlyArray<{ readonly name: string; readonly text: string }>;
  /** How many cups are filled (0..steps.length). */
  readonly filled: number;
  readonly label: string;
}) {
  return (
    <ol aria-label={label} className="snd-cotton m-0 list-none overflow-hidden rounded-[22px] border border-hair bg-card p-0">
      {steps.map((s, i) => (
        <li
          key={s.name}
          className="box-border flex min-h-[68px] items-center gap-3.5"
          style={{ padding: "0 18px 0 12px", borderBottom: i < steps.length - 1 ? "1px solid var(--hair2)" : undefined }}
        >
          <SiniCup filled={filled > i} />
          <span lang="am" className="flex min-w-0 items-baseline gap-2 text-base text-soft">
            <span className="font-serif text-[19px] font-bold text-ink">{s.name}</span>
            <span aria-hidden="true">·</span>
            <span>{s.text}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
