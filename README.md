# Agent Atelier

**Build your AI crew by hand.** A seated, hands-first WebXR experience for Meta Quest: forge AI agents from role cores, touch them together to form a crew, hand them task cards, and approve their risky steps with a press, all without a controller.

Built for the Meta VR Start Developer Competition 2026 (Productivity track, New Experience).

## Try it
Open the live link in the Meta Quest Browser and press **Enter VR**. Hands only.

1. Pinch a glowing **role core** (left of the desk) and drop it on the gold **FORGE** ring. An agent appears.
2. Pinch a **task card** (right) and drop it onto your agent. Watch it work.
3. Forge a second agent, pinch it and **touch it to the first** to form a crew.
4. When an agent raises its flag, press **APPROVE** or **REVISE** on the desk.
5. Come back later: your crew, their levels and finished work are saved.

## How it works
- [IWSDK](https://iwsdk.dev) 1.1 (Meta's Immersive Web SDK), Three.js, TypeScript, Vite
- Hand tracking: `OneHandGrabbable` pinch-grab for cores, cards and agents; poke/ray-pinch buttons
- `src/agent-engine.ts`: a local, deterministic agent engine (Scout → Builder → Scribe → Critic). No third-party AI service or API key; works offline.
- `src/handcrew.ts`: desk scene, forging, teaming, task runs, human-in-the-loop approvals, persistence (localStorage)
- Character portraits generated with Runware

## Run locally
```bash
npm ci
npm run dev      # IWSDK dev server + emulator (IWER)
npm run build    # static site in dist/
```
