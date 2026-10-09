import * as THREE from "three";

/**
 * The equb draw ceremony as a three.js scene: a woven mesob opens its lid, folded
 * name slips swirl, one rises, unfolds and faces the room. The whole ceremony is a
 * pure function of time (`frame(t)`), so replay and reduced motion are trivial.
 * Ported from the approved R9 design (tools/scene-methods).
 */

interface Band {
  readonly from: number;
  readonly to: number;
  readonly type: "solid" | "diamond" | "zig";
  readonly main: string;
  readonly tile?: number;
  readonly back?: string | null;
}

export interface MesobSceneOptions {
  readonly canvas: HTMLCanvasElement;
  /** One letter per slip (7 shown). */
  readonly letters: readonly string[];
  readonly winnerName: string;
  readonly roundLabel: string;
  readonly groupName: string;
}

export const CEREMONY_END = 5.9;

export class MesobScene {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(28, 1, 0.5, 80);
  private root = new THREE.Group();
  private lid = new THREE.Group();
  private slips: THREE.Group[] = [];
  private rest: { pos: THREE.Vector3; rot: THREE.Euler }[] = [];
  private ang: number[] = [];
  private spd: number[] = [];
  private sheet!: THREE.Mesh;
  private sheetMat!: THREE.MeshBasicMaterial;
  private readonly W = 2;
  private repaint: Array<() => void> = [];
  private raf = 0;
  private t0 = 0;
  private forceT: number | null = null;
  private ro: ResizeObserver | null = null;
  private w = 0;
  private h = 0;
  private pr = 0;
  private disposed = false;
  onProgress: (t: number) => void = () => undefined;
  onLost: () => void = () => undefined;

  constructor(private readonly opts: MesobSceneOptions) {
    const r = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: true, alpha: true, powerPreference: "low-power" });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.setClearColor(0x000000, 0);
    this.renderer = r;
    this.buildLights();
    this.buildMesob();
    this.buildSlips();
    opts.canvas.addEventListener("webglcontextlost", this.lost);
    const parent = opts.canvas.parentElement;
    if (parent && typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => {
        this.fit();
        if (this.forceT !== null) this.drawOnce();
      });
      this.ro.observe(parent);
    }
    this.fit(true);
  }

  private lost = () => {
    this.onLost();
  };

  /** Run the animation from t=0; with `still` draw only the finished frame. */
  start(still: boolean): void {
    cancelAnimationFrame(this.raf);
    this.t0 = performance.now();
    if (still) {
      this.forceT = 8;
      this.drawOnce();
      return;
    }
    this.forceT = null;
    const loop = (now: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      if (!this.fit()) return;
      const t = (now - this.t0) / 1000;
      this.frame(t);
      this.renderer.render(this.scene, this.camera);
      this.onProgress(t);
    };
    this.raf = requestAnimationFrame(loop);
  }

  drawOnce(): void {
    if (this.disposed || !this.fit()) return;
    this.frame(this.forceT ?? 8);
    this.renderer.render(this.scene, this.camera);
    this.onProgress(99);
  }

  private fit(force = false): boolean {
    const p = this.opts.canvas.parentElement;
    if (!p) return false;
    let w = p.clientWidth;
    let h = p.clientHeight;
    if (!(w > 1 && h > 1)) {
      const r = p.getBoundingClientRect();
      w = Math.round(r.width);
      h = Math.round(r.height);
    }
    if (!(w > 1 && h > 1)) return false;
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    if (force || w !== this.w || h !== this.h || pr !== this.pr) {
      this.w = w;
      this.h = h;
      this.pr = pr;
      this.renderer.setPixelRatio(pr);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    return true;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.opts.canvas.removeEventListener("webglcontextlost", this.lost);
    this.ro?.disconnect();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (mat) {
        (Array.isArray(mat) ? mat : [mat]).forEach((m) => {
          (m as THREE.MeshStandardMaterial).map?.dispose();
          m.dispose();
        });
      }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
  }

  private buildLights(): void {
    const s = this.scene;
    s.add(new THREE.HemisphereLight(0xfff1dc, 0x2a6b47, 1.5));
    const key = new THREE.DirectionalLight(0xffe7c4, 2.6);
    key.position.set(4, 8, 6);
    s.add(key);
    const rim = new THREE.DirectionalLight(0xcdeedd, 1.6);
    rim.position.set(-6, 4, -5);
    s.add(rim);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-4, 2, 6);
    s.add(fill);
  }

  /** Coiled-straw texture: natural grass coils bound with slanted stitches; dyed rows form diamond bands. */
  private weaveTexture(rows: number, bands: readonly Band[], w: number, h: number): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d") as CanvasRenderingContext2D;
    const rh = h / rows;
    const cw = 10;
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let r = 0; r < rows; r++) {
      const y = r * rh;
      const band = bands.find((b) => r >= b.from && r < b.to);
      g.fillStyle = r % 2 ? "#CDA566" : "#C59A5B";
      g.fillRect(0, y, w, rh);
      const gr = g.createLinearGradient(0, y, 0, y + rh);
      gr.addColorStop(0, "rgba(255,240,205,0.55)");
      gr.addColorStop(0.35, "rgba(255,240,205,0)");
      gr.addColorStop(0.8, "rgba(60,30,10,0.18)");
      gr.addColorStop(1, "rgba(50,24,8,0.62)");
      g.fillStyle = gr;
      g.fillRect(0, y, w, rh);
      for (let x = 0; x < w; x += cw) {
        const cx = x + cw / 2;
        let col: string | null = null;
        if (band) {
          const k = r - band.from;
          const H = band.to - band.from;
          const tile = band.tile ?? 40;
          if (band.type === "solid") col = band.main;
          else if (band.type === "diamond") {
            const d = Math.abs((((cx % tile) + tile) % tile) - tile / 2);
            const hw = (tile / 2) * (1 - Math.abs(2 * k - (H - 1)) / H);
            col = d <= hw ? band.main : band.back || null;
          } else {
            const ph = ((cx % tile) + tile) % tile;
            const tri = ph < tile / 2 ? ph / (tile / 2) : 2 - ph / (tile / 2);
            col = Math.abs(tri * (H - 1) - k) < 0.8 ? band.main : band.back || null;
          }
        }
        if (col) {
          g.fillStyle = col;
          g.fillRect(x + 0.5, y + 1.5, cw - 1, rh - 3);
        }
        g.strokeStyle = col ? "rgba(0,0,0,0.38)" : "rgba(70,36,12,0.34)";
        g.lineWidth = 1.4;
        g.beginPath();
        g.moveTo(x + 1, y + rh - 1.5);
        g.lineTo(x + cw * 0.75, y + 1.5);
        g.stroke();
        g.strokeStyle = "rgba(255,240,205,0.28)";
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x + 3, y + rh - 1.5);
        g.lineTo(x + cw * 0.75 + 2, y + 1.5);
        g.stroke();
        if (rnd() < 0.08) {
          g.fillStyle = "rgba(255,230,180,0.22)";
          g.fillRect(x, y + 2, cw, rh * 0.35);
        }
      }
      g.fillStyle = "rgba(40,20,6,0.5)";
      g.fillRect(0, y + rh - 1.5, w, 1.5);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  }

  private buildMesob(): void {
    const T = THREE;
    const S = this.scene;
    const RED = "#8E2A22";
    const GREEN = "#23703F";
    const BLACK = "#1C1A17";
    const ORANGE = "#D9822B";
    const PLUM = "#5A2D6E";
    const P = (a: number[][]) => a.map((p) => new T.Vector2(p[0], p[1]));
    const lathe = (pts: number[][], tex: THREE.Texture, rough = 0.88) =>
      new T.Mesh(new T.LatheGeometry(P(pts), 72), new T.MeshStandardMaterial({ map: tex, roughness: rough, metalness: 0, side: T.DoubleSide }));
    const root = (this.root = new T.Group());
    S.add(root);
    const sc = document.createElement("canvas");
    sc.width = sc.height = 128;
    const sg = sc.getContext("2d") as CanvasRenderingContext2D;
    const rg = sg.createRadialGradient(64, 64, 6, 64, 64, 62);
    rg.addColorStop(0, "rgba(8,28,18,0.62)");
    rg.addColorStop(1, "rgba(8,28,18,0)");
    sg.fillStyle = rg;
    sg.fillRect(0, 0, 128, 128);
    const shadow = new T.Mesh(new T.PlaneGeometry(5.2, 5.2), new T.MeshBasicMaterial({ map: new T.CanvasTexture(sc), transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.01;
    S.add(shadow);
    const stemTex = this.weaveTexture(
      20,
      [
        { from: 5, to: 7, type: "solid", main: RED },
        { from: 12, to: 13, type: "solid", main: BLACK },
        { from: 15, to: 18, type: "diamond", tile: 40, main: GREEN, back: null }
      ],
      768,
      384
    );
    root.add(lathe([[1.0, 0], [1.0, 0.07], [0.92, 0.14], [0.64, 0.3], [0.45, 0.6], [0.4, 0.95], [0.45, 1.2], [0.72, 1.46], [0.98, 1.6]], stemTex));
    const bowlTex = this.weaveTexture(
      38,
      [
        { from: 3, to: 5, type: "solid", main: RED },
        { from: 6, to: 7, type: "solid", main: BLACK },
        { from: 8, to: 15, type: "diamond", tile: 80, main: GREEN, back: ORANGE },
        { from: 16, to: 17, type: "solid", main: BLACK },
        { from: 19, to: 21, type: "solid", main: RED },
        { from: 23, to: 29, type: "zig", tile: 60, main: PLUM, back: null },
        { from: 31, to: 32, type: "solid", main: BLACK },
        { from: 33, to: 36, type: "solid", main: GREEN }
      ],
      1536,
      768
    );
    root.add(lathe([[0.55, 1.4], [0.9, 1.5], [1.3, 1.72], [1.56, 2.0], [1.66, 2.3]], bowlTex));
    const inTex = this.weaveTexture(26, [], 1024, 512);
    root.add(lathe([[1.66, 2.3], [1.58, 2.3], [1.5, 2.18], [1.2, 1.92], [0.8, 1.74], [0.0, 1.68]], inTex, 0.95));
    const lacquer = new T.MeshStandardMaterial({ color: 0x8e2a22, roughness: 0.55 });
    const rim = new T.Mesh(new T.TorusGeometry(1.67, 0.075, 10, 72), lacquer);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 2.3;
    root.add(rim);
    const lidTex = this.weaveTexture(
      40,
      [
        { from: 2, to: 4, type: "solid", main: RED },
        { from: 5, to: 6, type: "solid", main: BLACK },
        { from: 7, to: 14, type: "diamond", tile: 90, main: GREEN, back: ORANGE },
        { from: 15, to: 16, type: "solid", main: BLACK },
        { from: 18, to: 24, type: "zig", tile: 70, main: RED, back: null },
        { from: 26, to: 27, type: "solid", main: BLACK },
        { from: 28, to: 31, type: "solid", main: PLUM }
      ],
      1536,
      768
    );
    const lid = (this.lid = new T.Group());
    lid.position.set(0, 2.3, -1.66);
    const lidBody = new T.Group();
    lidBody.position.z = 1.66;
    lid.add(lidBody);
    lidBody.add(lathe([[1.72, 0], [1.7, 0.06], [1.58, 0.42], [1.3, 0.82], [0.9, 1.18], [0.5, 1.4], [0.2, 1.52], [0.0, 1.56]], lidTex));
    const knob = new T.Mesh(new T.SphereGeometry(0.17, 20, 14), new T.MeshStandardMaterial({ color: 0x6b3a1f, roughness: 0.6 }));
    knob.position.y = 1.62;
    knob.scale.y = 0.8;
    lidBody.add(knob);
    const lrim = new T.Mesh(new T.TorusGeometry(1.72, 0.07, 10, 72), lacquer);
    lrim.rotation.x = Math.PI / 2;
    lrim.position.y = 0.04;
    lidBody.add(lrim);
    const gold = new T.Mesh(new T.TorusGeometry(1.7, 0.024, 8, 72), new T.MeshStandardMaterial({ color: 0xe3b23c, roughness: 0.35, metalness: 0.4 }));
    gold.rotation.x = Math.PI / 2;
    gold.position.y = 0.14;
    lidBody.add(gold);
    root.add(lid);
  }

  private inkTexture(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, w: number, h: number): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    const paint = () => {
      draw(c.getContext("2d") as CanvasRenderingContext2D, w, h);
      t.needsUpdate = true;
    };
    paint();
    this.repaint.push(paint);
    return t;
  }

  private paper(g: CanvasRenderingContext2D, w: number, h: number): void {
    g.fillStyle = "#F6EDD6";
    g.fillRect(0, 0, w, h);
    let s = 11;
    for (let i = 0; i < (w * h) / 90; i++) {
      s = (s * 16807) % 2147483647;
      const x = s % w;
      const y = (s >> 7) % h;
      g.fillStyle = `rgba(120,90,40,${0.03 + (s % 7) / 120})`;
      g.fillRect(x, y, 1 + (s % 3), 1);
    }
  }

  private buildSlips(): void {
    const T = THREE;
    const letters = Array.from({ length: 7 }, (_, i) => this.opts.letters[i % Math.max(this.opts.letters.length, 1)] ?? "ሰ");
    const geo = new T.BoxGeometry(0.58, 0.44, 0.07);
    const plain = new T.MeshStandardMaterial({ color: 0xf1e6cb, roughness: 0.9 });
    let seed = 5;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    letters.forEach((ch, i) => {
      const tex = this.inkTexture((g, w, h) => {
        this.paper(g, w, h);
        g.fillStyle = "rgba(60,40,20,0.12)";
        g.fillRect(0, h / 2 - 1, w, 2);
        g.fillStyle = "#2A1A0C";
        g.font = "700 58px 'Noto Serif Ethiopic', serif";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(ch, w / 2, h / 2 + 4);
      }, 160, 120);
      const face = new T.MeshStandardMaterial({ map: tex, roughness: 0.9 });
      const folded = new T.Mesh(geo, [plain, plain, plain, plain, face, face]);
      const grp = new T.Group();
      grp.add(folded);
      grp.userData.folded = folded;
      this.scene.add(grp);
      this.slips.push(grp);
      const a = rnd() * 6.283;
      const r = 0.25 + rnd() * 0.75;
      this.rest.push({
        pos: new T.Vector3(Math.cos(a) * r, 1.76 + i * 0.045, Math.sin(a) * r),
        rot: new T.Euler(Math.PI / 2 + (rnd() - 0.5) * 0.3, rnd() * 6.283, (rnd() - 0.5) * 0.3)
      });
      this.ang.push(i * 0.8975);
      this.spd.push(1.5 + 0.22 * (i % 3));
    });
    const { winnerName, roundLabel, groupName } = this.opts;
    const sheetTex = this.inkTexture((g, w, h) => {
      this.paper(g, w, h);
      const lg = g.createLinearGradient(0, 0, 0, h);
      lg.addColorStop(0, "rgba(255,255,255,0.35)");
      lg.addColorStop(1, "rgba(120,90,40,0.12)");
      g.fillStyle = lg;
      g.fillRect(0, 0, w, h);
      g.fillStyle = "rgba(60,40,20,0.10)";
      g.fillRect(w / 2 - 1, 0, 2, h);
      g.fillRect(0, h / 2 - 1, w, 2);
      const stripe = (y: number) => {
        g.fillStyle = "#23703F";
        g.fillRect(0, y, w, 5);
        g.fillStyle = "#E3B23C";
        g.fillRect(0, y + 5, w, 3);
        g.fillStyle = "#A92B22";
        g.fillRect(0, y + 8, w, 5);
      };
      stripe(26);
      stripe(h - 39);
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = "#615A50";
      g.font = "600 34px 'Noto Sans Ethiopic', sans-serif";
      g.fillText(roundLabel, w / 2, 92);
      g.fillStyle = "#1C1A17";
      let size = 118;
      g.font = `700 ${size}px 'Noto Serif Ethiopic', serif`;
      while (g.measureText(winnerName).width > w - 80 && size > 40) {
        size -= 6;
        g.font = `700 ${size}px 'Noto Serif Ethiopic', serif`;
      }
      g.fillText(winnerName, w / 2, h / 2 + 18);
      g.fillStyle = "#615A50";
      g.font = "600 32px 'Noto Sans Ethiopic', sans-serif";
      g.fillText(groupName, w / 2, h - 88);
    }, 900, 570);
    this.sheetMat = new T.MeshBasicMaterial({ map: sheetTex, transparent: true, opacity: 1, side: T.DoubleSide });
    const sheet = (this.sheet = new T.Mesh(new T.PlaneGeometry(2.2, 1.392), this.sheetMat));
    const back = new T.Mesh(new T.PlaneGeometry(2.28, 1.46), new T.MeshBasicMaterial({ color: 0x0b2a1a, transparent: true, opacity: 0.12, depthWrite: false }));
    back.position.z = -0.012;
    back.position.y = -0.03;
    sheet.add(back);
    sheet.visible = false;
    this.slips[this.W].add(sheet);
    if (document.fonts?.load) {
      Promise.all([document.fonts.load("700 40px 'Noto Serif Ethiopic'", winnerName), document.fonts.load("600 30px 'Noto Sans Ethiopic'", "ዕጣ ዙር")])
        .then(() => this.repaint.forEach((p) => p()))
        .catch(() => undefined);
    }
  }

  private orbit(i: number, t: number): THREE.Vector3 {
    const a = this.ang[i] + t * this.spd[i];
    const r = 0.78 + 0.26 * Math.sin(t * 1.7 + i * 2.1);
    return new THREE.Vector3(Math.cos(a) * r, 2.78 + 0.5 * Math.sin(t * 2.3 + i * 1.3), Math.sin(a) * r);
  }

  /** The whole ceremony as a pure function of time t (seconds). */
  frame(t: number): void {
    const T = THREE;
    const cl = (x: number) => Math.min(1, Math.max(0, x));
    const sg = (a: number, b: number) => cl((t - a) / (b - a));
    const eio = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
    const eo = (x: number) => 1 - Math.pow(1 - x, 3);
    this.root.rotation.y = Math.sin(t * 0.5) * 0.3 * (0.4 + 0.6 * eio(sg(0, 1.5)));
    const open = eio(sg(0.7, 2.2));
    this.lid.rotation.x = -1.9 * open;
    this.lid.position.y = 2.3 + 0.32 * Math.sin(Math.PI * sg(0.45, 1.5));
    const swAll = eio(sg(1.9, 2.8));
    const swOut = 1 - eio(sg(3.6, 4.6));
    const W = this.W;
    const sep = 3.4;
    this.slips.forEach((grp, i) => {
      const rest = this.rest[i];
      const amp = i === W ? swAll : swAll * swOut;
      const tt = i === W ? Math.min(t, sep) : t;
      const o = this.orbit(i, tt);
      const p = rest.pos.clone().lerp(o, amp);
      const spin = new T.Euler(
        rest.rot.x * (1 - amp) + (-0.75 + 0.35 * Math.sin(tt * 2.2 + i)) * amp,
        rest.rot.y + tt * 2.2 * amp,
        rest.rot.z * (1 - amp) + 0.3 * Math.sin(tt * 1.9 + i * 1.7) * amp
      );
      grp.position.copy(p);
      grp.rotation.copy(spin);
      grp.scale.setScalar(1);
      if (i === W) {
        const s = eio(sg(sep, sep + 1.2));
        const target = new T.Vector3(0, 4.35, 1.6);
        grp.position.copy(p.lerp(target, s));
        const q0 = new T.Quaternion().setFromEuler(spin);
        const q1 = new T.Quaternion().setFromEuler(new T.Euler(-0.12, 0, 0));
        grp.quaternion.copy(q0.slerp(q1, s));
        const u = eio(sg(4.5, 5.7));
        grp.scale.setScalar(1 + 0.55 * s);
        const folded = grp.userData.folded as THREE.Object3D;
        folded.visible = u < 0.55;
        this.sheet.visible = u > 0.02;
        this.sheet.scale.set(0.15 + 0.85 * u, 0.15 + 0.85 * eo(u), 1);
        this.sheetMat.opacity = cl(u * 3);
        grp.position.y += Math.sin(Math.max(0, t - 5.6) * 1.5) * 0.07 * sg(5.6, 6.2);
      }
    });
    const c = this.camera;
    const z = eio(sg(4.2, 5.8));
    const out = eio(sg(0.6, 2.2));
    c.position.set(0, 5.4 + 0.5 * out, 11.6 + 1.3 * out + 0.2 * z);
    c.lookAt(0, 2.5 + 0.4 * out, 0);
  }
}
