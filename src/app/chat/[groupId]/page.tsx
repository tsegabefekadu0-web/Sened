"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import React, { useEffect, useRef, useState } from "react";

import { Icon, type IconName } from "@/components/ui/Icon";
import { BottomNav } from "@/components/ui/BottomNav";
import { ChannelList } from "@/components/ui/ChannelList";
import { Screen } from "@/components/ui/primitives";
import { WovenRing } from "@/components/ui/Weave";
import { useActiveGroup } from "@/lib/groups/useActiveGroup";
import { SAMPLE_CHANNEL_ID, useChannel, type ChatItem } from "@/lib/ui/chatStore";
import { useCommunity } from "@/lib/ui/useCommunity";
import { useDesktop } from "@/lib/ui/useDesktop";
import { useT } from "@/lib/ui/useT";
import { VoiceRecorder, isRecordingSupported } from "@/lib/voice/recorder";

const WAVE = [8, 14, 20, 12, 24, 16, 9, 22, 14, 26, 12, 18, 8, 20, 13, 24, 10, 16, 22, 12, 8, 18, 14, 10];

export default function ChannelPage() {
  const params = useParams<{ groupId: string }>();
  const channelId = params?.groupId ?? SAMPLE_CHANNEL_ID;
  const { t } = useT();
  const group = useActiveGroup();
  const c = useCommunity();
  const desktop = useDesktop();
  const ch = useChannel(channelId, c);
  const [draft, setDraft] = useState("");
  const [rec, setRec] = useState(false);
  const [secs, setSecs] = useState(0);
  const [rsvp, setRsvp] = useState<"" | "yes" | "no">("");
  const [notice, setNotice] = useState<string | null>(null);
  const recorder = useRef<VoiceRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const endRef = useRef<HTMLLIElement | null>(null);

  const info = group.groups.find((g) => g.groupId === channelId);
  const name = ch.sample ? "የቦሌ ሰፈር እቁብ" : info?.name || c.groupName || t("ui.home.noName");
  const memberCount = c.members.length;

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [ch.items.length]);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
      recorder.current?.cancel();
    },
    []
  );

  const startRec = async () => {
    setNotice(null);
    if (!isRecordingSupported()) {
      setNotice(t("ui.chat.noMic"));
      return;
    }
    const r = new VoiceRecorder({ barCount: 8, onError: () => setNotice(t("ui.chat.noMic")) });
    recorder.current = r;
    try {
      await r.start();
      setRec(true);
      setSecs(0);
      timer.current = setInterval(() => setSecs((s) => s + 1), 1000);
    } catch {
      recorder.current = null;
      setNotice(t("ui.chat.noMic"));
    }
  };
  const stopRec = async () => {
    if (timer.current) clearInterval(timer.current);
    const r = recorder.current;
    recorder.current = null;
    setRec(false);
    const result = r ? await r.stop() : null;
    if (result && result.quality.usable) {
      ch.sendVoice(`data:${result.mimeType};base64,${result.audioBase64}`, Math.max(1, Math.round(result.durationMs / 1000)));
    } else {
      setNotice(t("voice.captureTooShort"));
    }
  };
  const cancelRec = () => {
    if (timer.current) clearInterval(timer.current);
    recorder.current?.cancel();
    recorder.current = null;
    setRec(false);
  };

  const typing = draft.trim().length > 0;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!typing) return;
    ch.send(draft);
    setDraft("");
  };

  return (
    <Screen loading={c.mode === "loading" && !ch.sample}>
      <main className="flex grow flex-col">
        <header className="relative flex items-center gap-0.5 overflow-hidden text-white" style={{ background: "var(--shop)", padding: "8px 8px 72px 6px", borderRadius: "0 0 28px 28px" }}>
          <div className="flex w-full items-center gap-0.5 lg:mx-auto lg:max-w-[1200px]">
          <Link href="/chat" aria-label={t("ui.chat.back")} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white">
            <Icon name="back" size={22} />
          </Link>
          <Link href="/members" aria-label={t("ui.members.title")} className="flex min-h-14 min-w-0 grow items-center gap-3 text-white">
            <WovenRing size={48}>
              <span lang="am" className="flex h-full w-full items-center justify-center rounded-full bg-card font-serif text-xl font-bold text-ink">
                {Array.from(name)[0]}
              </span>
            </WovenRing>
            <span className="flex min-w-0 grow flex-col">
              <h1 lang="am" className="m-0 truncate font-serif text-[19px] font-bold leading-[1.25]">
                {name}
              </h1>
              <span lang="am" className="text-sm opacity-90">
                {memberCount} {t("ui.members.count")}
              </span>
            </span>
            <span aria-hidden="true" className="flex opacity-90">
              <Icon name="next" size={22} />
            </span>
          </Link>
          <Link href="/ledger" aria-label={t("ui.nav.ledger")} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white">
            <Icon name="more" size={22} />
          </Link>
          </div>
          <span aria-hidden="true" className="snd-weave absolute left-0 right-0 flex flex-col overflow-hidden" style={{ bottom: 40, height: 22, boxShadow: "0 5px 8px -3px rgba(0,0,0,0.5)" }}>
            <RibbonBody />
          </span>
        </header>

        {/* Phones: one column (the wrappers vanish). Desktop: the chat list on the left, this conversation on the right. */}
        <div className="contents lg:mx-auto lg:grid lg:w-full lg:max-w-[1200px] lg:grow lg:grid-cols-[380px_minmax(0,1fr)] lg:items-stretch lg:gap-x-8">
        {desktop ? (
          <div className="lg:self-start">
            <ChannelList activeId={channelId} />
          </div>
        ) : null}
        <div className="contents lg:flex lg:min-w-0 lg:flex-col">
        <p lang="am" role="note" data-testid="chat-note" className="snd-rise relative m-0 flex items-center gap-3 rounded-[22px] border border-hair bg-card text-sm leading-[1.5] text-soft" style={{ margin: "-26px 16px 0", padding: "12px 14px", boxShadow: "var(--lift)" }}>
          <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full" style={{ background: "var(--tint)", color: "var(--shop)" }}>
            <Icon name="pin" size={20} />
          </span>
          <span>{ch.sample ? t("ui.chat.sampleNote") : t("ui.chat.localNote")}</span>
        </p>

        <ul aria-label={t("ui.chat.messages")} className="m-0 flex grow list-none flex-col gap-2.5 p-0" style={{ padding: "18px 16px 24px" }}>
          {ch.items.map((it, i) => (
            <li key={it.id} style={{ animation: it.kind === "msg" && it.id.startsWith("local") ? "snd-msg 320ms var(--snd-emph) both" : "snd-rise 420ms var(--snd-emph) both", animationDelay: it.id.startsWith("local") ? undefined : `${Math.min(i, 9) * 40 + 160}ms` }}>
              <Item it={it} reacted={ch.reacted} onReact={ch.toggleReaction} rsvp={rsvp} setRsvp={setRsvp} />
            </li>
          ))}
          <li ref={endRef} aria-hidden="true" />
        </ul>

        {notice ? (
          <p role="status" lang="am" className="mx-4 mb-2 text-center text-sm text-muted">
            {notice}
          </p>
        ) : null}

        <form onSubmit={submit} className="sticky bottom-0 z-[5] m-0 flex items-center gap-2 border-t border-hair bg-card" style={{ padding: "10px 10px 14px" }}>
          {rec ? (
            <>
              <div className="flex h-12 min-w-0 flex-1 items-center gap-2.5 rounded-3xl bg-hair2 px-3.5">
                <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full" style={{ background: "#C9392E", animation: "snd-rec 1.2s ease-in-out infinite" }} />
                <span className="min-w-[38px] font-display text-base font-bold">{`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`}</span>
                <span aria-hidden="true" className="flex h-[30px] grow items-center gap-[3px] overflow-hidden">
                  {WAVE.slice(0, 14).map((h, k) => (
                    <span key={k} className="snd-bar block" style={{ width: 3, height: h + 2, borderRadius: 2, background: "currentColor", opacity: 0.8, animation: `snd-bar 900ms ease-in-out ${-k * 70}ms infinite` }} />
                  ))}
                </span>
              </div>
              <RoundBtn label={t("ui.cancel")} icon="close" onClick={cancelRec} ghost />
              <RoundBtn label={t("ui.chat.sendVoice")} icon="send" onClick={() => void stopRec()} brand />
            </>
          ) : (
            <>
              <RoundBtn label={t("ui.chat.attach")} icon="attach" ghost disabled />
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t("ui.chat.write")}
                aria-label={t("ui.chat.message")}
                className="h-12 min-w-0 flex-1 rounded-3xl border-[1.5px] border-[var(--chipb)] bg-field px-[18px] text-base text-ink"
              />
              {typing ? <RoundBtn label={t("ui.chat.send")} icon="send" brand type="submit" /> : <RoundBtn label={t("ui.chat.record")} icon="mic" onClick={() => void startRec()} />}
            </>
          )}
        </form>
        </div>
        </div>
      </main>
      <BottomNav railOnly active="chat" />
    </Screen>
  );
}

function RibbonBody() {
  return (
    <>
      <span style={{ flex: "0 0 2px", background: "var(--rgreen)" }} />
      <span style={{ flex: "0 0 1px", background: "var(--rgold)" }} />
      <span style={{ flex: "0 0 2px", background: "var(--rred)" }} />
      <span className="snd-weave-tex" style={{ flex: "1 1 auto", backgroundSize: "12px 12px" }} />
      <span style={{ flex: "0 0 2px", background: "var(--rred)" }} />
      <span style={{ flex: "0 0 1px", background: "var(--rgold)" }} />
      <span style={{ flex: "0 0 2px", background: "var(--rgreen)" }} />
      <span className="snd-yarn absolute inset-0" />
      <span className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(255,255,255,var(--sheen)), rgba(255,255,255,0) 38%, rgba(0,0,0,0.20))" }} />
    </>
  );
}

function RoundBtn({
  label,
  icon,
  onClick,
  brand,
  ghost,
  disabled,
  type = "button"
}: {
  readonly label: string;
  readonly icon: IconName;
  readonly onClick?: () => void;
  readonly brand?: boolean;
  readonly ghost?: boolean;
  readonly disabled?: boolean;
  readonly type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex shrink-0 items-center justify-center rounded-full border-none p-0 disabled:opacity-40"
      style={{
        width: ghost ? 44 : 48,
        height: ghost ? 44 : 48,
        background: ghost ? "transparent" : brand ? "var(--shop)" : "var(--prim)",
        color: ghost ? "var(--muted)" : brand ? "#FFFFFF" : "var(--primt)",
        animation: ghost ? undefined : "snd-pop 240ms var(--snd-spring) both"
      }}
    >
      <Icon name={icon} size={22} />
    </button>
  );
}

function Item({
  it,
  reacted,
  onReact,
  rsvp,
  setRsvp
}: {
  readonly it: ChatItem;
  readonly reacted: Set<string>;
  readonly onReact: (id: string, which: "ack" | "smile") => void;
  readonly rsvp: "" | "yes" | "no";
  readonly setRsvp: (v: "" | "yes" | "no") => void;
}) {
  const { t } = useT();
  if (it.kind === "day") {
    return (
      <div className="flex items-center gap-3 py-1.5">
        <span className="h-px flex-1 bg-hair" />
        <span lang="am" className="font-serif text-sm font-bold text-muted">
          {it.label}
        </span>
        <span className="h-px flex-1 bg-hair" />
      </div>
    );
  }
  if (it.kind === "sys") {
    return (
      <Link href={it.href} className="box-border flex min-h-[52px] items-center gap-3 rounded-2xl border border-dashed border-[var(--chipb)] bg-hair2 px-3.5 py-2 text-[15px] font-bold leading-[1.4] text-ink">
        <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: "var(--tint)", color: "var(--shop)" }}>
          <Icon name={it.icon} size={18} />
        </span>
        <span lang="am" className="min-w-0 grow">
          {it.text}
        </span>
        <span aria-hidden="true" className="flex text-muted">
          <Icon name="next" size={18} />
        </span>
      </Link>
    );
  }
  const mine = it.mine;
  const bubble = mine
    ? { background: "color-mix(in srgb, var(--shop) 82%, #000)", border: "1px solid transparent", color: "#FFFFFF" }
    : { background: "var(--bubble)", border: "1px solid var(--hair)", color: "var(--ink)" };
  const rx = (which: "ack" | "smile") => {
    const base = it.react?.[which];
    if (base === undefined) return null;
    const on = reacted.has(`${it.id}:${which}`);
    return (
      <button key={which} type="button" aria-label={t(which === "ack" ? "ui.chat.ack" : "ui.chat.react")} aria-pressed={on} onClick={() => onReact(it.id, which)} className="flex h-11 items-center border-none bg-transparent px-0.5">
        <span
          className="inline-flex h-[30px] items-center gap-1.5 rounded-[15px] px-3 text-sm font-bold"
          style={on ? { background: "color-mix(in srgb, var(--shop) 18%, transparent)", color: "var(--shop)", boxShadow: "inset 0 0 0 1.5px var(--shop)", animation: "snd-pop 260ms var(--snd-spring) both" } : { background: "var(--hair2)", color: "var(--soft)", boxShadow: "inset 0 0 0 1px var(--hair)" }}
        >
          <Icon name={which === "ack" ? "check" : "smile"} size={16} />
          <span>{base + (on ? 1 : 0)}</span>
        </span>
      </button>
    );
  };
  return (
    <div className="flex items-end gap-2.5" style={{ justifyContent: mine ? "flex-end" : "flex-start" }}>
      {!mine ? (
        <WovenRing size={40}>
          <span lang="am" className="flex h-full w-full items-center justify-center rounded-full bg-card font-serif text-base font-bold">
            {it.initial}
          </span>
        </WovenRing>
      ) : null}
      <div className="flex min-w-0 flex-col gap-[3px]" style={{ maxWidth: it.coffee ? 290 : "78%", alignItems: mine ? "flex-end" : "flex-start" }}>
        {!mine ? (
          <span className="flex items-center gap-2 pl-1 text-[13px] font-bold text-muted">
            <span lang="am">{it.who}</span>
            {it.badge ? (
              <span lang="am" className="inline-flex h-[22px] items-center rounded-[11px] px-2 text-[13px] font-bold" style={{ background: "var(--chipcol-bg)", color: "var(--chipcol)" }}>
                {t("ui.role.treasurer")}
              </span>
            ) : null}
          </span>
        ) : null}
        <div
          className="box-border flex flex-col gap-2"
          style={{ ...bubble, padding: it.coffee ? 14 : "10px 14px", borderRadius: mine ? "18px 6px 18px 18px" : "6px 18px 18px 18px", minWidth: it.voice ? 236 : undefined, width: it.coffee ? 290 : undefined }}
        >
          {it.quote ? (
            <div className="mb-1.5 flex flex-col gap-px py-1 pl-2.5" style={{ borderLeft: `3px solid ${mine ? "#E3B23C" : "var(--shop)"}` }}>
              <span lang="am" className="text-[13px] font-bold opacity-90">
                {it.quote.name}
              </span>
              <span lang="am" className="text-sm leading-[1.4] opacity-85">
                {it.quote.text}
              </span>
            </div>
          ) : null}
          {it.text ? (
            <p lang="am" className="m-0 text-base leading-[1.55] [overflow-wrap:anywhere]">
              {it.text}
            </p>
          ) : null}
          {it.voice ? <VoiceNote voice={it.voice} mine={mine} /> : null}
          {it.coffee ? (
            <>
              <span className="flex items-center gap-2.5">
                <span aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: "var(--tint)", color: "var(--shop)" }}>
                  <Icon name="cup" size={22} />
                </span>
                <span lang="am" className="font-serif text-xl font-bold">
                  {t("ui.chat.coffee")}
                </span>
              </span>
              <span lang="am" className="text-base font-bold">
                {t("ui.chat.coffeeTitle")}
              </span>
              <span lang="am" className="text-[15px] leading-[1.5] text-soft">
                {t("ui.chat.coffeeWhen")}
                <br />
                {t("ui.chat.coffeeWhere")}
              </span>
              <span className="flex gap-2">
                {(["yes", "no"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    lang="am"
                    aria-pressed={rsvp === v}
                    onClick={() => setRsvp(v)}
                    className="h-11 flex-1 cursor-pointer rounded-3xl text-[15px] font-bold"
                    style={rsvp === v ? { border: "none", background: "var(--prim)", color: "var(--primt)" } : { border: "1.5px solid var(--chipb)", background: "transparent", color: "var(--ink)" }}
                  >
                    {t(v === "yes" ? "ui.chat.rsvpYes" : "ui.chat.rsvpNo")}
                  </button>
                ))}
              </span>
            </>
          ) : null}
        </div>
        {it.react ? (
          <div className="-mt-0.5 flex gap-1">
            {rx("ack")}
            {rx("smile")}
          </div>
        ) : null}
        <span className="flex items-center gap-1.5 px-1 text-[13px] text-muted">
          <span>{it.time}</span>
          {mine && it.sending ? (
            <span aria-hidden="true" className="flex h-4 w-4" style={{ animation: "snd-spin360 900ms linear infinite" }}>
              <Icon name="replay" size={16} />
            </span>
          ) : null}
          {mine && !it.sending ? (
            <span aria-label={t("ui.chat.read")} className="flex" style={{ color: "var(--shop)" }}>
              <Icon name="checks" size={16} />
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

function VoiceNote({ voice, mine }: { readonly voice: { readonly dur: string; readonly transcript: string; readonly src?: string }; readonly mine: boolean }) {
  const { t } = useT();
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const toggle = () => {
    if (!voice.src) return;
    if (!audio.current) {
      audio.current = new Audio(voice.src);
      audio.current.onended = () => setPlaying(false);
    }
    if (playing) {
      audio.current.pause();
      setPlaying(false);
    } else {
      void audio.current.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  };
  useEffect(() => () => audio.current?.pause(), []);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2.5">
        <button
          type="button"
          aria-label={playing ? t("ui.chat.pause") : t("ui.chat.play")}
          onClick={toggle}
          disabled={!voice.src}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-none p-0"
          style={{ background: mine ? "rgba(255,255,255,0.22)" : "var(--tint)", color: mine ? "#FFFFFF" : "var(--shop)" }}
        >
          <Icon name={playing ? "stop" : "play"} size={20} />
        </button>
        <span aria-hidden="true" className="flex h-8 grow items-center gap-[3px]">
          {WAVE.map((h, i) => (
            <span key={i} style={{ width: 3, height: h, borderRadius: 2, background: "currentColor", opacity: 0.8 }} />
          ))}
        </span>
        <span className="font-display text-sm font-bold">{voice.dur}</span>
      </span>
      {voice.transcript ? (
        <span lang="am" className="text-sm leading-[1.4] opacity-85">
          {voice.transcript}
        </span>
      ) : null}
    </div>
  );
}
