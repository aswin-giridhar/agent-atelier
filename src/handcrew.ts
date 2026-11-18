/**
 * Handcrew — build and conduct a crew of AI agents with your hands.
 *
 * Everything here is procedural (no external assets): a desk with role cores
 * (left), a forge pad (centre) and task cards (right). Drop a core on the forge
 * to create an agent; touch two agents together to team them; drop a task card
 * on an agent to run its team. Agents pause for human approval at risky steps.
 * The crew, its links and finished work persist in localStorage.
 */
import {
  BoxGeometry,
  CanvasTexture,
  createSystem,
  CylinderGeometry,
  DoubleSide,
  Entity,
  Grabbed,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OneHandGrabbable,
  PlaneGeometry,
  PokeInteractable,
  Pressed,
  RayInteractable,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from '@iwsdk/core';
import { AgentTag, ButtonTag, CardTag, CoreTag } from './handcrew-components.js';
import { ROLES, RoleId, TASKS, runStep, StepResult } from './agent-engine.js';

// ---------------------------------------------------------------- layout
const DESK_Y = 0.78; // desk top height — seated reach
const DESK_Z = -0.62;
const FORGE = new Vector3(0, DESK_Y + 0.02, -0.55);
const STORAGE_KEY = 'handcrew.v1';

// ---------------------------------------------------------------- text labels
interface Label {
  mesh: Mesh;
  draw: (lines: string[], accent?: string, portrait?: HTMLImageElement) => void;
}

/** Runware-generated role portraits, drawn into speech bubbles. */
const PORTRAITS: Record<string, HTMLImageElement> = {};
for (const r of ['scout', 'builder', 'scribe', 'critic']) {
  const img = new Image();
  img.src = `${import.meta.env.BASE_URL}portraits/${r}.jpg`;
  PORTRAITS[r] = img;
}

function makeLabel(widthM: number, heightM: number, pxPerM = 900, bg = 'rgba(14,16,24,0.88)'): Label {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(widthM * pxPerM);
  canvas.height = Math.round(heightM * pxPerM);
  const ctx = canvas.getContext('2d')!;
  const tex = new CanvasTexture(canvas);
  const mesh = new Mesh(
    new PlaneGeometry(widthM, heightM),
    new MeshBasicMaterial({ map: tex, transparent: true, side: DoubleSide, depthWrite: false }),
  );
  mesh.renderOrder = 10;
  const draw = (lines: string[], accent = '#7cf', portrait?: HTMLImageElement) => {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const r = Math.min(w, h) * 0.12;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, r);
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = Math.max(3, h * 0.02);
    ctx.stroke();
    const pad = h * 0.1;
    let y = pad;
    let x0 = pad;
    if (portrait && portrait.complete && portrait.naturalWidth > 0) {
      const s = h - pad * 2;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(pad, pad, s, s, s * 0.18);
      ctx.clip();
      ctx.drawImage(portrait, pad, pad, s, s);
      ctx.restore();
      x0 = pad * 2 + s;
    }
    lines.forEach((line, i) => {
      const size = i === 0 ? h * 0.2 : h * 0.14;
      const lineCount = i === 0 ? 1 : 1;
      ctx.font = `${i === 0 ? 700 : 500} ${size}px system-ui, sans-serif`;
      ctx.fillStyle = i === 0 ? accent : '#e9ecf4';
      // naive wrap
      const words = line.split(' ');
      let cur = '';
      const out: string[] = [];
      for (const word of words) {
        const test = cur ? cur + ' ' + word : word;
        if (ctx.measureText(test).width > w - x0 - pad && cur) {
          out.push(cur);
          cur = word;
        } else cur = test;
      }
      if (cur) out.push(cur);
      for (const o of out.slice(0, 4 * lineCount)) {
        y += size * 1.05;
        ctx.fillText(o, x0, y);
      }
      y += size * 0.25;
    });
    tex.needsUpdate = true;
  };
  return { mesh, draw };
}

// ---------------------------------------------------------------- audio
let audioCtx: AudioContext | null = null;
function beep(freq: number, dur = 0.12, type: OscillatorType = 'sine', gain = 0.08) {
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur);
  } catch {
    /* audio is decorative; never block interaction on it */
  }
}
const chord = (notes: number[]) => notes.forEach((n, i) => setTimeout(() => beep(n, 0.25, 'triangle'), i * 90));

// ---------------------------------------------------------------- state types
interface AgentData {
  id: number;
  role: RoleId;
  name: string;
  xp: number;
  entity: Entity;
  root: Group;
  body: Mesh;
  halo: Mesh;
  flag: Mesh;
  bubble: Label;
  bubbleText: string[];
  thinking: boolean;
  waiting: boolean;
  bornAt: number;
}

interface LinkData {
  a: AgentData;
  b: AgentData;
  line: Mesh;
}

interface RunState {
  taskIndex: number;
  queue: AgentData[];
  step: number;
  phase: 'think' | 'speak' | 'approve' | 'handoff' | 'done';
  timer: number;
  pending?: StepResult;
  transcript: string[];
  pulse: Mesh;
}

interface SavedCrew {
  agents: { id: number; role: RoleId; name: string; xp: number; pos: [number, number, number] }[];
  links: [number, number][];
  shelf: { task: string; summary: string }[];
  runs: number;
}

// ---------------------------------------------------------------- system
export class HandcrewSystem extends createSystem({
  grabbedCores: { required: [CoreTag, Grabbed] },
  grabbedAgents: { required: [AgentTag, Grabbed] },
  grabbedCards: { required: [CardTag, Grabbed] },
  pressedButtons: { required: [ButtonTag, Pressed] },
}) {
  private agents: AgentData[] = [];
  private links: LinkData[] = [];
  private nextId = 1;
  private coreHome = new Map<Entity, { role: RoleId; home: Vector3 }>();
  private cardHome = new Map<Entity, { task: number; home: Vector3 }>();
  private buttons = new Map<Entity, { kind: 'approve' | 'reject' | 'reset'; root: Object3D }>();
  private agentByEntity = new Map<Entity, AgentData>();
  private run: RunState | null = null;
  private board!: Label;
  private shelfLabels: Label[] = [];
  private shelf: { task: string; summary: string }[] = [];
  private runs = 0;
  private approvalRoot!: Group;
  private forgeRing!: Mesh;
  private headPos = new Vector3();
  private tmp = new Vector3();
  private tmp2 = new Vector3();
  private up = new Vector3(0, 1, 0);
  private welcomeBack = false;
  private elapsed = 0;

  init(): void {
    this.buildDesk();
    this.buildBoard();
    this.buildCores();
    this.buildCards();
    this.buildApproval();
    this.restore();
    this.refreshBoard(
      this.welcomeBack
        ? `Welcome back! Your crew of ${this.agents.length} kept your ${this.shelf.length} finished job${this.shelf.length === 1 ? '' : 's'} on the shelf. Hand them a new task.`
        : undefined,
    );

    this.queries.grabbedCores.subscribe('disqualify', (e) => this.onCoreReleased(e));
    this.queries.grabbedAgents.subscribe('disqualify', (e) => this.onAgentReleased(e));
    this.queries.grabbedCards.subscribe('disqualify', (e) => this.onCardReleased(e));
    this.queries.grabbedCores.subscribe('qualify', () => beep(520, 0.06));
    this.queries.grabbedCards.subscribe('qualify', () => beep(620, 0.06));
    this.queries.grabbedAgents.subscribe('qualify', (e) => {
      const a = this.agentByEntity.get(e);
      if (a) this.say(a, [`${a.name}`, 'Touch me to a teammate to link us.']);
      beep(440, 0.06);
    });
    this.queries.pressedButtons.subscribe('qualify', (e) => this.onButton(e));
  }

  // ------------------------------------------------------------ scene build
  private buildDesk() {
    const desk = new Mesh(
      new BoxGeometry(1.5, 0.04, 0.62),
      new MeshStandardMaterial({ color: '#1b2030', roughness: 0.55, metalness: 0.2 }),
    );
    desk.position.set(0, DESK_Y - 0.02, DESK_Z);
    desk.receiveShadow = true;
    this.world.createTransformEntity(desk);

    const edge = new Mesh(
      new BoxGeometry(1.5, 0.006, 0.012),
      new MeshBasicMaterial({ color: '#5fd4ff' }),
    );
    edge.position.set(0, DESK_Y + 0.001, DESK_Z + 0.31);
    this.world.createTransformEntity(edge);

    this.forgeRing = new Mesh(
      new TorusGeometry(0.11, 0.008, 12, 48),
      new MeshBasicMaterial({ color: '#ffd166' }),
    );
    this.forgeRing.rotation.x = Math.PI / 2;
    this.forgeRing.position.copy(FORGE);
    this.world.createTransformEntity(this.forgeRing);

    const forgeLabel = makeLabel(0.2, 0.05, 1400, 'rgba(40,30,0,0.85)');
    forgeLabel.draw(['FORGE'], '#ffd166');
    forgeLabel.mesh.rotation.x = -Math.PI / 2;
    forgeLabel.mesh.position.set(FORGE.x, DESK_Y + 0.003, FORGE.z + 0.16);
    this.world.createTransformEntity(forgeLabel.mesh);

    const zones: [string, number, string][] = [
      ['ROLE CORES', -0.5, '#9ad1ff'],
      ['TASK CARDS', 0.5, '#b8f2a0'],
    ];
    for (const [text, x, color] of zones) {
      const l = makeLabel(0.26, 0.05, 1400, 'rgba(10,14,24,0.9)');
      l.draw([text], color);
      l.mesh.rotation.x = -Math.PI / 2;
      l.mesh.position.set(x, DESK_Y + 0.003, DESK_Z + 0.27);
      this.world.createTransformEntity(l.mesh);
    }
  }

  private buildBoard() {
    this.board = makeLabel(1.1, 0.3, 900);
    this.board.mesh.position.set(0, 1.78, -1.45);
    this.world.createTransformEntity(this.board.mesh);
  }

  private buildCores() {
    ROLES.forEach((role, i) => {
      const g = new Group();
      const orb = new Mesh(
        new SphereGeometry(0.035, 24, 16),
        new MeshStandardMaterial({ color: role.color, emissive: role.color, emissiveIntensity: 0.6 }),
      );
      g.add(orb);
      const tag = makeLabel(0.12, 0.04, 1600, 'rgba(0,0,0,0.75)');
      tag.draw([role.title], role.color);
      tag.mesh.position.set(0, 0.065, 0);
      tag.mesh.rotation.x = -0.5;
      g.add(tag.mesh);
      const home = new Vector3(-0.5 + (i % 2) * 0.13, DESK_Y + 0.05, -0.42 - Math.floor(i / 2) * 0.14);
      g.position.copy(home);
      const e = this.world.createTransformEntity(g);
      e.addComponent(OneHandGrabbable, { rotate: false });
      e.addComponent(CoreTag);
      this.coreHome.set(e, { role: role.id, home });
    });
  }

  private buildCards() {
    TASKS.forEach((task, i) => {
      const g = new Group();
      const slab = new Mesh(
        new BoxGeometry(0.16, 0.006, 0.1),
        new MeshStandardMaterial({ color: '#2b3a2a', emissive: '#7bd389', emissiveIntensity: 0.15 }),
      );
      g.add(slab);
      const face = makeLabel(0.15, 0.09, 1600, 'rgba(10,20,12,0.95)');
      face.draw([task.title, task.blurb], '#b8f2a0');
      face.mesh.rotation.x = -Math.PI / 2;
      face.mesh.position.y = 0.004;
      g.add(face.mesh);
      const home = new Vector3(0.34 + (i % 2) * 0.18, DESK_Y + 0.01, -0.42 - Math.floor(i / 2) * 0.13);
      g.position.copy(home);
      g.rotation.x = 0.35; // tilt toward the user
      const e = this.world.createTransformEntity(g);
      e.addComponent(OneHandGrabbable, { rotate: false });
      e.addComponent(CardTag);
      this.cardHome.set(e, { task: i, home });
    });
  }

  private makeButton(kind: 'approve' | 'reject' | 'reset', color: string, text: string, size = 0.07) {
    const g = new Group();
    const base = new Mesh(
      new CylinderGeometry(size, size, 0.025, 32),
      new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5 }),
    );
    g.add(base);
    const l = makeLabel(size * 1.8, size * 0.6, 1600, 'rgba(0,0,0,0)');
    l.draw([text], '#ffffff');
    l.mesh.rotation.x = -Math.PI / 2;
    l.mesh.position.y = 0.014;
    g.add(l.mesh);
    const e = this.world.createTransformEntity(g);
    e.addComponent(RayInteractable);
    e.addComponent(PokeInteractable);
    e.addComponent(ButtonTag);
    this.buttons.set(e, { kind, root: g });
    return { e, g };
  }

  private buildApproval() {
    this.approvalRoot = new Group();
    this.approvalRoot.position.set(0, DESK_Y + 0.015, -0.4);
    this.world.createTransformEntity(this.approvalRoot);
    const ok = this.makeButton('approve', '#2ecc71', 'APPROVE');
    ok.g.position.set(-0.11, DESK_Y + 0.015, -0.4);
    const no = this.makeButton('reject', '#e74c3c', 'REVISE');
    no.g.position.set(0.11, DESK_Y + 0.015, -0.4);
    this.setApprovalVisible(false);
    const reset = this.makeButton('reset', '#555c70', 'NEW CREW', 0.035);
    reset.g.position.set(-0.66, DESK_Y + 0.015, -0.36);
  }

  private setApprovalVisible(v: boolean) {
    for (const [, b] of this.buttons) {
      if (b.kind !== 'reset') b.root.visible = v;
    }
  }

  // ------------------------------------------------------------ agents
  private spawnAgent(role: RoleId, pos: Vector3, name?: string, xp = 0, id?: number, quiet = false): AgentData {
    const def = ROLES.find((r) => r.id === role)!;
    const root = new Group();
    const body = new Mesh(
      new SphereGeometry(0.075, 32, 24),
      new MeshStandardMaterial({ color: def.color, emissive: def.color, emissiveIntensity: 0.25, roughness: 0.35 }),
    );
    root.add(body);
    // eyes — a face makes it a character, not a widget
    for (const x of [-0.02, 0.02]) {
      const eye = new Mesh(new SphereGeometry(0.012, 12, 8), new MeshBasicMaterial({ color: '#0b0d12' }));
      eye.position.set(x * 1.25, 0.015, 0.068);
      body.add(eye);
    }
    const halo = new Mesh(
      new TorusGeometry(0.095, 0.005, 8, 40),
      new MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.5 }),
    );
    halo.rotation.x = Math.PI / 2;
    halo.position.y = -0.08;
    root.add(halo);
    const flag = new Mesh(new BoxGeometry(0.035, 0.022, 0.002), new MeshBasicMaterial({ color: '#ffb020' }));
    flag.position.set(0.05, 0.1, 0);
    flag.visible = false;
    root.add(flag);
    const bubble = makeLabel(0.42, 0.17, 1000);
    bubble.mesh.position.set(0, 0.2, 0);
    root.add(bubble.mesh);
    root.position.copy(pos);
    const entity = this.world.createTransformEntity(root);
    entity.addComponent(OneHandGrabbable, { rotate: false });
    entity.addComponent(AgentTag);
    const agent: AgentData = {
      id: id ?? this.nextId++,
      role,
      name: name ?? def.names[Math.floor(Math.random() * def.names.length)],
      xp,
      entity,
      root,
      body,
      halo,
      flag,
      bubble,
      bubbleText: [],
      thinking: false,
      waiting: false,
      bornAt: this.elapsed,
    };
    if (id && id >= this.nextId) this.nextId = id + 1;
    this.agents.push(agent);
    this.agentByEntity.set(entity, agent);
    this.applyLevel(agent);
    this.say(agent, [`${def.title} ${agent.name} · Lv ${this.level(agent)}`, quiet ? def.idle : def.greeting], def.color);
    return agent;
  }

  private level(a: AgentData) {
    return 1 + Math.floor(a.xp / 2);
  }

  private applyLevel(a: AgentData) {
    // agents physically grow with experience — visible progress between sessions
    const s = 1 + Math.min(0.6, (this.level(a) - 1) * 0.12);
    a.body.scale.setScalar(s);
  }

  private say(a: AgentData, lines: string[], accent?: string) {
    const def = ROLES.find((r) => r.id === a.role)!;
    a.bubbleText = lines;
    a.bubble.draw(lines, accent ?? def.color, PORTRAITS[a.role]);
    a.bubble.mesh.visible = true;
  }

  private nextSlot(): Vector3 {
    // an arc behind the desk, inside a comfortable narrow FoV
    const n = this.agents.length;
    const angles = [0, -18, 18, -34, 34, -48, 48, -9, 9, -26, 26];
    const deg = angles[n % angles.length];
    const r = 0.7;
    const rad = (deg * Math.PI) / 180;
    return new Vector3(Math.sin(rad) * r, 1.04 + (n >= 7 ? 0.18 : 0), -Math.cos(rad) * r);
  }

  private teamOf(a: AgentData): AgentData[] {
    const seen = new Set<AgentData>([a]);
    const stack = [a];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const l of this.links) {
        const other = l.a === cur ? l.b : l.b === cur ? l.a : null;
        if (other && !seen.has(other)) {
          seen.add(other);
          stack.push(other);
        }
      }
    }
    const order = ROLES.map((r) => r.id);
    return [...seen].sort((x, y) => order.indexOf(x.role) - order.indexOf(y.role) || x.id - y.id);
  }

  private link(a: AgentData, b: AgentData, quiet = false) {
    if (a === b || this.links.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a))) return;
    const line = new Mesh(
      new CylinderGeometry(0.006, 0.006, 1, 10, 1, true),
      new MeshBasicMaterial({ color: '#ffd166', transparent: true, opacity: 0.9 }),
    );
    line.frustumCulled = false;
    this.world.createTransformEntity(line);
    this.links.push({ a, b, line });
    if (!quiet) {
      chord([523, 659, 784]);
      const team = this.teamOf(a);
      this.say(a, [`Teamed with ${b.name}!`, `Crew of ${team.length}: ${team.map((t) => t.name).join(' → ')}`]);
      this.say(b, [`Hi ${a.name}!`, 'Hand us a task card.']);
    }
  }

  // ------------------------------------------------------------ release handlers
  private onCoreReleased(e: Entity) {
    const info = this.coreHome.get(e);
    if (!info || !e.object3D) return;
    const p = e.object3D.position;
    const d = Math.hypot(p.x - FORGE.x, p.z - FORGE.z);
    if (d < 0.2 && p.y < FORGE.y + 0.35) {
      const agent = this.spawnAgent(info.role, this.nextSlot());
      chord([392, 523, 659]);
      this.flash(agent);
      this.save();
      this.refreshBoard();
    } else {
      beep(220, 0.08);
    }
    p.copy(info.home);
  }

  private onAgentReleased(e: Entity) {
    const a = this.agentByEntity.get(e);
    if (!a) return;
    a.root.getWorldPosition(this.tmp);
    let best: AgentData | null = null;
    let bestD = 0.32;
    for (const o of this.agents) {
      if (o === a) continue;
      o.root.getWorldPosition(this.tmp2);
      const d = this.tmp.distanceTo(this.tmp2);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    if (best) {
      this.link(a, best);
      // nudge apart so both stay readable
      this.tmp2.subVectors(this.tmp, best.root.position).setY(0);
      if (this.tmp2.lengthSq() < 1e-6) this.tmp2.set(1, 0, 0);
      this.tmp2.normalize().multiplyScalar(0.3);
      a.root.position.copy(best.root.position).add(this.tmp2);
    }
    this.save();
    this.refreshBoard();
  }

  private onCardReleased(e: Entity) {
    const info = this.cardHome.get(e);
    if (!info || !e.object3D) return;
    e.object3D.getWorldPosition(this.tmp);
    let target: AgentData | null = null;
    let bestD = 0.4;
    for (const a of this.agents) {
      a.root.getWorldPosition(this.tmp2);
      const d = this.tmp.distanceTo(this.tmp2);
      if (d < bestD) {
        bestD = d;
        target = a;
      }
    }
    e.object3D.position.copy(info.home);
    if (target && !this.run) this.startRun(info.task, target);
    else if (this.run) beep(200, 0.1);
  }

  private onButton(e: Entity) {
    const b = this.buttons.get(e);
    if (!b) return;
    if (b.kind === 'reset') {
      if (this.run) return;
      this.clearCrew();
      return;
    }
    if (!this.run || this.run.phase !== 'approve') return;
    const agent = this.run.queue[this.run.step];
    const res = this.run.pending!;
    if (b.kind === 'approve') {
      chord([659, 784]);
      this.run.transcript.push(`${agent.name}: ${res.approvedLine ?? res.line}`);
      this.say(agent, [`${agent.name} · approved`, res.approvedLine ?? res.line]);
    } else {
      beep(330, 0.15, 'square', 0.04);
      this.run.transcript.push(`${agent.name}: ${res.revisedLine ?? res.line}`);
      this.say(agent, [`${agent.name} · revised`, res.revisedLine ?? res.line]);
    }
    agent.waiting = false;
    agent.flag.visible = false;
    this.setApprovalVisible(false);
    this.run.phase = 'handoff';
    this.run.timer = 0;
  }

  // ------------------------------------------------------------ runs
  private startRun(taskIndex: number, target: AgentData) {
    const queue = this.teamOf(target);
    const pulse = new Mesh(new SphereGeometry(0.015, 12, 8), new MeshBasicMaterial({ color: '#ffffff' }));
    pulse.visible = false;
    this.world.createTransformEntity(pulse);
    this.run = { taskIndex, queue, step: 0, phase: 'think', timer: 0, transcript: [], pulse };
    chord([440, 554, 659, 880]);
    this.refreshBoard();
  }

  private tickRun(dt: number) {
    const run = this.run;
    if (!run) return;
    run.timer += dt;
    const agent = run.queue[run.step];
    const task = TASKS[run.taskIndex];
    switch (run.phase) {
      case 'think':
        agent.thinking = true;
        if (run.timer < 0.05) this.say(agent, [`${agent.name} is thinking…`, task.title]);
        if (run.timer > 1.6) {
          agent.thinking = false;
          const prev = run.transcript.length ? run.transcript[run.transcript.length - 1] : null;
          run.pending = runStep(agent.role, run.taskIndex, run.step, prev);
          run.phase = 'speak';
          run.timer = 0;
          if (run.pending.needsApproval) {
            this.say(agent, [`${agent.name} needs you`, run.pending.line], '#ffb020');
            agent.waiting = true;
            agent.flag.visible = true;
            this.setApprovalVisible(true);
            run.phase = 'approve';
            chord([880, 660]);
          } else {
            this.say(agent, [`${agent.name}`, run.pending.line]);
            run.transcript.push(`${agent.name}: ${run.pending.line}`);
            beep(700, 0.08);
          }
          this.refreshBoard();
        }
        break;
      case 'speak':
        if (run.timer > 2.2) {
          run.phase = 'handoff';
          run.timer = 0;
        }
        break;
      case 'approve':
        break; // waits for a button press
      case 'handoff': {
        const next = run.queue[run.step + 1];
        if (!next) {
          this.finishRun();
          return;
        }
        run.pulse.visible = true;
        const t = Math.min(1, run.timer / 0.7);
        agent.root.getWorldPosition(this.tmp);
        next.root.getWorldPosition(this.tmp2);
        run.pulse.position.lerpVectors(this.tmp, this.tmp2, t);
        run.pulse.position.y += Math.sin(t * Math.PI) * 0.06;
        if (t >= 1) {
          run.pulse.visible = false;
          run.step++;
          run.phase = 'think';
          run.timer = 0;
          beep(560, 0.05);
        }
        break;
      }
    }
  }

  private finishRun() {
    const run = this.run!;
    const task = TASKS[run.taskIndex];
    run.pulse.visible = false;
    for (const a of run.queue) {
      a.xp += 1;
      this.applyLevel(a);
      this.flash(a);
    }
    const summary = run.transcript.map((l) => l.split(': ').slice(1).join(': ')).join(' ');
    this.shelf.unshift({ task: task.title, summary });
    this.shelf = this.shelf.slice(0, 4);
    this.runs++;
    this.run = null;
    chord([523, 659, 784, 1046]);
    this.renderShelf();
    this.save();
    this.refreshBoard(`Done: "${task.title}" by a crew of ${run.queue.length}. Result is on your shelf →`);
  }

  private flash(a: AgentData) {
    const m = a.body.material as MeshStandardMaterial;
    m.emissiveIntensity = 1.4;
  }

  // ------------------------------------------------------------ shelf + board
  private renderShelf() {
    for (const l of this.shelfLabels) l.mesh.removeFromParent();
    this.shelfLabels = [];
    this.shelf.forEach((item, i) => {
      const l = makeLabel(0.34, 0.16, 1000, 'rgba(18,24,18,0.92)');
      l.draw([`✓ ${item.task}`, item.summary], '#b8f2a0');
      l.mesh.position.set(0.82, 1.3 - i * 0.18, -0.95);
      l.mesh.rotation.y = -0.6;
      this.world.createTransformEntity(l.mesh);
      this.shelfLabels.push(l);
    });
  }

  private refreshBoard(override?: string) {
    const n = this.agents.length;
    const teams = new Set(this.agents.map((a) => this.teamOf(a)[0])).size;
    let step: string;
    if (override) step = override;
    else if (this.run) {
      const a = this.run.queue[this.run.step];
      step =
        this.run.phase === 'approve'
          ? `${a.name} is waiting for you — press APPROVE or REVISE on the desk.`
          : `Running "${TASKS[this.run.taskIndex].title}" — step ${this.run.step + 1}/${this.run.queue.length}, ${a.name} has the baton.`;
    } else if (n === 0) step = 'Pinch a glowing role core (left) and drop it on the gold FORGE ring.';
    else if (this.runs === 0) step = 'Now pinch a task card (right) and drop it onto your agent.';
    else if (this.links.length === 0)
      step = 'Forge a second agent, then pinch one and touch it to the other to form a crew.';
    else step = 'Hand your crew a harder task. Agents level up and grow with every job.';
    this.board.draw(
      [`AGENT ATELIER  ·  ${n} agent${n === 1 ? '' : 's'}  ·  ${teams} crew${teams === 1 ? '' : 's'}  ·  ${this.runs} job${this.runs === 1 ? '' : 's'} done`, step],
      this.run?.phase === 'approve' ? '#ffb020' : '#7cf',
    );
  }

  // ------------------------------------------------------------ persistence
  private save() {
    const data: SavedCrew = {
      agents: this.agents.map((a) => ({
        id: a.id,
        role: a.role,
        name: a.name,
        xp: a.xp,
        pos: [a.root.position.x, a.root.position.y, a.root.position.z],
      })),
      links: this.links.map((l) => [l.a.id, l.b.id]),
      shelf: this.shelf,
      runs: this.runs,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* private mode: crew just won't persist */
    }
  }

  private restore() {
    let data: SavedCrew | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      data = raw ? (JSON.parse(raw) as SavedCrew) : null;
    } catch {
      data = null;
    }
    if (!data || !Array.isArray(data.agents)) return;
    const byId = new Map<number, AgentData>();
    for (const a of data.agents) {
      if (!ROLES.some((r) => r.id === a.role)) continue;
      byId.set(a.id, this.spawnAgent(a.role, new Vector3(...a.pos), a.name, a.xp, a.id, true));
    }
    for (const [x, y] of data.links ?? []) {
      const a = byId.get(x);
      const b = byId.get(y);
      if (a && b) this.link(a, b, true);
    }
    this.shelf = data.shelf ?? [];
    this.runs = data.runs ?? 0;
    this.welcomeBack = this.agents.length > 0;
    this.renderShelf();
  }

  private clearCrew() {
    for (const l of this.links) l.line.removeFromParent();
    for (const a of this.agents) {
      this.agentByEntity.delete(a.entity);
      a.entity.dispose();
    }
    this.links = [];
    this.agents = [];
    this.shelf = [];
    this.runs = 0;
    this.renderShelf();
    this.save();
    beep(180, 0.2, 'sawtooth', 0.04);
    this.refreshBoard();
  }

  // ------------------------------------------------------------ frame loop
  update(delta: number): void {
    this.elapsed += delta;
    const t = this.elapsed;
    this.player.head.getWorldPosition(this.headPos);

    this.forgeRing.rotation.z += delta * 0.8;
    (this.forgeRing.material as MeshBasicMaterial).color.setHSL(0.12, 1, 0.55 + Math.sin(t * 3) * 0.1);

    for (const a of this.agents) {
      // idle bob + thinking wobble
      const bob = Math.sin(t * 2 + a.id) * 0.004 + (a.thinking ? Math.sin(t * 18) * 0.004 : 0);
      a.body.position.y = bob;
      a.halo.rotation.z += delta * (a.thinking ? 6 : 0.6);
      (a.halo.material as MeshBasicMaterial).opacity = a.thinking ? 0.95 : 0.45;
      a.flag.rotation.z = a.waiting ? Math.sin(t * 10) * 0.4 : 0;
      const m = a.body.material as MeshStandardMaterial;
      m.emissiveIntensity += ((a.thinking ? 0.9 : 0.25) - m.emissiveIntensity) * Math.min(1, delta * 3);
      // face the user
      a.root.getWorldPosition(this.tmp);
      this.tmp2.set(this.headPos.x, this.tmp.y, this.headPos.z);
      a.body.lookAt(this.tmp2);
      a.bubble.mesh.lookAt(this.headPos);
    }
    for (const l of this.links) {
      l.a.root.getWorldPosition(this.tmp);
      l.b.root.getWorldPosition(this.tmp2);
      this.tmp.y -= 0.07;
      this.tmp2.y -= 0.07;
      l.line.position.addVectors(this.tmp, this.tmp2).multiplyScalar(0.5);
      this.tmp2.sub(this.tmp);
      const len = this.tmp2.length();
      l.line.scale.set(1, Math.max(len, 0.001), 1);
      l.line.quaternion.setFromUnitVectors(this.up, this.tmp2.normalize());
      const active = this.run && this.run.queue.includes(l.a) && this.run.queue.includes(l.b);
      const mat = l.line.material as MeshBasicMaterial;
      if (active) mat.color.setHSL((t * 0.5) % 1, 0.8, 0.6);
      else mat.color.set(0xffd166);
    }
    this.board.mesh.lookAt(this.headPos);

    const prevPhase = this.run?.phase;
    const prevStep = this.run?.step;
    this.tickRun(delta);
    if (this.run && (this.run.phase !== prevPhase || this.run.step !== prevStep)) this.refreshBoard();
  }
}
